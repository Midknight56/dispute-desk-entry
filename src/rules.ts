export const FIGHT_LINE = 10.0; // USD. Under this, with no evidence, accepting costs less than the seller's time.
export const OFFER_SHARE = 0.5; // a weak case offers half back

export type Verdict = "FIGHT" | "ACCEPT" | "OFFER" | "REVIEW";

export interface DeskPolicy {
  FIGHT_LINE_USD?: unknown;
  OFFER_SHARE?: unknown;
}

export function deskPolicy(policy: DeskPolicy = {}) {
  const number = (value: unknown, fallback: number, max = Infinity) => {
    const n = typeof value === "number" || (typeof value === "string" && value.trim()) ? Number(value) : NaN;
    return Number.isFinite(n) && n >= 0 && n <= max ? n : fallback;
  };
  return {
    fightLine: number(policy.FIGHT_LINE_USD, FIGHT_LINE),
    offerShare: number(policy.OFFER_SHARE, OFFER_SHARE, 1),
  };
}

export interface CaseFacts {
  reason: string;
  amount: number;
  currency: string;
  claimAt: string;
  tracking?: {
    status: "SHIPPED" | "DELIVERED" | string;
    deliveredAt?: string;
    deliverySource?: "paypal" | "seller";
    statusSource?: "paypal" | "seller";
    carrier?: string;
    number?: string;
  };
  hasOrder: boolean;
  hasCapture: boolean;
  captureRead?: "ok" | "failed";
  orderRead?: "ok" | "failed" | "none";
  trackingRead?: "ok" | "failed" | "none";
  disputeId?: string;
  captureId?: string;
  trackingId?: string;
  digital?: boolean;
  paypalTrackingStatus?: string;
  paymentAmount?: number;
  paymentCurrency?: string;
  paymentStatus?: string;
}

export const SUPPORTED_REASONS = [
  "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
] as const;

export interface DecisionPolicy {
  fightLine: string;
  offerShare: string;
  currency: "USD";
  reasons: string[];
  note: string;
}

export interface Decision {
  verdict: Verdict;
  rule: string;
  why: string;
  facts: { label: string; value: string; recordId?: string }[];
  missing: string[];
  changeIf: string;
  disagreements: string[];
  offerAmount?: string;
  policy?: DecisionPolicy;
}

export function plainReasons(reasons?: string[]): string {
  if (!reasons || !reasons.length) return "";
  return reasons
    .map((reason) => {
      if (reason === "MERCHANDISE_OR_SERVICE_NOT_RECEIVED") return "not received";
      if (reason === "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED") return "not as described";
      return reason.toLowerCase().replace(/_/g, " ");
    })
    .join(", ");
}

function fractionDigits(currency: string): number {
  try {
    const digits = new Intl.NumberFormat("en", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).resolvedOptions().maximumFractionDigits;
    return digits ?? 2;
  } catch {
    return 2;
  }
}

export function formatMoney(amount: number, currency: string): string {
  const value = safeAmount(amount).toFixed(fractionDigits(currency));
  return currency.toUpperCase() === "USD" ? `$${value}` : `${currency.toUpperCase()} ${value}`;
}

// "3 days", "1 day", "5 hours", "7 minutes": the largest whole unit that fits.
function gap(ms: number): string {
  const units: [number, string][] = [
    [86_400_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
  ];
  for (const [size, name] of units) {
    const n = Math.floor(ms / size);
    if (n >= 1) return `${n} ${name}${n === 1 ? "" : "s"}`;
  }
  return "moments";
}

function offer(amount: number, currency: string, share: number): string {
  const digits = fractionDigits(currency);
  const factor = 10 ** digits;
  return (Math.round((safeAmount(amount) * share + Number.EPSILON) * factor) / factor).toFixed(digits);
}

function safeAmount(amount: number): number {
  return Number.isFinite(amount) ? Math.max(0, amount) : 0;
}

export function decide(f: CaseFacts, policy: DeskPolicy = {}): Decision {
  const { fightLine, offerShare } = deskPolicy(policy);
  const shareText = offerShare === 0.5 ? "half" : `${offerShare * 100} percent`;
  const decisionPolicy: DecisionPolicy = {
    fightLine: formatMoney(fightLine, "USD"),
    offerShare: shareText,
    currency: "USD",
    reasons: [...SUPPORTED_REASONS],
    note: "Set by this desk, not by PayPal. The desk works in USD only.",
  };
  const amount = safeAmount(f.amount);
  const t = f.tracking;
  const disagreements: string[] = [];
  if (f.paypalTrackingStatus && t?.deliveredAt && f.paypalTrackingStatus !== "DELIVERED")
    disagreements.push(
      `PayPal says ${f.paypalTrackingStatus}, but the seller's shipping record says delivered on ${t.deliveredAt}.`,
    );
  if (
    f.paymentAmount != null &&
    Number.isFinite(f.paymentAmount) &&
    (f.paymentAmount !== amount || (f.paymentCurrency ?? f.currency).toUpperCase() !== f.currency.toUpperCase())
  )
    disagreements.push(
      `The dispute is ${formatMoney(amount, f.currency)}, but the payment is ${formatMoney(f.paymentAmount, f.paymentCurrency ?? f.currency)}.`,
    );
  const facts: Decision["facts"] = [
    { label: "Amount", value: formatMoney(amount, f.currency), recordId: f.disputeId },
    { label: "Claim opened", value: f.claimAt, recordId: f.disputeId },
    { label: "Fight line", value: formatMoney(fightLine, "USD") },
  ];
  const missing = t ? (t.deliveredAt ? [] : ["A delivery date"]) : ["A delivery record"];
  if (t) {
    facts.push({
      label:
        t.statusSource === "paypal"
          ? "Tracking status (PayPal)"
          : t.statusSource === "seller"
            ? "Tracking status (our shipping record)"
            : "Tracking status",
      value: t.status,
      recordId: f.trackingId,
    });
    if (t.deliveredAt)
      facts.push({
        label: t.deliverySource === "seller" ? "Delivered (our shipping record)" : "Delivered (PayPal tracking)",
        value: t.deliveredAt,
        recordId: f.trackingId,
      });
  }
  const review = (rule: string, why: string, changeIf: string, absent: string[]): Decision => ({
    verdict: "REVIEW",
    rule,
    why,
    facts,
    disagreements,
    missing: [...absent, ...missing],
    changeIf,
    policy: decisionPolicy,
  });
  if (!f.hasCapture || f.captureRead === "failed") {
    facts.push({ label: "Payment read", value: "Failed or missing", recordId: f.captureId });
    return review(
      "READ_FAILED",
      "PayPal did not return the payment. Analyse again before you answer.",
      "A successful payment read would let the desk decide this case again.",
      ["The payment"],
    );
  }
  if (f.orderRead === "failed") {
    facts.push({ label: "Order read", value: "Failed" });
    return review(
      "READ_FAILED",
      "PayPal did not return the order. Analyse again before you answer.",
      "A successful order read would let the desk decide this case again.",
      ["The order"],
    );
  }
  if (
    (f.paymentCurrency != null && f.paymentCurrency.toUpperCase() !== f.currency.toUpperCase()) ||
    (f.paymentAmount != null && Number.isFinite(f.paymentAmount) && f.paymentAmount < amount)
  )
    return review(
      "RECORDS_DISAGREE",
      "The payment and the dispute do not match. Answer this one on PayPal.",
      "Matching payment and dispute records would let the desk decide this case again.",
      [],
    );
  if (["REFUNDED", "PARTIALLY_REFUNDED", "DECLINED", "FAILED", "REVERSED"].includes(f.paymentStatus ?? "")) {
    facts.push({ label: "Payment status", value: f.paymentStatus!, recordId: f.captureId });
    return review(
      "PAYMENT_STATUS",
      `PayPal shows this payment as ${f.paymentStatus}. Check it on PayPal before you answer.`,
      "A completed or pending payment would let the desk decide this case again.",
      [],
    );
  }
  if (f.trackingRead === "failed") {
    facts.push({ label: "Tracking read", value: "Failed", recordId: f.trackingId });
    return review(
      "READ_FAILED",
      "PayPal did not return the tracking. Analyse again before you answer.",
      "A successful tracking read would let the desk decide this case again.",
      ["The tracking read"],
    );
  }
  if (f.currency.toUpperCase() !== "USD") {
    facts.push({ label: "Currency", value: f.currency, recordId: f.disputeId });
    return review(
      "CURRENCY_NOT_SUPPORTED",
      "This desk decides USD cases only. Answer this one on PayPal.",
      "A payment and dispute in USD would let the desk decide this case.",
      [],
    );
  }
  if (!SUPPORTED_REASONS.includes(f.reason as any)) {
    facts.push({ label: "Reason", value: f.reason.toLowerCase().replace(/_/g, " "), recordId: f.disputeId });
    return review(
      "REASON_NOT_SUPPORTED",
      "This desk does not decide this kind of dispute. Answer it on PayPal.",
      "A not received or not as described reason would let the desk decide this case.",
      [],
    );
  }
  const beforeClaim = `A delivery date before ${f.claimAt} would make the desk fight.`;
  const changeIf =
    f.reason === "MERCHANDISE_OR_SERVICE_NOT_RECEIVED"
      ? beforeClaim
      : `Without a delivery record, an amount below ${formatMoney(fightLine, "USD")} would make the desk accept.`;
  if (
    f.reason === "MERCHANDISE_OR_SERVICE_NOT_RECEIVED" &&
    t?.deliveredAt &&
    (t.status === "DELIVERED" || t.deliverySource === "seller")
  ) {
    const delivered = Date.parse(t.deliveredAt);
    const claim = Date.parse(f.claimAt);
    if (Number.isFinite(delivered) && Number.isFinite(claim) && delivered < claim) {
      return {
        verdict: "FIGHT",
        rule: "INR_DELIVERED_BEFORE_CLAIM",
        why:
          t.deliverySource === "seller"
            ? `Our shipping record shows it delivered ${gap(claim - delivered)} before the claim.` +
              (f.paypalTrackingStatus ? ` PayPal tracking says ${f.paypalTrackingStatus}.` : "")
            : `${t.carrier || "The carrier"} shows it delivered ${gap(claim - delivered)} before the claim.`,
        facts,
        disagreements,
        missing,
        changeIf: `A delivery date after ${f.claimAt} would make the desk offer ${shareText} back.`,
        policy: decisionPolicy,
      };
    }
  }

  if (!t && amount < fightLine) {
    return {
      verdict: "ACCEPT",
      rule: "NO_EVIDENCE_UNDER_LINE",
      why: `No delivery record, and ${formatMoney(amount, f.currency)} is under the ${formatMoney(fightLine, "USD")} fight line.`,
      facts,
      disagreements,
      missing,
      changeIf: `An amount of ${formatMoney(fightLine, "USD")} or more would make the desk offer ${shareText} back.`,
      policy: decisionPolicy,
    };
  }

  if (t) {
    return {
      verdict: "OFFER",
      rule: "WEAK_EVIDENCE",
      why: `The delivery record does not establish delivery before the claim, so offer ${shareText} back.`,
      offerAmount: offer(amount, f.currency, offerShare),
      facts: [...facts, { label: "Offer share", value: `${offerShare * 100} percent` }],
      disagreements,
      missing,
      changeIf,
      policy: decisionPolicy,
    };
  }

  return {
    verdict: "OFFER",
    rule: "NO_EVIDENCE_OVER_LINE",
    why: `There is no delivery record, so offer ${shareText} back.`,
    offerAmount: offer(amount, f.currency, offerShare),
    facts: [...facts, { label: "Offer share", value: `${offerShare * 100} percent` }],
    disagreements,
    missing,
    changeIf,
    policy: decisionPolicy,
  };
}

export interface Sentence {
  text: string;
  record_id: string;
}
export interface Draft {
  verdict: Verdict;
  sentences: Sentence[];
}

export function dropUnbacked(sentences: unknown, recordIds: Set<string>): { kept: Sentence[]; dropped: Sentence[] } {
  const kept: Sentence[] = [];
  const dropped: Sentence[] = [];
  if (!Array.isArray(sentences)) return { kept, dropped };

  for (const item of sentences) {
    if (item === null || typeof item !== "object") continue;
    const candidate = item as { text?: unknown; record_id?: unknown };
    if (typeof candidate.text !== "string" || typeof candidate.record_id !== "string") continue;
    const text = candidate.text.trim();
    if (!text) continue;
    const sentence = { text, record_id: candidate.record_id };
    if (recordIds.has(candidate.record_id)) kept.push(sentence);
    else dropped.push(sentence);
  }
  return { kept, dropped };
}

export function finalDecision(d: Decision, kept: Sentence[], f: CaseFacts, policy: DeskPolicy = {}): Decision {
  const { fightLine, offerShare } = deskPolicy(policy);
  const amount = safeAmount(f.amount);
  const shareText = offerShare === 0.5 ? "half" : `${offerShare * 100} percent`;
  const decisionPolicy: DecisionPolicy = {
    fightLine: formatMoney(fightLine, "USD"),
    offerShare: shareText,
    currency: "USD",
    reasons: [...SUPPORTED_REASONS],
    note: "Set by this desk, not by PayPal. The desk works in USD only.",
  };
  if (d.verdict !== "FIGHT" || kept.length > 0) return d;
  if (amount < fightLine) {
    return {
      ...d,
      verdict: "ACCEPT",
      rule: "NOT_ENOUGH_EVIDENCE",
      why: "Not enough evidence to fight this claim, so accept it.",
      missing: [...d.missing, "A kept evidence sentence"],
      changeIf: "A kept sentence backed by the delivery record would make the desk fight.",
      policy: decisionPolicy,
    };
  }
  return {
    ...d,
    verdict: "OFFER",
    rule: "NOT_ENOUGH_EVIDENCE",
    why: `Not enough evidence to fight this claim, so offer ${shareText} back.`,
    offerAmount: offer(amount, f.currency, offerShare),
    missing: [...d.missing, "A kept evidence sentence"],
    changeIf: "A kept sentence backed by the delivery record would make the desk fight.",
    policy: decisionPolicy,
  };
}
