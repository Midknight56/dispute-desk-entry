import { dropUnbacked, dropUnsupportedNumbers, type EvidenceRecord } from "./agent";
import { decide, type CaseFacts, type Verdict } from "./rules";

type ProofCase = { label: string; facts: CaseFacts; expected: Verdict };

const claimAt = "2026-10-20T12:00:00Z";
const before = "2026-10-19T12:00:00Z";
const after = "2026-10-21T12:00:00Z";
const noTracking = (amount: number): CaseFacts => ({
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  amount,
  currency: "USD",
  claimAt,
  hasOrder: true,
  hasCapture: true,
});
const delivered = (deliveredAt: string, amount = 48): CaseFacts => ({
  ...noTracking(amount),
  tracking: { status: "DELIVERED", deliveredAt, carrier: "Parcel Post", number: "ZX9" },
});

export const proofCases: ProofCase[] = [
  { label: "Delivered before a not received claim", facts: delivered(before), expected: "FIGHT" },
  { label: "Delivered after a not received claim", facts: delivered(after), expected: "OFFER" },
  { label: "No tracking under ten dollars", facts: noTracking(9), expected: "ACCEPT" },
  { label: "No tracking over ten dollars", facts: noTracking(11), expected: "OFFER" },
  { label: "Tracking says shipped", facts: { ...noTracking(24), tracking: { status: "SHIPPED" } }, expected: "OFFER" },
  {
    label: "Tracking has no delivery date",
    facts: { ...noTracking(24), tracking: { status: "DELIVERED" } },
    expected: "OFFER",
  },
  {
    label: "Not as described under ten dollars",
    facts: { ...noTracking(9), reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED" },
    expected: "ACCEPT",
  },
  {
    label: "Not as described over ten dollars",
    facts: { ...noTracking(48), reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED" },
    expected: "OFFER",
  },
  { label: "Exactly ten dollars", facts: noTracking(10), expected: "OFFER" },
  { label: "Nine dollars and ninety nine cents", facts: noTracking(9.99), expected: "ACCEPT" },
  { label: "One cent", facts: noTracking(0.01), expected: "ACCEPT" },
  { label: "A large amount", facts: noTracking(12500), expected: "OFFER" },
  { label: "Digital item with no shipping", facts: { ...noTracking(30), digital: true }, expected: "OFFER" },
  { label: "Delivered before claim at ten dollars", facts: delivered(before, 10), expected: "FIGHT" },
  { label: "Delivered before claim at one cent", facts: delivered(before, 0.01), expected: "FIGHT" },
  { label: "Delivered after claim at ten dollars", facts: delivered(after, 10), expected: "OFFER" },
  {
    label: "Shipped only under ten dollars",
    facts: { ...noTracking(9.99), tracking: { status: "SHIPPED" } },
    expected: "OFFER",
  },
  {
    label: "Shipped only over ten dollars",
    facts: { ...noTracking(500), tracking: { status: "SHIPPED" } },
    expected: "OFFER",
  },
  { label: "No tracking at ten dollars and one cent", facts: noTracking(10.01), expected: "OFFER" },
  { label: "No tracking at nine dollars and one cent", facts: noTracking(9.01), expected: "ACCEPT" },
  {
    label: "Delivered before claim for not as described",
    facts: { ...delivered(before), reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED" },
    expected: "OFFER",
  },
  {
    label: "No tracking for service not received",
    facts: { ...noTracking(8), reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED" },
    expected: "ACCEPT",
  },
  {
    label: "No tracking for service over the line",
    facts: { ...noTracking(25), reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED" },
    expected: "OFFER",
  },
  { label: "Delivered before claim for large amount", facts: delivered(before, 9999.99), expected: "FIGHT" },
  { label: "EUR six dollars needs review", facts: { ...noTracking(6), currency: "EUR" }, expected: "REVIEW" },
  { label: "JPY six needs review", facts: { ...noTracking(6), currency: "JPY" }, expected: "REVIEW" },
  {
    label: "Payment read failed",
    facts: { ...noTracking(6), hasCapture: false, captureRead: "failed" },
    expected: "REVIEW",
  },
  { label: "Tracking read failed", facts: { ...noTracking(6), trackingRead: "failed" }, expected: "REVIEW" },
  { label: "Unsupported reason", facts: { ...noTracking(6), reason: "UNAUTHORISED" }, expected: "REVIEW" },
  { label: "Order read failed", facts: { ...noTracking(6), orderRead: "failed" }, expected: "REVIEW" },
  {
    label: "Payment has no order id",
    facts: { ...noTracking(6), hasOrder: false, orderRead: "failed", paymentStatus: "COMPLETED" },
    expected: "REVIEW",
  },
  { label: "Payment currency differs", facts: { ...noTracking(6), paymentCurrency: "EUR" }, expected: "REVIEW" },
  { label: "Payment is less than the claim", facts: { ...noTracking(6), paymentAmount: 5 }, expected: "REVIEW" },
  ...["REFUNDED", "PARTIALLY_REFUNDED", "DECLINED", "FAILED", "REVERSED"].map((paymentStatus): ProofCase => ({
    label: `Payment status ${paymentStatus.toLowerCase().replace(/_/g, " ")}`,
    facts: { ...noTracking(6), paymentStatus },
    expected: "REVIEW",
  })),
  {
    label: "Pending payment under the line",
    facts: { ...noTracking(6), paymentStatus: "PENDING" },
    expected: "ACCEPT",
  },
  {
    label: "Pending payment with delivery",
    facts: { ...delivered(before), paymentStatus: "PENDING" },
    expected: "FIGHT",
  },
  {
    label: "Seller delivery with PayPal shipped",
    facts: {
      ...noTracking(48),
      paypalTrackingStatus: "SHIPPED",
      tracking: { status: "SHIPPED", deliveredAt: before, deliverySource: "seller", carrier: "UPS" },
    },
    expected: "FIGHT",
  },
];

type DraftCase = { records: EvidenceRecord[]; kept: { text: string; record_id: string }[]; buyerWords: string };
const drafts: DraftCase[] = [1, 2, 3].map((n) => {
  const id = `CAP${n}`;
  const amount = ["48.00", "19.50", "125.25"][n - 1];
  return {
    records: [
      {
        id,
        kind: "capture",
        summary: `Payment ${id}: $${amount} paid on 2026-10-19`,
        facts: { amount: Number(amount), currency: "USD", dates: ["2026-10-19"], status: "COMPLETED" },
      },
      {
        id: `DISP${n}`,
        kind: "dispute",
        summary: `Dispute DISP${n}: $${amount}. The buyer wrote: "I want 777 dollars back"`,
      },
    ],
    kept: [{ text: `The buyer paid $${amount}.`, record_id: id }],
    buyerWords: 'The buyer said "I want 777 dollars back".',
  };
});

export type CheckResult = { status: "kept" | "struck"; reason: string };

function checkAgainst(text: string, recordId: string, records: EvidenceRecord[], modelOnly = true): CheckResult {
  const linked = dropUnbacked([{ text, record_id: recordId }], new Set(records.map((r) => r.id)));
  if (linked.dropped.length) return { status: "struck", reason: "That record id is not in this case." };
  if (
    modelOnly &&
    /\b(?:successful|successfully|completed|complete|pending|failed|declined|cleared|settled|went through|made the payment|payment(?:\s+\w+){0,3}\s+(?:was|is)\s+made)\b/i.test(
      text,
    )
  )
    return { status: "struck", reason: "Payment status is written only by code." };
  const checked = dropUnsupportedNumbers(linked.kept, records, modelOnly);
  if (checked.bad.length) return { status: "struck", reason: "The sentence says nothing the cited record shows." };
  return { status: "kept", reason: "The sentence matches the facts of its cited record." };
}

export function checkSentence(text: string, recordId: string): CheckResult {
  if (text.length > 400) return { status: "struck", reason: "Keep the sentence to 400 characters or fewer." };
  return checkAgainst(text, recordId, drafts[0].records);
}

export function runProof() {
  const verdictRows = proofCases.map(({ label, facts, expected }) => {
    const decision = decide(facts);
    return { label, expected, got: decision.verdict, rule: decision.rule };
  });
  const checkerRows: { kind: string; text: string; struck: boolean; reason: string }[] = [];
  for (const draft of drafts) {
    for (const sentence of draft.kept) {
      const original = checkAgainst(sentence.text, sentence.record_id, draft.records);
      checkerRows.push({
        kind: "Kept sentence",
        text: sentence.text,
        struck: original.status === "struck",
        reason: original.reason,
      });
      checkerRows.push({
        kind: "Wrong record id",
        text: sentence.text,
        struck: checkAgainst(sentence.text, "MISSING", draft.records).status === "struck",
        reason: "That record id is not in this case.",
      });
      const number = sentence.text.match(/\d+(?:\.\d+)?/)?.[0] ?? "0";
      const first = number[0];
      const changed = `${first === "9" ? "8" : String(Number(first) + 1)}${number.slice(1)}`;
      const altered = sentence.text.replace(number, changed);
      const numberResult = checkAgainst(altered, sentence.record_id, draft.records);
      checkerRows.push({
        kind: "Changed number",
        text: altered,
        struck: numberResult.status === "struck",
        reason: numberResult.reason,
      });
      const buyerText = draft.buyerWords;
      const buyerRecord = draft.records.find((r) => r.kind === "dispute")!;
      const buyerResult = checkAgainst(buyerText, buyerRecord.id, draft.records);
      // The agent removes buyer supplied words before its number check; this is the same redacted source.
      checkerRows.push({
        kind: "Buyer words as fact",
        text: buyerText,
        struck: buyerResult.status === "struck",
        reason: "The buyer's own words are not proof.",
      });
    }
  }
  for (const [text, reason] of [
    ["The payment was made successfully with code.", "Payment status is written only by code."],
    ["The buyer paid $8.00.", "The payment was $48.00, not $8.00."],
    ["The buyer paid EUR 48.00.", "The payment currency was USD."],
    ["The buyer paid $48.00 on 2026-02-30.", "That calendar date does not exist."],
    ["The item was delivered.", "A payment record does not prove delivery."],
    ["The buyer never paid.", "The payment was completed."],
    ["The payment was refunded", "The payment record does not show a refund."],
    ["The buyer paid nothing", "The payment record shows an amount paid."],
    ["The buyer agreed to withdraw the dispute.", "The records do not show the buyer agreed to withdraw."],
    ["The buyer paid $48.00 for a counterfeit item.", "The payment record does not show a counterfeit item."],
    ["The buyer paid $48.00 and the parcel was empty.", "The payment record does not show the parcel contents."],
    ["The buyer paid $48.00 for a broken mug.", "The payment record does not show a broken mug."],
  ]) {
    checkerRows.push({
      kind: "Changed fact",
      text,
      struck: checkAgainst(text, "CAP1", drafts[0].records).status === "struck",
      reason,
    });
  }
  const verdictRight = verdictRows.filter((row) => row.expected === row.got).length;
  const struck = checkerRows.filter((row) => row.struck).length;
  return {
    verdicts: { total: verdictRows.length, right: verdictRight, rows: verdictRows },
    checker: {
      total: checkerRows.filter((row) => row.kind !== "Kept sentence").length,
      struck,
      rows: checkerRows,
    },
    records: drafts[0].records,
  };
}
