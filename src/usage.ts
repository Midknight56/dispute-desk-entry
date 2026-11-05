// Counting for the caps: runs in this app's D1, neurons in the account wide ledger shared by the hackathon apps.
import type { CapUsage } from "./caps";
import {
  MAX_RUNS_PER_DAY,
  MAX_RUNS_PER_VISITOR_PER_DAY,
  APP_NEURONS_PER_DAY,
  ACCOUNT_NEURONS_PER_DAY,
  NEURONS_PER_RUN_MAX,
  NEURONS_PER_ASK_MAX,
} from "./caps";

export const APP = "dispute-desk";

// Workers AI's free day resets at 00:00 UTC, so the caps count UTC days.
export function utcDay(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

// Usage caps hash the address and browser, independently of case ownership sessions.
export async function visitorId(req: Request): Promise<string> {
  const ip = req.headers.get("cf-connecting-ip") ?? "local";
  const ua = req.headers.get("user-agent") ?? "";
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${ip}|${ua}`)));
  return [...bytes.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function readUsage(db: D1Database, ledger: D1Database, visitor: string, day: string): Promise<CapUsage> {
  const [v, d, app, all] = await Promise.all([
    db
      .prepare("SELECT COUNT(*) AS n FROM runs WHERE day = ? AND visitor = ?")
      .bind(day, visitor)
      .first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM runs WHERE day = ?").bind(day).first<{ n: number }>(),
    ledger
      .prepare("SELECT COALESCE(SUM(neurons), 0) AS n FROM ai_calls WHERE day = ? AND app = ?")
      .bind(day, APP)
      .first<{ n: number }>(),
    ledger
      .prepare("SELECT COALESCE(SUM(neurons), 0) AS n FROM ai_calls WHERE day = ?")
      .bind(day)
      .first<{ n: number }>(),
  ]);
  return { visitorRuns: v?.n ?? 0, dayRuns: d?.n ?? 0, appNeurons: app?.n ?? 0, accountNeurons: all?.n ?? 0 };
}

export async function reserveRun(db: D1Database, r: { day: string; visitor: string; disputeId: string }) {
  const at = `${new Date().toISOString()}-${crypto.randomUUID()}`;
  const result = await db
    .prepare(
      "INSERT INTO runs (day, visitor, dispute_id, writer, neurons, at) " +
        "SELECT ?, ?, ?, 'reserved', 0, ? WHERE " +
        "(SELECT COUNT(*) FROM runs WHERE day = ? AND visitor = ?) < ? AND " +
        "(SELECT COUNT(*) FROM runs WHERE day = ?) < ?",
    )
    .bind(r.day, r.visitor, r.disputeId, at, r.day, r.visitor, MAX_RUNS_PER_VISITOR_PER_DAY, r.day, MAX_RUNS_PER_DAY)
    .run();
  return result.meta.changes ? at : null;
}

export async function finishRun(
  db: D1Database,
  ledger: D1Database,
  reservation: string,
  neuronReservationId: number | null,
  r: { day: string; writer: string; neurons: number; uncertain?: boolean },
) {
  await db
    .prepare("UPDATE runs SET writer = ?, neurons = ? WHERE at = ? AND writer = 'reserved'")
    .bind(r.writer, r.neurons, reservation)
    .run();
  if (neuronReservationId !== null && !r.uncertain)
    await ledger
      .prepare("UPDATE ai_calls SET neurons = ? WHERE id = ? AND app = ?")
      .bind(r.neurons, neuronReservationId, APP)
      .run();
}

// One conditional write reserves both budgets before the model can spend either of them.
export async function reserveNeurons(
  ledger: D1Database,
  day: string,
  route: "analyse" | "ask" = "analyse",
): Promise<number | null> {
  const maximum = route === "ask" ? NEURONS_PER_ASK_MAX : NEURONS_PER_RUN_MAX;
  const at = new Date().toISOString();
  const result = await ledger
    .prepare(
      "INSERT INTO ai_calls (app, day, neurons, at) SELECT ?, ?, ?, ? WHERE " +
        "(SELECT COALESCE(SUM(neurons),0) FROM ai_calls WHERE day = ? AND app = ?) + ? <= ? AND " +
        "(SELECT COALESCE(SUM(neurons),0) FROM ai_calls WHERE day = ?) + ? <= ?",
    )
    .bind(APP, day, maximum, at, day, APP, maximum, APP_NEURONS_PER_DAY, day, maximum, ACCOUNT_NEURONS_PER_DAY)
    .run();
  return result.meta.changes ? (result.meta.last_row_id ?? null) : null;
}

export async function recordRun(
  db: D1Database,
  _ledger: D1Database,
  r: { day: string; visitor: string; disputeId: string; writer: string; neurons: number },
) {
  const at = new Date().toISOString();
  await db
    .prepare("INSERT INTO runs (day, visitor, dispute_id, writer, neurons, at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(r.day, r.visitor, r.disputeId, r.writer, r.neurons, at)
    .run();
}
