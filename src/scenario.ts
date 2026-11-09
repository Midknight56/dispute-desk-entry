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
}

export interface ScenarioComparison {
  original: ScenarioSide;
  changed: ScenarioSide;
  changedField: string;
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
  const sentences = templateSentences(d, records).map((s) => s.text);
  return {
    verdict: d.verdict,
    rule: d.rule,
    why: d.why,
    changeIf: d.changeIf,
    missing: d.missing,
    sentences,
  };
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

  return {
    original: evaluateSide(originalFacts),
    changed: evaluateSide(changedFacts),
    changedField: change.field,
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
