// D1 state for the desk. D1, not KV: the Free plan allows 1,000 KV writes a day for the whole account,
// and five hackathon apps share it.
import type { Sale } from "./ship";
import type { PayPalEvent } from "./webhooks";

export interface FeedRow {
  seq?: number;
  at: string;
  kind: "webhook" | "call" | "agent" | "note";
  title: string;
  ref?: string | null;
  detail?: string | null;
}

export function store(db: D1Database) {
  const now = () => new Date().toISOString();
  return {
    async storeEventIfNew(ev: PayPalEvent, raw: string): Promise<boolean> {
      const resourceId = String(ev.resource?.["dispute_id"] ?? ev.resource?.["id"] ?? "");
      const r = await db
        .prepare(
          "INSERT OR IGNORE INTO events (id, event_type, resource_id, create_time, received_at, raw) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(ev.id, ev.event_type, resourceId || null, ev.create_time ?? null, now(), raw)
        .run();
      if ((r.meta.changes ?? 0) > 0) return true;
      return !!(await db.prepare("SELECT id FROM events WHERE id = ? AND processed_at IS NULL").bind(ev.id).first());
    },

    async markEventProcessed(id: string) {
      await db.prepare("UPDATE events SET processed_at = ? WHERE id = ?").bind(now(), id).run();
    },

    async pendingEvents() {
      const r = await db
        .prepare(
          `SELECT id, raw FROM events WHERE processed_at IS NULL AND received_at < ?
         AND (claimed_at IS NULL OR claimed_at < ?) ORDER BY received_at, id LIMIT 5`,
        )
        .bind(new Date(Date.now() - 120_000).toISOString(), new Date(Date.now() - 600_000).toISOString())
        .all<{ id: string; raw: string }>();
      return r.results;
    },

    async claimEvent(id: string) {
      const r = await db
        .prepare(
          `UPDATE events SET claimed_at = ? WHERE id = ? AND processed_at IS NULL
         AND (claimed_at IS NULL OR claimed_at < ?)`,
        )
        .bind(now(), id, new Date(Date.now() - 600_000).toISOString())
        .run();
      return (r.meta.changes ?? 0) > 0;
    },

    async releaseEvent(id: string) {
      await db.prepare("UPDATE events SET claimed_at = NULL WHERE id = ? AND processed_at IS NULL").bind(id).run();
    },

    async feed(row: Omit<FeedRow, "at"> & { at?: string }) {
      await db
        .prepare("INSERT INTO feed (at, kind, title, ref, detail) VALUES (?, ?, ?, ?, ?)")
        .bind(row.at ?? now(), row.kind, row.title, row.ref ?? null, row.detail ?? null)
        .run();
    },

    async listSales() {
      const r = await db
        .prepare(
          `SELECT s.capture_id, s.order_id, s.custom_id, s.amount, s.currency, s.captured_at,
           h.carrier, h.tracking_number, h.tracker_id
         FROM sales s JOIN shipments h ON h.custom_id = s.custom_id
         WHERE NOT EXISTS (SELECT 1 FROM disputes d WHERE d.custom_id = s.custom_id)
         ORDER BY s.captured_at DESC`,
        )
        .all<Sale>();
      return r.results;
    },

    async recentFeed(limit = 100): Promise<FeedRow[]> {
      const r = await db.prepare("SELECT * FROM feed ORDER BY seq DESC LIMIT ?").bind(limit).all<FeedRow>();
      return r.results;
    },

    async putDispute(d: {
      id: string;
      status?: string;
      stage?: string;
      reason?: string;
      amount?: string;
      currency?: string;
      due?: string | null;
      customId?: string;
      data: unknown;
    }) {
      const result = await db
        .prepare(
          `INSERT INTO disputes (id, status, stage, reason, amount, currency, due, custom_id, data, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET status = excluded.status, stage = excluded.stage, reason = excluded.reason,
             amount = excluded.amount, currency = excluded.currency, due = excluded.due, custom_id = excluded.custom_id,
             data = CASE WHEN json_type(excluded.data, '$.run') IS NOT NULL
               THEN json_set(json_patch(disputes.data, excluded.data), '$.run', json_extract(excluded.data, '$.run'))
               ELSE json_patch(disputes.data, excluded.data) END, updated_at = excluded.updated_at
           WHERE json_type(excluded.data, '$.run') IS NULL OR (
             COALESCE(json_extract(disputes.data, '$.operation.state'), '') NOT IN ('sending', 'uncertain')
             AND COALESCE(json_extract(disputes.data, '$.filing'), 0) < ?
           )`,
        )
        .bind(
          d.id,
          d.status ?? null,
          d.stage ?? null,
          d.reason ?? null,
          d.amount ?? null,
          d.currency ?? null,
          d.due ?? null,
          d.customId ?? null,
          JSON.stringify(d.data),
          now(),
          Date.now() - 120_000,
        )
        .run();
      return (result.meta.changes ?? 0) > 0;
    },

    // Merges fields into the stored JSON record (SQLite json_patch), leaving the rest alone.
    async mergeData(id: string, patch: Record<string, unknown>) {
      await db
        .prepare("UPDATE disputes SET data = json_patch(data, ?), updated_at = ? WHERE id = ?")
        .bind(JSON.stringify(patch), now(), id)
        .run();
    },

    async getDispute(id: string) {
      const r = await db.prepare("SELECT * FROM disputes WHERE id = ?").bind(id).first<Record<string, string>>();
      return r ? { ...r, data: JSON.parse(r.data) } : null;
    },

    // The list with what the evidence readiness widget needs: the verdict, the record kinds held, filed or not.
    async listDisputes() {
      const r = await db
        .prepare(
          `SELECT id, status, stage, reason, amount, currency, due, custom_id, updated_at,
             json_extract(data, '$.run.decision.verdict') AS verdict,
             json_extract(data, '$.run.records') AS records,
             json_extract(data, '$.filed.at') AS filed_at,
             json_extract(data, '$.dispute.create_time') AS created
           FROM disputes ORDER BY updated_at DESC`,
        )
        .all<Record<string, any>>();
      return r.results.map(({ records, ...row }) => {
        let kinds: string[] = [];
        const amount = row.amount == null ? undefined : Number(row.amount);
        if (row.amount != null && (!Number.isFinite(amount) || amount! < 0)) row.amount = "0.00";
        try {
          kinds = [...new Set((JSON.parse(records ?? "[]") as { kind: string }[]).map((x) => x.kind))];
        } catch {
          // no run yet
        }
        return { ...row, kinds };
      });
    },
  };
}
