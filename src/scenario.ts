import { templateSentences, type EvidenceRecord } from "./agent";
import { decide, formatMoney, type CaseFacts, type Verdict } from "./rules";

export const CLAIM_AT = "2026-10-20T12:00:00Z";
export const DELIVERED_TWO_DAYS_BEFORE = "2026-10-18T12:00:00Z";
export const DELIVERED_ONE_HOUR_AFTER = "2026-10-20T13:00:00Z";

export const FIXTURES: Record<string, CaseFacts> = {
  delivered: {
    reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    amount: 24,
    currency: "USD",
    claimAt: CLAIM_AT,
    hasOrder: true,
    hasCapture: true,
    orderRead: "ok",
    captureRead: "ok",
    trackingRead: "ok",
    disputeId: "D_DELIVERED",
    captureId: "CAP_DELIVERED",
    trackingId: "ship_DELIVERED",
    paypalTrackingStatus: "DELIVERED",
    tracking: {
      carrier: "UPS",
      number: "1Z9999999999999999",
      status: "DELIVERED",
      deliveredAt: DELIVERED_TWO_DAYS_BEFORE,
      deliverySource: "seller",
      statusSource: "seller",
    },
  },
  refund: {
    reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    amount: 6,
    currency: "USD",
    claimAt: CLAIM_AT,
    hasOrder: true,
    hasCapture: true,
    orderRead: "ok",
    captureRead: "ok",
    trackingRead: "ok",
    disputeId: "D_REFUND",
    captureId: "CAP_REFUND",
  },
};

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === "object" && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const key of Object.keys(obj)) {
      deepFreeze((obj as Record<string, unknown>)[key]);
    }
  }
  return obj;
}
deepFreeze(FIXTURES);

export interface ScenarioSide {
  verdict: Verdict;
  rule: string;
  why: string;
  changeIf: string;
  missing: string[];
  sentences: string[];
  lines: ScenarioLine[];
}

export interface ScenarioLine {
  text: string;
  recordId: string;
  recordKind: string;
  recordSummary: string;
}

export interface LineDiff {
  kept: ScenarioLine[];
  added: ScenarioLine[];
  removed: ScenarioLine[];
}

export interface ScenarioComparison {
  original: ScenarioSide;
  changed: ScenarioSide;
  changedField: string;
  lineDiff: LineDiff;
  explain: string;
}

export interface ScenarioChange {
  field: string;
  value: unknown;
}

export function getFixtureFacts(fixtureId: string): CaseFacts {
  const base = FIXTURES[fixtureId];
  if (!base) {
    throw new Error(`Unknown fixture: ${fixtureId}`);
  }
  return JSON.parse(JSON.stringify(base)) as CaseFacts;
}

export function applyChange(facts: CaseFacts, change: ScenarioChange): void {
  if (!change || typeof change !== "object" || typeof change.field !== "string") {
    throw new Error("Unknown field");
  }
  const { field, value } = change;
  if (field === "deliveredAt") {
    if (value === "" || value === "none" || value === null || value === "no delivery record") {
      delete facts.tracking;
    } else {
      const parsed = Date.parse(String(value));
      if (!Number.isFinite(parsed)) {
        throw new Error("Invalid delivery date");
      }
      const iso = new Date(parsed).toISOString();
      if (facts.tracking) {
        facts.tracking.deliveredAt = iso;
        facts.tracking.status = "DELIVERED";
      } else {
        facts.tracking = {
          carrier: "UPS",
          number: "1Z9999999999999999",
          status: "DELIVERED",
          deliveredAt: iso,
          deliverySource: "seller",
          statusSource: "seller",
        };
      }
    }
  } else if (field === "trackingRead") {
    if (value !== "ok" && value !== "failed") {
      throw new Error("Tracking read must be ok or failed");
    }
    facts.trackingRead = value;
  } else if (field === "orderRead") {
    if (value !== "ok" && value !== "failed") {
      throw new Error("Order read must be ok or failed");
    }
    facts.orderRead = value;
  } else if (field === "amount") {
    const num = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(num) || num < 1 || num > 500) {
      throw new Error("Amount must be between 1 and 500");
    }
    facts.amount = num;
  } else {
    throw new Error(`Unknown field: ${field}`);
  }
}

export function recordsForFacts(facts: CaseFacts): EvidenceRecord[] {
  const captureId = facts.captureId ?? "CAP_1";
  const capture: EvidenceRecord = {
    id: captureId,
    kind: "capture",
    summary: `Payment ${captureId}: ${formatMoney(facts.amount, facts.currency)} paid on 2026-10-19`,
    facts: {
      amount: facts.amount,
      currency: facts.currency,
      status: facts.captureRead === "failed" ? "FAILED" : "COMPLETED",
      dates: ["2026-10-19"],
    },
  };

  const records: EvidenceRecord[] = [capture];

  if (facts.hasOrder && facts.orderRead !== "failed") {
    records.push({
      id: "ORD_1",
      kind: "order",
      summary: "Order ORD_1: Stoneware mug, shipping to Halifax, NS",
      facts: {
        item: "Stoneware mug",
        shipTo: "Halifax, NS",
      },
    });
  }

  if (facts.tracking && facts.trackingRead !== "failed") {
    const t = facts.tracking;
    const time = t.deliveredAt ? new Date(t.deliveredAt) : undefined;
    const stamp =
      time && Number.isFinite(time.getTime())
        ? `${time.toISOString().slice(0, 10)} ${time.toISOString().slice(11, 16)} UTC`
        : undefined;
    const carrier = t.carrier ?? "UPS";
    const number = t.number ?? "1Z9999999999999999";
    const trackingId = facts.trackingId ?? "ship_1";
    records.push({
      id: trackingId,
      kind: "tracking",
      summary: `Shipping record ${trackingId}: ${carrier} number ${number}, status ${t.status}${stamp ? `, delivered ${stamp}` : ""}`,
      facts: {
        status: t.status,
        statusSource: t.statusSource ?? "seller",
        deliverySource: t.deliverySource ?? "seller",
        deliveredAt: t.deliveredAt,
        carrier,
        trackingNumber: number,
        dates: t.deliveredAt ? [t.deliveredAt.slice(0, 10)] : [],
        numbers: stamp ? (stamp.slice(11).match(/\d+/g) ?? []).map(Number) : [],
      },
    });
  }

  const disputeId = facts.disputeId ?? "D_1";
  records.push({
    id: disputeId,
    kind: "dispute",
    summary: `Dispute ${disputeId}: reason ${facts.reason}, ${formatMoney(facts.amount, facts.currency)}, opened ${facts.claimAt.slice(0, 10)}`,
    facts: {
      amount: facts.amount,
      currency: facts.currency,
      dates: [facts.claimAt.slice(0, 10)],
    },
  });

  return records;
}

export function evaluateSide(facts: CaseFacts): ScenarioSide {
  const d = decide(facts);
  const records = recordsForFacts(facts);
  const lines: ScenarioLine[] = templateSentences(d, records).map((s) => {
    const record = records.find((r) => r.id === s.record_id);
    return {
      text: s.text,
      recordId: s.record_id,
      recordKind: record?.kind ?? "unknown",
      recordSummary: record?.summary ?? s.record_id,
    };
  });
  return {
    verdict: d.verdict,
    rule: d.rule,
    why: d.why,
    changeIf: d.changeIf,
    missing: d.missing,
    sentences: lines.map((l) => l.text),
    lines,
  };
}

export function diffLines(original: ScenarioLine[], changed: ScenarioLine[]): LineDiff {
  const after = new Set(changed.map((l) => l.text));
  const before = new Set(original.map((l) => l.text));
  return {
    kept: original.filter((l) => after.has(l.text)),
    removed: original.filter((l) => !after.has(l.text)),
    added: changed.filter((l) => !before.has(l.text)),
  };
}

const KIND_WORD: Record<string, string> = {
  tracking: "shipping",
  capture: "payment",
  order: "order",
  dispute: "claim",
};
const RECORD_WORD: Record<string, string> = {
  tracking: "shipping record",
  capture: "payment record",
  order: "order record",
  dispute: "dispute record",
};

function countByKind(lines: ScenarioLine[]): string {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line.recordKind, (counts.get(line.recordKind) ?? 0) + 1);
  const parts = [...counts].map(([kind, n]) => `${n} ${KIND_WORD[kind] ?? kind} ${n === 1 ? "line" : "lines"}`);
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function causeSentence(change: ScenarioChange, facts: CaseFacts): string {
  switch (change.field) {
    case "trackingRead":
      return change.value === "failed" ? "The shipping record could not be read." : "The shipping record was read.";
    case "orderRead":
      return change.value === "failed" ? "The order could not be read." : "The order was read.";
    case "deliveredAt": {
      if (!change.value) return "The shipping record now has no delivery date.";
      const at = new Date(String(change.value)).getTime();
      const claim = new Date(facts.claimAt).getTime();
      return at > claim ? "The delivery date is now after the claim." : "The delivery date is now before the claim.";
    }
    case "amount":
      return `The amount is now ${formatMoney(facts.amount, facts.currency)}.`;
    default:
      return `The ${change.field} changed.`;
  }
}

export function explainChange(
  change: ScenarioChange,
  changedFacts: CaseFacts,
  original: ScenarioSide,
  changed: ScenarioSide,
  diff: LineDiff,
): string {
  const out = [causeSentence(change, changedFacts)];
  if (original.verdict !== changed.verdict) {
    out.push(`The verdict moves from ${original.verdict} to ${changed.verdict}.`);
  }
  if (changed.verdict === "REVIEW") out.push("Nothing will be filed.");
  if (diff.removed.length === 0 && diff.added.length === 0) {
    out.push("The draft lines did not change.");
    return out.join(" ");
  }
  if (diff.removed.length) {
    out.push(`${countByKind(diff.removed)} left the draft.`.replace(/^./, (c) => c.toUpperCase()));
  }
  if (diff.added.length) {
    const n = diff.added.length;
    out.push(`${countByKind(diff.added)} ${n === 1 ? "was" : "were"} added.`.replace(/^./, (c) => c.toUpperCase()));
  }
  const keptRecords = [...new Map(diff.kept.map((l) => [l.recordId, l])).values()];
  for (const line of keptRecords) {
    const n = diff.kept.filter((l) => l.recordId === line.recordId).length;
    const word = KIND_WORD[line.recordKind] ?? line.recordKind;
    out.push(
      `The ${word} ${n === 1 ? "line stays: it comes" : "lines stay: they come"} from ${RECORD_WORD[line.recordKind] ?? "record"} ${line.recordId}.`,
    );
  }
  return out.join(" ");
}

export function compareScenario(fixtureId: string, change: ScenarioChange): ScenarioComparison {
  if (fixtureId !== "delivered" && fixtureId !== "refund") {
    throw new Error(`Unknown fixture: ${fixtureId}`);
  }
  if (!change || typeof change !== "object" || typeof change.field !== "string") {
    throw new Error("Unknown field");
  }
  const originalFacts = getFixtureFacts(fixtureId);
  const changedFacts = getFixtureFacts(fixtureId);
  applyChange(changedFacts, change);

  const original = evaluateSide(originalFacts);
  const changed = evaluateSide(changedFacts);
  const lineDiff = diffLines(original.lines, changed.lines);
  return {
    original,
    changed,
    changedField: change.field,
    lineDiff,
    explain: explainChange(change, changedFacts, original, changed, lineDiff),
  };
}

export function scenarioOptions() {
  return {
    fixtures: [
      { id: "delivered", label: "Delivered item", description: "$24.00 USD with delivery record" },
      { id: "refund", label: "Refund claim", description: "$6.00 USD with no delivery record" },
    ],
    fields: [
      {
        name: "deliveredAt",
        label: "Delivery date",
        type: "select" as const,
        options: [
          { label: "2 days before the claim", value: DELIVERED_TWO_DAYS_BEFORE },
          { label: "1 hour after the claim", value: DELIVERED_ONE_HOUR_AFTER },
          { label: "no delivery record", value: "" },
        ],
      },
      {
        name: "trackingRead",
        label: "Tracking read",
        type: "select" as const,
        options: [
          { label: "ok", value: "ok" },
          { label: "failed", value: "failed" },
        ],
      },
      {
        name: "orderRead",
        label: "Order read",
        type: "select" as const,
        options: [
          { label: "ok", value: "ok" },
          { label: "failed", value: "failed" },
        ],
      },
      {
        name: "amount",
        label: "Amount",
        type: "number" as const,
        min: 1,
        max: 500,
        defaultValue: 12,
      },
    ],
  };
}
