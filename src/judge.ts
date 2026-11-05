// Judge mode. A pool of real sandbox disputes, opened ahead of time by the sandbox buyer (tools/pool.py), one handed
// to each judge so they can run the whole loop on a live dispute. When the pool is used up, the judge gets a
// recorded run, labelled as a replay.

export type CaseKind = "fight" | "accept" | "ship";

export const POOL_LOW_AT = 2;

export function lowKinds(counts: { kind: string; total: number; free: number }[]): string[] {
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
}

export interface Assignment {
  disputeId: string | null;
  replay: boolean;
  fresh: boolean; // handed out just now (false when the judge already had it)
}

export function assign(pool: PoolRow[], visitor: string, kind: CaseKind): Assignment {
  const mine = pool.find((r) => r.kind === kind && r.handed_to === visitor);
  if (mine) return { disputeId: mine.dispute_id, replay: false, fresh: false };
  const free = pool.filter((r) => r.kind === kind && !r.handed_to).sort((a, b) => a.position - b.position)[0];
  if (free) return { disputeId: free.dispute_id, replay: false, fresh: true };
  return { disputeId: null, replay: true, fresh: false };
}

export async function nextForJudge(db: D1Database, visitor: string, kind: CaseKind): Promise<Assignment> {
  const pool = (await db.prepare("SELECT * FROM pool WHERE kind = ?").bind(kind).all<PoolRow>()).results;
  const a = assign(pool, visitor, kind);
  if (a.fresh && a.disputeId) {
    // Only one judge can take a row: the WHERE clause refuses a row someone took a moment ago.
    const r = await db
      .prepare("UPDATE pool SET handed_to = ?, handed_at = ? WHERE dispute_id = ? AND handed_to IS NULL")
      .bind(visitor, new Date().toISOString(), a.disputeId)
      .run();
    if ((r.meta.changes ?? 0) === 0) return nextForJudge(db, visitor, kind);
    if (kind === "fight" || kind === "accept") {
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
    }
  }
  return a;
}

export async function poolCounts(db: D1Database) {
  const r = await db
    .prepare(
      "SELECT kind, COUNT(*) AS total, SUM(CASE WHEN handed_to IS NULL THEN 1 ELSE 0 END) AS free FROM pool GROUP BY kind",
    )
    .all<{ kind: string; total: number; free: number }>();
  return r.results;
}
