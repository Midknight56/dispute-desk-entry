// "Ask in words": a seller's question becomes a small chart spec. The model only fills the spec; the fields it may
// use are a fixed list, and code computes every number from the desk's own records.
import { firstJson } from "./agent";

export interface ChartSpec {
  chart: "bar" | "pie";
  groupBy: "reason" | "status" | "stage";
  metric: "count" | "amount" | "held";
  period: "all" | "quarter" | "month";
}

const CHARTS = ["bar", "pie"] as const;
const GROUPS = ["reason", "status", "stage"] as const;
const METRICS = ["count", "amount", "held"] as const;
const PERIODS = ["all", "quarter", "month"] as const;

export const ASK_SYSTEM =
  "Turn the seller's question about their PayPal disputes into a chart spec. Reply with JSON only: " +
  '{"chart": "bar" or "pie", "groupBy": "reason" or "status" or "stage", "metric": "count" or "amount" or "held", ' +
  '"period": "all" or "quarter" or "month"}. "amount" means money in dispute. "held" means money on hold in open disputes.';

export function parseSpec(text: string): ChartSpec | undefined {
  const j = firstJson(text);
  if (!j) return undefined;
  const ok = (list: readonly string[], v: unknown) => typeof v === "string" && list.includes(v);
  if (!ok(CHARTS, j.chart) || !ok(GROUPS, j.groupBy) || !ok(METRICS, j.metric) || !ok(PERIODS, j.period))
    return undefined;
  return { chart: j.chart, groupBy: j.groupBy, metric: j.metric, period: j.period };
}

// The same job by plain word matching, for when the model is capped or answers badly.
export function keywordSpec(q: string): ChartSpec {
  const t = q.toLowerCase();
  const groupBy = /stage|claim|inquiry/.test(t) ? "stage" : /status|split|state/.test(t) ? "status" : "reason";
  const metric = /hold|held|on hold/.test(t) ? "held" : /money|amount|\$|dollar|value/.test(t) ? "amount" : "count";
  const period = /quarter/.test(t) ? "quarter" : /month/.test(t) ? "month" : "all";
  const chart = /pie|share|split/.test(t) ? "pie" : "bar";
  return { chart, groupBy, metric, period };
}

const LABELS: Record<string, Record<string, string>> = {
  reason: {
    MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "Not received",
    MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "Not as described",
    UNAUTHORISED: "Unauthorised",
  },
  status: {
    WAITING_FOR_SELLER_RESPONSE: "Your move",
    WAITING_FOR_BUYER_RESPONSE: "Buyer's move",
    UNDER_REVIEW: "With PayPal",
    RESOLVED: "Settled",
  },
  stage: { INQUIRY: "Inquiry", CHARGEBACK: "Claim", PRE_ARBITRATION: "Appeal", ARBITRATION: "Appeal" },
};

export interface ChartRow {
  reason: string;
  status: string;
  stage: string;
  amount: string;
  currency: string;
  created: string;
}

function periodStart(period: ChartSpec["period"], now: Date): number {
  if (period === "all") return -Infinity;
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return period === "month" ? Date.UTC(y, m, 1) : Date.UTC(y, m - (m % 3), 1);
}

export function chartRows(rows: ChartRow[], spec: ChartSpec, now = new Date()) {
  return chartData(rows, spec, now).rows;
}

export function chartData(rows: ChartRow[], spec: ChartSpec, now = new Date()) {
  const from = periodStart(spec.period, now);
  const sums = new Map<string, number>();
  let leftOut = 0;
  for (const r of rows) {
    if (Date.parse(r.created) < from) continue;
    if (spec.metric !== "count" && r.currency !== "USD") {
      leftOut++;
      continue;
    }
    const raw = r[spec.groupBy] ?? "";
    const key = LABELS[spec.groupBy][raw] ?? raw.toLowerCase().replace(/_/g, " ");
    const add = spec.metric === "count" ? 1 : Number(r.amount) * (spec.metric === "held" && r.status === "RESOLVED" ? 0 : 1) || 0;
    sums.set(key, Math.round(((sums.get(key) ?? 0) + add) * 100) / 100);
  }
  return { rows: [...sums].map(([key, value]) => ({ key, value })).sort((a, b) => b.value - a.value), leftOut };
}

export function chartTitle(spec: ChartSpec, leftOut = 0) {
  const what = spec.metric === "count" ? "Disputes" : spec.metric === "held" ? "Money on hold" : "Money in dispute";
  const when = spec.period === "all" ? "" : spec.period === "quarter" ? ", this quarter" : ", this month";
  const note = leftOut > 0 ? `, USD only, ${leftOut} case${leftOut === 1 ? "" : "s"} in another currency left out` : "";
  return `${what} by ${spec.groupBy}${when}${note}`;
}
