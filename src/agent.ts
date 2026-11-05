import { boundMessages, type CallKind, type ModelMessage } from "./caps";
// The dispute agent. Code gathers the records and decides the verdict (src/rules.ts). The model does two small
// jobs: it picks records to read, then selects typed facts. Code writes every sentence from those facts.
// If the selection cannot be read after one retry, code picks the facts as well.
import {
  decide,
  dropUnbacked,
  finalDecision,
  type CaseFacts,
  type Decision,
  type DeskPolicy,
  type Sentence,
} from "./rules";
import { codeFactSentences, supportedSentence, summaryFacts, type RecordFacts } from "./sentence-facts";
export { dropUnbacked };

export const MODEL = "@cf/meta/llama-3.2-3b-instruct"; // the same free tier model as midknight-llm-proxy

export type RecordKind = "dispute" | "capture" | "order" | "tracking" | "invoice";
export interface EvidenceRecord {
  id: string;
  kind: RecordKind;
  summary: string;
  facts?: RecordFacts;
  // The pack already receives these records. Keep the decision with the dispute through storage as well.
  decision?: Decision;
}

export interface Shipment {
  custom_id: string;
  order_id: string;
  capture_id: string;
  carrier: string;
  tracking_number: string;
  delivered_at?: string | null;
  tracker_id?: string | null;
}

export interface ToolStep {
  tool: string;
  ref: string;
  ok: boolean;
  summary: string;
  ms: number;
}

export interface ModelReply {
  text: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}
export type ModelFn = (messages: ModelMessage[], kind: CallKind) => Promise<ModelReply>;

export interface AgentDeps {
  getDispute(id: string): Promise<any>;
  getCapture(id: string): Promise<any>;
  getOrder(id: string): Promise<any>;
  getTracker(id: string): Promise<any>;
  // when the desk marked the parcel delivered (PayPal's tracker keeps no date)
  deliveredAt(trackerId: string): Promise<string | undefined>;
  // the seller's own shipping record for a sale, when PayPal holds no tracker for it
  shipment?(customId: string): Promise<Shipment | undefined>;
  model?: ModelFn;
  policy?: DeskPolicy;
  onStep?(step: ToolStep): Promise<void> | void;
}

export interface AgentRun {
  version?: string;
  disputeId: string;
  decision: Decision;
  sentences: Sentence[];
  dropped: Sentence[];
  records: EvidenceRecord[];
  steps: ToolStep[];
  writer: "model" | "template";
  rawWriter?: string; // the model's own reply, kept so a failed parse can be read later
  selected?: string[];
  chosenTools: string[];
  usage: { prompt_tokens: number; completion_tokens: number; calls: number };
}

const TOOLS = ["get_order", "get_tracking", "get_invoice"] as const;
type ToolName = (typeof TOOLS)[number];

function money(value: string | number, currency = "USD") {
  const amount = Number(value);
  const code = currency.toUpperCase();
  let digits = 2;
  try {
    digits =
      new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    // Unknown currency codes use the common two digit format.
  }
  const v = (Number.isFinite(amount) ? Math.max(0, amount) : 0).toFixed(digits);
  return code === "USD" ? `$${v}` : `${code} ${v}`;
}

// "2026-10-23 02:36 UTC": a time a reader and a small model both copy cleanly.
function when(iso: string) {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? iso : `${t.toISOString().slice(0, 10)} ${t.toISOString().slice(11, 16)} UTC`;
}

// PayPal's codes in the words a seller reads, for the step lines on screen (the model still sees the codes).
const WORDS: Record<string, string> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "not received",
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "not as described",
  WAITING_FOR_SELLER_RESPONSE: "your move",
  WAITING_FOR_BUYER_RESPONSE: "buyer's move",
  UNDER_REVIEW: "with PayPal",
  RESOLVED: "settled",
};
export function plain(code?: string) {
  return code ? (WORDS[code] ?? code.toLowerCase().replace(/_/g, " ")) : "unknown";
}

function day(iso?: string) {
  return iso ? iso.slice(0, 10) : "an unknown date";
}

// The first {...} block in a reply: small models often wrap JSON in words or code fences.
export function firstJson(text: string): any {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

// When the reply is not one valid JSON object (a trailing comma, words after it), each sentence object can still be
// read on its own. Only objects with exactly a text and a record_id string are taken.
export function sentenceObjects(text: string): { text: string; record_id: string }[] | undefined {
  const found: { text: string; record_id: string }[] = [];
  for (const m of text.matchAll(/\{[^{}]*\}/g)) {
    try {
      const o = JSON.parse(m[0]);
      if (typeof o?.text === "string" && typeof o?.record_id === "string")
        found.push({ text: o.text, record_id: o.record_id });
    } catch {
      // not one of ours
    }
  }
  return found.length ? found : undefined;
}

// A reply can stop before its closing brackets. Read each complete string after the sentences array starts.
export function sentenceStrings(text: string): string[] | undefined {
  const start = /"sentences"\s*:\s*\[/.exec(text);
  if (!start) return undefined;
  const found: string[] = [];
  for (const m of text.slice(start.index + start[0].length).matchAll(/"(?:[^"\\]|\\.)*"/gs)) {
    try {
      found.push(JSON.parse(m[0]));
    } catch {
      // not a valid JSON string
    }
  }
  return found.length ? found : undefined;
}

// The model sometimes writes a sentence as a plain string with one "[record id]". Read that as a sentence too.
export function normalizeSentences(items: unknown[], heldIds?: Set<string>): unknown[] {
  return items.map((item) => {
    if (typeof item !== "string") {
      if (item && typeof item === "object" && typeof (item as any).text === "string") {
        return { ...(item as any), text: stripSourceLabel((item as any).text, heldIds) };
      }
      return item;
    }
    const brackets = [...item.matchAll(/\[([^\[\]]+)\]/g)];
    if (brackets.length !== 1) {
      if (!heldIds) return item;
      const named = [...heldIds].filter((id) => {
        const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`(?<![A-Za-z0-9-])${escapedId}(?![A-Za-z0-9-])`).test(item);
      });
      if (named.length !== 1) return item;
      const id = named[0];
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const text = stripSourceLabel(item, heldIds)
        .replace(
          new RegExp(
            `,?\\s*(?:as recorded in\\s+(?:Payment|Order|Shipping|Dispute|Capture|Tracking)\\s+|record(?:\\s+id)?\\s+|\\(\\s*(?:record\\s+|ID\\s*:\\s*))${escaped}\\s*\\)?\\.?\\s*$`,
            "i",
          ),
          "",
        )
        .replace(new RegExp(`\\s*${escaped}\\s*[.!?]?\\s*$`, "i"), "")
        .replace(/[,:;]\s*$/, "")
        .replace(/\s+/g, " ")
        .replace(/\s+([,.!?])/g, "$1")
        .trim();
      if (!text) return item;
      return { text: /[.!?]$/.test(text) ? text : `${text}.`, record_id: id };
    }
    const m = brackets[0];
    let before = item.slice(0, m.index);
    const after = item.slice(m.index + m[0].length);
    if (/^\s*[.!?]?\s*$/.test(after)) before = before.replace(/,\s*(?:record(?:\s+id)?|id)\s*:?\s*$/i, "");
    const text = stripSourceLabel(
      (before + after)
        .replace(/[,:;]\s*(?=[.!?]?\s*$)/, "")
        .replace(/\s+/g, " ")
        .replace(/\s+([,.!?])/g, "$1")
        .trim(),
      heldIds,
    );
    return { text: /[.!?]$/.test(text) ? text : `${text}.`, record_id: m[1].trim() };
  });
}

function stripSourceLabel(input: string, heldIds?: Set<string>): string {
  const id = "[A-Za-z0-9][A-Za-z0-9-]*";
  const types = `(?:Payment|Order|Shipping|Dispute|Capture|Tracking|the record)(?:\\s+${id})?`;
  const held = [...(heldIds ?? [])].map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const source = held.length ? `(?:${types}|${held.join("|")})` : types;
  const label = new RegExp(
    `,\\s*(?:as shown in|as stated in|as recorded in|as seen in|as noted in|according to|per)\\s+${source}[.!?]*\\s*$`,
    "i",
  );
  if (!label.test(input)) return input;
  return `${input
    .replace(label, "")
    .trimEnd()
    .replace(/[.!?]+$/, "")}.`;
}

// The buyer's own words stay on screen but never reach the writer or the number check: a seller sentence may not
// restate the buyer's claim as a fact, nor borrow a number the buyer typed.
export function sellerFacts(summary: string) {
  return summary.replace(/\. The buyer wrote: ".*"$/s, "");
}

function defaultTools(reason: string): ToolName[] {
  return reason === "MERCHANDISE_OR_SERVICE_NOT_RECEIVED" ? ["get_order", "get_tracking"] : ["get_order"];
}

export async function runAgent(disputeId: string, deps: AgentDeps): Promise<AgentRun> {
  const steps: ToolStep[] = [];
  const records: EvidenceRecord[] = [];
  const usage = { prompt_tokens: 0, completion_tokens: 0, calls: 0 };
  let addedByRule: ToolName[] = [];
  let reasonForTools = "unknown";

  async function step<T>(tool: string, ref: string, fn: () => Promise<T>, describe: (v: T) => string) {
    const t0 = Date.now();
    try {
      const v = await fn();
      const s = { tool, ref, ok: true, summary: describe(v), ms: Date.now() - t0 };
      steps.push(s);
      await deps.onStep?.(s);
      return v;
    } catch (e) {
      const s = { tool, ref, ok: false, summary: String((e as Error).message || e), ms: Date.now() - t0 };
      steps.push(s);
      await deps.onStep?.(s);
      return undefined;
    }
  }

  async function ask(messages: ModelMessage[], kind: CallKind) {
    if (!deps.model) return undefined;
    try {
      const r = await deps.model(boundMessages(messages, kind), kind);
      usage.calls += 1;
      usage.prompt_tokens += r.usage?.prompt_tokens ?? 0;
      usage.completion_tokens += r.usage?.completion_tokens ?? 0;
      return r.text;
    } catch {
      return undefined;
    }
  }

  // 1. The dispute and the payment it is about: always needed.
  const d = await step(
    "get_dispute",
    disputeId,
    () => deps.getDispute(disputeId),
    (d: any) =>
      `${plain(d.reason)}, ${plain(d.status)}, ${money(d.dispute_amount?.value ?? 0, d.dispute_amount?.currency_code)}`,
  );
  if (!d) throw new Error(`dispute ${disputeId} could not be read`);
  reasonForTools = d.reason;
  const buyerNote = (d.evidences ?? []).find((e: any) => e.source === "SUBMITTED_BY_BUYER")?.notes ?? "";
  const amount = d.dispute_amount?.value ?? "0";
  const currency = d.dispute_amount?.currency_code ?? "USD";
  records.push({
    id: d.dispute_id,
    kind: "dispute",
    facts: { amount: Number(amount), currency, dates: [d.create_time].filter(Boolean) },
    summary:
      `Dispute ${d.dispute_id}: reason ${d.reason}, ${money(amount, currency)}, opened ${day(d.create_time)}` +
      (buyerNote ? `. The buyer wrote: "${buyerNote}"` : ""),
  });

  const captureId = d.disputed_transactions?.[0]?.seller_transaction_id;
  const captureResult = captureId
    ? await step(
        "get_capture",
        captureId,
        () => deps.getCapture(captureId),
        (c: any) => `${c.status}, ${money(c.amount?.value ?? 0, c.amount?.currency_code)}`,
      )
    : undefined;
  const cap = captureResult?.id ? captureResult : undefined;
  if (cap) {
    records.push({
      id: cap.id,
      kind: "capture",
      facts: {
        amount: Number(cap.amount?.value),
        currency: cap.amount?.currency_code,
        dates: [cap.create_time].filter(Boolean),
        status: cap.status,
        unpaid: ["FAILED", "DENIED", "DECLINED"].includes(cap.status),
      },
      summary:
        cap.status === "COMPLETED"
          ? `Payment ${cap.id}: ${money(cap.amount?.value, cap.amount?.currency_code)} paid on ${day(cap.create_time)}`
          : `Payment ${cap.id}: ${money(cap.amount?.value, cap.amount?.currency_code)}, status ${cap.status ?? "unknown"}`,
    });
  }

  // 2. The model picks which other records could answer the reason.
  const pick = await ask(
    [
      {
        role: "system",
        content:
          "You help a small online seller answer a PayPal dispute. The dispute and the payment are loaded. Tools: " +
          "get_order (the item and the shipping address), get_tracking (carrier, tracking number, delivery status), " +
          'get_invoice (the invoice, if one was sent). Reply with JSON only, like {"tools": ["get_order"]}, ' +
          "naming the tools whose records could answer the buyer's reason.",
      },
      { role: "user", content: records.map((r) => r.summary).join("\n") },
    ],
    "toolChoice",
  );
  const picked = firstJson(pick ?? "")?.tools;
  const modelChosen: ToolName[] = Array.isArray(picked)
    ? (picked.filter((t: unknown) => (TOOLS as readonly unknown[]).includes(t)) as ToolName[])
    : [];
  const required = defaultTools(d.reason);
  const chosen = [...new Set([...(modelChosen.length ? modelChosen : required), ...required])];
  addedByRule = required.filter((tool) => !modelChosen.includes(tool));

  const orderId = cap?.supplementary_data?.related_ids?.order_id;
  let order: any;
  let tracker: any;
  let deliveredAt: string | undefined;
  let deliverySource: "paypal" | "seller" | undefined;
  let paypalTrackingStatus: string | undefined;
  let orderRead: CaseFacts["orderRead"] = "none";
  let trackingRead: CaseFacts["trackingRead"] = "none";
  let trackingId: string | undefined;
  const wantsTracking = chosen.includes("get_tracking");
  if ((chosen.includes("get_order") || wantsTracking) && orderId) {
    order = await step(
      "get_order",
      orderId,
      () => deps.getOrder(orderId),
      (o: any) => `${o.status}, ${o.purchase_units?.[0]?.description ?? "no description"}`,
    );
    orderRead = order?.id ? "ok" : "failed";
    if (order && chosen.includes("get_order")) {
      const pu = order.purchase_units?.[0] ?? {};
      const a = pu.shipping?.address ?? {};
      const where = [a.admin_area_2, a.admin_area_1, a.country_code].filter(Boolean).join(", ");
      records.push({
        id: order.id,
        kind: "order",
        facts: {
          ...summaryFacts(`${pu.description ?? "an item"}, ${where}`),
          item: pu.description ?? "an item",
          shipTo: where,
        },
        summary:
          `Order ${order.id}: ${pu.description ?? "an item"}` +
          (where ? `, shipping to ${where}` : ", no shipping address"),
      });
    }
  } else if (chosen.includes("get_order") || wantsTracking) {
    orderRead = "failed";
    const missingOrder = {
      tool: "get_order",
      ref: "",
      ok: false,
      summary: "No order id on the payment",
      ms: 0,
    };
    steps.push(missingOrder);
    await deps.onStep?.(missingOrder);
  }
  if (wantsTracking || order?.purchase_units?.[0]?.shipping?.trackers?.length) {
    if (orderId && !order) trackingRead = "failed";
    const tid = order?.purchase_units?.[0]?.shipping?.trackers?.at(-1)?.id;
    if (tid) {
      trackingId = tid;
      trackingRead = "failed";
      tracker = await step(
        "get_tracking",
        tid,
        () => deps.getTracker(tid),
        (t: any) => `${t.carrier} ${t.status}`,
      );
      if (tracker && typeof tracker.status === "string") {
        trackingRead = "ok";
        // The seller's shipping record holds the delivery time. PayPal's tracker can read SHIPPED again after the
        // evidence is filed (seen 23 Oct), so the record's time counts whatever the tracker's status says now.
        try {
          // Only a time in the tracker itself can have PayPal provenance.
          deliveredAt = tracker.delivered_at;
          deliverySource = deliveredAt ? "paypal" : undefined;
          if (!deliveredAt) {
            deliveredAt = await deps.deliveredAt(tid);
            if (deliveredAt) deliverySource = "seller";
          }
        } catch (error) {
          trackingRead = "failed";
          steps.push({ tool: "get_delivery_date", ref: tid, ok: false, summary: String(error), ms: 0 });
        }
        const paypalStatus = tracker.status;
        paypalTrackingStatus = paypalStatus;
        records.push({
          id: tid,
          kind: "tracking",
          facts: {
            status: tracker.status,
            statusSource: "paypal",
            deliverySource,
            deliveredAt,
            carrier: tracker.carrier,
            trackingNumber: tracker.tracking_number,
            dates: deliveredAt ? [deliveredAt] : [],
            numbers: deliveredAt ? (when(deliveredAt).slice(11).match(/\d+/g) ?? []).map(Number) : [],
          },
          summary:
            `Tracking ${tid}: ${tracker.carrier} number ${tracker.tracking_number}, status ${paypalStatus} on PayPal` +
            (deliveredAt
              ? `, delivered ${when(deliveredAt)} by ${deliverySource === "seller" ? "our shipping record" : "PayPal tracking"}`
              : ""),
        });
      } else {
        tracker = undefined;
      }
    } else {
      const custom = d.disputed_transactions?.[0]?.custom;
      const ship =
        custom && deps.shipment
          ? await step(
              "get_tracking",
              `ship-${custom}`,
              async () => deps.shipment!(custom),
              (x) =>
                x
                  ? `${x.carrier} ${x.delivered_at ? "DELIVERED" : "SHIPPED"}, from the seller's shipping record`
                  : "no shipping record",
            )
          : undefined;
      if (ship) {
        trackingRead = "ok";
        trackingId = `ship-${custom}`;
        tracker = {
          carrier: ship.carrier,
          tracking_number: ship.tracking_number,
          status: ship.delivered_at ? "DELIVERED" : "SHIPPED",
        };
        deliveredAt = ship.delivered_at ?? undefined;
        deliverySource = "seller";
        records.push({
          id: `ship-${custom}`,
          kind: "tracking",
          facts: {
            status: tracker.status,
            statusSource: "seller",
            deliverySource,
            deliveredAt,
            carrier: ship.carrier,
            trackingNumber: ship.tracking_number,
            dates: deliveredAt ? [deliveredAt] : [],
            numbers: deliveredAt ? (when(deliveredAt).slice(11).match(/\d+/g) ?? []).map(Number) : [],
          },
          summary:
            `Shipping record ship-${custom}: ${ship.carrier} number ${ship.tracking_number}, status ${tracker.status}` +
            (deliveredAt ? `, delivered ${when(deliveredAt)}` : ""),
        });
      } else if (!custom || !deps.shipment) {
        steps.push({
          tool: "get_tracking",
          ref: orderId ?? "",
          ok: true,
          summary: "no tracking on this order",
          ms: 0,
        });
      }
      if (steps.some((s) => s.tool === "get_tracking" && !s.ok)) trackingRead = "failed";
    }
  }
  if (chosen.includes("get_invoice")) {
    // This desk's sales are checkout orders, not PayPal invoices, so there is no invoice record to cite.
    steps.push({ tool: "get_invoice", ref: "", ok: true, summary: "no invoice for this sale", ms: 0 });
  }
  for (const tool of addedByRule) {
    const need = tool === "get_tracking" ? "tracking" : "an order";
    steps.push({
      tool,
      ref: "",
      ok: true,
      summary: `added by the rule: ${plain(reasonForTools)} needs ${need}`,
      ms: 0,
    });
  }

  // 3. Code decides.
  const facts: CaseFacts = {
    reason: d.reason,
    amount: Number(amount),
    currency,
    claimAt: d.create_time,
    tracking: tracker
      ? {
          status: tracker.status,
          deliveredAt,
          deliverySource,
          statusSource: paypalTrackingStatus ? "paypal" : "seller",
          carrier: tracker.carrier,
          number: tracker.tracking_number,
        }
      : undefined,
    hasOrder: !!order,
    hasCapture: !!cap,
    captureRead: cap ? "ok" : "failed",
    orderRead,
    trackingRead,
    paypalTrackingStatus,
    paymentAmount: cap?.amount?.value != null ? Number(cap.amount.value) : undefined,
    paymentCurrency: cap?.amount?.currency_code,
    paymentStatus: cap?.status,
    disputeId: d.dispute_id,
    captureId,
    trackingId,
  };
  const first = decide(facts, deps.policy);
  records.find((r) => r.kind === "dispute")!.decision = first;

  // 4. The model chooses fact ids. Its prose is never a draft input.
  const ids = new Set(records.map((r) => r.id));
  const available = sentenceFacts(first, records);
  const writerMessages: Parameters<ModelFn>[0] = [
    {
      role: "system",
      content:
        `Select facts for the seller's response. Verdict: ${first.verdict}. Reason: ${first.why}\n` +
        "Pick 2 to 4 listed fact ids in the order that best answers the buyer's claim. Code writes every line. " +
        'Reply with JSON only: {"facts":["F2","F1"]}',
    },
    { role: "user", content: available.map((f) => `${f.id} [${f.record_id}]: ${f.text}`).join("\n") },
  ];
  let written = await ask(writerMessages, "writer");
  const firstWritten = written;
  const dropped: Sentence[] = [];
  const read = (reply: string | undefined): string[] | undefined => {
    const parsed = firstJson(reply ?? "");
    // Preserve rejected old prose for inspection, never for rendering or the filing note.
    const old = parsed?.sentences ?? sentenceObjects(reply ?? "") ?? sentenceStrings(reply ?? "");
    if (Array.isArray(old)) {
      const rejected = dropUnbacked(normalizeSentences(old, ids), new Set<string>());
      for (const s of rejected.dropped)
        if (!dropped.some((d) => d.text === s.text && d.record_id === s.record_id)) dropped.push(s);
    }
    if (Array.isArray(parsed?.facts)) {
      for (const id of parsed.facts) {
        if (typeof id === "string" && !available.some(fact => fact.id === id) && !dropped.some(line => line.record_id === id))
          dropped.push({ text: `${id} is not a listed fact`, record_id: id });
      }
    }
    return Array.isArray(parsed?.facts) &&
      parsed.facts.length >= 2 &&
      parsed.facts.length <= 4 &&
      parsed.facts.every((id: unknown) => typeof id === "string" && available.some(fact => fact.id === id))
      ? parsed.facts
      : undefined;
  };
  let readable = read(written);
  if (!readable && deps.model) {
    written = await ask(
      [
        ...writerMessages,
        {
          role: "user",
          content: 'Reply with JSON only, with 2 to 4 listed fact ids: {"facts":["F2","F1"]}',
        },
      ],
      "writerRetry",
    );
    readable = read(written);
  }
  let writer: AgentRun["writer"] = readable ? "model" : "template";
  const template = (decision: Decision) => templateSentences(decision, records, (bad) => dropped.push(...bad));
  let sentences = readable ? renderSelection(first, available, readable, records, dropped) : template(first);
  if (!sentences.some(sentence => sentence.text.trim())) {
    sentences = template(first);
    writer = "template";
  }
  const decision = finalDecision(first, sentences, facts, deps.policy);
  if (decision.verdict !== first.verdict) {
    records.find((r) => r.kind === "dispute")!.decision = decision;
    sentences = template(decision);
    writer = "template";
  }
  records.find((r) => r.kind === "dispute")!.decision = decision;

  const rawWriter = (firstWritten === written ? written : `${firstWritten}\nRetry:\n${written ?? "No reply"}`)?.slice(
    0,
    2000,
  );
  return {
    disputeId,
    decision,
    sentences,
    dropped,
    records,
    steps,
    writer,
    selected: readable,
    rawWriter,
    chosenTools: chosen,
    usage,
  };
}

// Check amounts, currencies, dates, payment and delivery against the cited record's typed facts.
export function dropUnsupportedNumbers(kept: Sentence[], records: EvidenceRecord[], modelOnly = false) {
  const byId = new Map(records.map((r) => [r.id, r]));
  const ok: Sentence[] = [];
  const bad: Sentence[] = [];
  for (const s of kept) {
    const record = byId.get(s.record_id);
    (record && supportedSentence(s.text, record, modelOnly) ? ok : bad).push(s);
  }
  return { ok, bad };
}

export function templateSentences(
  dec: Decision,
  records: EvidenceRecord[],
  onDropped?: (bad: Sentence[]) => void,
): Sentence[] {
  const available = sentenceFacts(dec, records);
  // Retain the familiar template facts; the claim date is available for a model selection.
  const picks = available.filter((f) => f.kind !== "claim" && (f.kind !== "order" || dec.verdict === "FIGHT"));
  const dropped: Sentence[] = [];
  const out = renderSelection(
    dec,
    available,
    picks.map((f) => f.id),
    records,
    dropped,
  );
  onDropped?.(dropped);
  return out;
}

export interface SentenceFact extends Sentence {
  id: string;
  kind: "payment" | "tracking" | "delivery" | "order" | "claim" | "acceptance";
}

export function sentenceFacts(decision: Decision, records: EvidenceRecord[]): SentenceFact[] {
  const facts: SentenceFact[] = [];
  for (const kind of ["capture", "tracking", "order", "dispute"] as const) {
    for (const record of records.filter((r) => r.kind === kind)) {
      for (const text of codeFactSentences(kind === "dispute" ? { ...record, decision } : record)) {
        facts.push({
          id: `F${facts.length + 1}`,
          record_id: record.id,
          text,
          kind:
            kind === "capture"
              ? "payment"
              : kind === "tracking"
                ? text.includes("shows it delivered")
                  ? "delivery"
                  : "tracking"
                : kind === "order"
                  ? "order"
                  : text.startsWith("We accept")
                    ? "acceptance"
                    : "claim",
        });
      }
    }
  }
  return facts;
}

function renderSelection(
  decision: Decision,
  facts: SentenceFact[],
  picks: string[],
  records: EvidenceRecord[],
  dropped: Sentence[],
): Sentence[] {
  const required = facts.filter((f) =>
    decision.verdict === "FIGHT"
      ? f.kind === "delivery"
      : decision.verdict === "ACCEPT" && (f.kind === "payment" || f.kind === "acceptance"),
  );
  const selected = [...required];
  for (const id of picks) {
    const fact = facts.find((f) => f.id === id);
    if (!fact) dropped.push({ text: `${id} is not a listed fact`, record_id: id });
    else if (!selected.some((f) => f.id === id)) selected.push(fact);
  }
  const checked = dropUnsupportedNumbers(
    selected.map(({ text, record_id }) => ({ text, record_id })),
    records.map((r) => (r.kind === "dispute" ? { ...r, decision } : r)),
  );
  dropped.push(...checked.bad);
  return checked.ok
    .filter((s, i, all) => all.findIndex((other) => other.text === s.text && other.record_id === s.record_id) === i)
    .slice(0, 4);
}
