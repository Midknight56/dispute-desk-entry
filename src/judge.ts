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
}

export interface Assignment {
  disputeId: string | null;
  replay: boolean;
  fresh: boolean; // handed out just now (false when the judge already had it)
  why?: string;
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
  if (dispute?.seller_response_due_date) {
    const due = new Date(dispute.seller_response_due_date).getTime();
    if (!isNaN(due) && due - nowMs <= 24 * 60 * 60 * 1000) {
      return { ok: false, retire: true, why: "deadline passed" };
    }
  }
  const links = new Set<string>((dispute?.links ?? []).map((l: any) => l?.rel));
  if (kind === "fight") {
    if (!links.has("provide_evidence") && !links.has("make_offer")) {
      return { ok: false, retire: true, why: "no evidence or offer action" };
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

async function hasRetiredColumn(db: D1Database): Promise<boolean> {
  try {
    const info = await db.prepare("PRAGMA table_info(pool)").all<{ name: string }>();
    return info.results.some((col) => col.name === "retired_at");
  } catch {
    return false;
  }
}

export async function nextForJudge(
  db: D1Database,
  visitor: string,
  kind: CaseKind,
  check?: DisputeCheck,
): Promise<Assignment> {
  const withRetired = await hasRetiredColumn(db);
  for (let attempt = 0; attempt < 10; attempt++) {
    const pool = (await db.prepare("SELECT * FROM pool WHERE kind = ?").bind(kind).all<PoolRow>()).results;
    const a = assign(pool, visitor, kind);
    if (!a.fresh || !a.disputeId) {
      return a;
    }
    const claimSql = withRetired
      ? "UPDATE pool SET handed_to = ?, handed_at = ? WHERE dispute_id = ? AND handed_to IS NULL AND retired_at IS NULL"
      : "UPDATE pool SET handed_to = ?, handed_at = ? WHERE dispute_id = ? AND handed_to IS NULL";
    const r = await db
      .prepare(claimSql)
      .bind(visitor, new Date().toISOString(), a.disputeId)
      .run();
    if ((r.meta.changes ?? 0) === 0) {
      continue;
    }
    let checkResult: CheckResult = { ok: true };
    if (kind !== "ship" && check) {
      try {
        checkResult = await check(a.disputeId);
      } catch (e) {
        checkResult = { ok: false, retire: false, why: String(e) };
      }
    }
    if (checkResult.ok) {
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
      return a;
    }
    if (checkResult.retire) {
      if (withRetired) {
        await db
          .prepare("UPDATE pool SET retired_at = ?, retired_why = ? WHERE dispute_id = ?")
          .bind(new Date().toISOString(), checkResult.why, a.disputeId)
          .run();
      }
      continue;
    }
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
}

export async function poolCounts(db: D1Database): Promise<PoolCount[]> {
  const withRetired = await hasRetiredColumn(db);
  const sql = withRetired
    ? "SELECT kind, COUNT(*) AS total, COALESCE(SUM(CASE WHEN handed_to IS NULL AND retired_at IS NULL THEN 1 ELSE 0 END), 0) AS free, COALESCE(SUM(CASE WHEN retired_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS retired FROM pool GROUP BY kind"
    : "SELECT kind, COUNT(*) AS total, COALESCE(SUM(CASE WHEN handed_to IS NULL THEN 1 ELSE 0 END), 0) AS free, 0 AS retired FROM pool GROUP BY kind";
  const r = await db.prepare(sql).all<PoolCount>();
  return r.results.map((row) => {
    if (row.kind === "ship") {
      const { retired, ...rest } = row;
      return rest;
    }
    return row;
  });
}
