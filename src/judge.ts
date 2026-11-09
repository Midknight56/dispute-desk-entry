// Judge mode. A pool of real sandbox disputes, opened ahead of time by the sandbox buyer (tools/pool.py), one handed
// to each judge so they can run the whole loop on a live dispute. When the pool is used up, the judge gets a
// recorded run, labelled as a replay.

export type CaseKind = "fight" | "accept" | "ship";

export const POOL_LOW_AT = 2;

export function lowKinds(counts: { kind: string; total?: number; free: number; retired?: number }[]): string[] {
  return (["fight", "accept"] as const).filter(
    (kind) => (counts.find((row) => row.kind === kind)?.free ?? 0) <= POOL_LOW_AT,
  );
}

export interface PoolRow {
  dispute_id: string; // For ship rows this holds the capture id.
  kind: CaseKind;
  position: number;
  handed_to: string | null;
  handed_at: string | null;
  retired_at?: string | null;
  retired_why?: string | null;
  checked_at?: string | null;
}

export interface Assignment {
  disputeId: string | null;
  replay: boolean;
  fresh: boolean; // handed out just now (false when the judge already had it)
  why?: string;
  replaced?: string;
}

export type CheckResult =
  | { ok: true }
  | { ok: false; retire: true; why: string }
  | { ok: false; retire: false; why: string };

export type DisputeCheck = (disputeId: string) => Promise<CheckResult> | CheckResult;

export function checkActionable(
  dispute: any,
  kind: CaseKind,
  nowMs: number = Date.now(),
): CheckResult {
  const status = String(dispute?.status ?? "").toUpperCase();
  if (status === "RESOLVED" || status === "CLOSED") {
    return { ok: false, retire: true, why: "closed" };
  }
  const due = new Date(dispute?.seller_response_due_date).getTime();
  if (!dispute?.seller_response_due_date || !Number.isFinite(due)) {
    return { ok: false, retire: true, why: "no response deadline" };
  }
  if (due - nowMs <= 24 * 60 * 60 * 1000) {
    return { ok: false, retire: true, why: "deadline passed" };
  }
  const links = new Set<string>((dispute?.links ?? []).map((l: any) => l?.rel));
  if (kind === "fight") {
    if (!links.has("provide_evidence") && !links.has("provide_supporting_info")) {
      return { ok: false, retire: true, why: "no evidence action" };
    }
  } else if (kind === "accept") {
    if (!links.has("accept_claim")) {
      return { ok: false, retire: true, why: "no accept action" };
    }
  }
  return { ok: true };
}

export function assign(pool: PoolRow[], visitor: string, kind: CaseKind): Assignment {
  const mine = pool.find((r) => r.kind === kind && r.handed_to === visitor && !r.retired_at);
  if (mine) return { disputeId: mine.dispute_id, replay: false, fresh: false };
  const free = pool.filter((r) => r.kind === kind && !r.handed_to && !r.retired_at).sort((a, b) => a.position - b.position)[0];
  if (free) return { disputeId: free.dispute_id, replay: false, fresh: true };
  return { disputeId: null, replay: true, fresh: false };
}

async function hasPoolColumn(db: D1Database, name: string): Promise<boolean> {
  try {
    const info = await db.prepare("PRAGMA table_info(pool)").all<{ name: string }>();
    return info.results.some((col) => col.name === name);
  } catch {
    return false;
  }
}

async function runCheck(check: DisputeCheck, disputeId: string): Promise<CheckResult> {
  try {
    return await check(disputeId);
  } catch (e) {
    return { ok: false, retire: false, why: String(e) };
  }
}

export async function nextForJudge(
  db: D1Database,
  visitor: string,
  kind: CaseKind,
  check?: DisputeCheck,
): Promise<Assignment> {
  const withRetired = await hasPoolColumn(db, "retired_at");
  const withChecked = await hasPoolColumn(db, "checked_at");
  let replaced: string | undefined;
  for (let attempt = 0; attempt < 10; attempt++) {
    const pool = (await db.prepare("SELECT * FROM pool WHERE kind = ?").bind(kind).all<PoolRow>()).results;
    const a = assign(pool, visitor, kind);
    if (!a.disputeId || (!a.fresh && (kind === "ship" || !check))) {
      return a;
    }
    const claimSql = withRetired
      ? "UPDATE pool SET handed_to = ?, handed_at = ? WHERE dispute_id = ? AND handed_to IS NULL AND retired_at IS NULL"
      : "UPDATE pool SET handed_to = ?, handed_at = ? WHERE dispute_id = ? AND handed_to IS NULL";
    if (a.fresh) {
      const r = await db
        .prepare(claimSql)
        .bind(visitor, new Date().toISOString(), a.disputeId)
        .run();
      if ((r.meta.changes ?? 0) === 0) {
        continue;
      }
    }
    let checkResult: CheckResult = { ok: true };
    if (kind !== "ship" && check) {
      checkResult = await runCheck(check, a.disputeId);
    }
    if (checkResult.ok) {
      if (kind !== "ship" && check && withChecked) {
        await db.prepare("UPDATE pool SET checked_at = ? WHERE dispute_id = ?")
          .bind(new Date().toISOString(), a.disputeId).run();
      }
      if (!a.fresh) return a;
      try {
        const counts = await poolCounts(db);
        if (lowKinds(counts).includes(kind)) {
          const row = counts.find((count) => count.kind === kind);
          const total = row?.total ?? 0;
          const free = row?.free ?? 0;
          console.log(`pool low: ${kind} ${free} free of ${total}`);
          await db
            .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
            .bind(`pool_low_${kind}`, `${new Date().toISOString()} ${free} free`)
            .run();
        }
      } catch (e) {
        console.log("pool check failed", String(e));
      }
      return replaced
        ? { ...a, replaced, why: "Your last case is closed. Here is a new one." }
        : a;
    }
    if (checkResult.retire) {
      if (withRetired) {
        await db
          .prepare("UPDATE pool SET retired_at = ?, retired_why = ? WHERE dispute_id = ?")
          .bind(new Date().toISOString(), checkResult.why, a.disputeId)
          .run();
        if (!a.fresh) replaced ??= a.disputeId;
      } else if (!a.fresh) {
        return a;
      }
      continue;
    }
    if (!a.fresh) return a;
    // Read failure: release claim and return replay with why
    await db
      .prepare("UPDATE pool SET handed_to = NULL, handed_at = NULL WHERE dispute_id = ? AND handed_to = ?")
      .bind(a.disputeId, visitor)
      .run();
    return {
      disputeId: null,
      replay: true,
      fresh: false,
      why: "PayPal did not answer. Here is a recorded run.",
    };
  }
  return { disputeId: null, replay: true, fresh: false };
}

export interface PoolCount {
  kind: string;
  total: number;
  free: number;
  retired?: number;
  verified?: number;
}

export async function poolCounts(db: D1Database): Promise<PoolCount[]> {
  const withRetired = await hasPoolColumn(db, "retired_at");
  const withChecked = await hasPoolColumn(db, "checked_at");
  const free = withRetired ? "handed_to IS NULL AND retired_at IS NULL" : "handed_to IS NULL";
  const retired = withRetired ? "COALESCE(SUM(CASE WHEN retired_at IS NOT NULL THEN 1 ELSE 0 END), 0)" : "0";
  const verified = withChecked
    ? `COALESCE(SUM(CASE WHEN ${free} AND julianday(checked_at) >= julianday(?) AND julianday(checked_at) <= julianday(?) THEN 1 ELSE 0 END), 0)`
    : "0";
  const statement = db.prepare(`SELECT kind, COUNT(*) AS total,
    COALESCE(SUM(CASE WHEN ${free} THEN 1 ELSE 0 END), 0) AS free,
    ${retired} AS retired, ${verified} AS verified FROM pool GROUP BY kind`);
  const now = Date.now();
  const r = await (withChecked
    ? statement.bind(new Date(now - 24 * 3600 * 1000).toISOString(), new Date(now).toISOString())
    : statement).all<PoolCount>();
  return r.results.map((row) => {
    if (row.kind === "ship") {
      const { retired, verified, ...rest } = row;
      return rest;
    }
    return row;
  });
}

export async function verifyFree(db: D1Database, kind: CaseKind, check: DisputeCheck, limit = 5) {
  const counts = { checked: 0, retired: 0, failed: 0 };
  if (kind === "ship" || limit <= 0 || !await hasPoolColumn(db, "checked_at")) return counts;
  const withRetired = await hasPoolColumn(db, "retired_at");
  const free = withRetired ? "handed_to IS NULL AND retired_at IS NULL" : "handed_to IS NULL";
  const rows = await db.prepare(`SELECT dispute_id FROM pool WHERE kind = ? AND ${free}
    AND (checked_at IS NULL OR julianday(checked_at) < julianday(?)) ORDER BY position LIMIT ?`)
    .bind(kind, new Date(Date.now() - 24 * 3600 * 1000).toISOString(), limit).all<PoolRow>();
  for (const row of rows.results) {
    const result = await runCheck(check, row.dispute_id);
    if (result.ok) {
      const updated = await db.prepare(`UPDATE pool SET checked_at = ? WHERE dispute_id = ? AND ${free}`)
        .bind(new Date().toISOString(), row.dispute_id).run();
      counts.checked += updated.meta.changes ?? 0;
    } else if (result.retire && withRetired) {
      const updated = await db.prepare(`UPDATE pool SET retired_at = ?, retired_why = ? WHERE dispute_id = ? AND ${free}`)
        .bind(new Date().toISOString(), result.why, row.dispute_id).run();
      counts.retired += updated.meta.changes ?? 0;
    } else {
      counts.failed++;
    }
  }
  return counts;
}
