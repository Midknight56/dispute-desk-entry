import { formatMoney, type Decision } from "./rules";

// Typed source facts are attached when records are read. Older saved records are parsed at this boundary.
export interface RecordFacts {
  amount?: number;
  currency?: string;
  dates?: string[];
  status?: string;
  trackingNumber?: string;
  numbers?: number[];
  unpaid?: boolean;
  deliverySource?: "paypal" | "seller";
  deliveredAt?: string;
  carrier?: string;
  item?: string;
  shipTo?: string;
  statusSource?: "paypal" | "seller";
}

type FactRecord = { id: string; kind: string; summary: string; facts?: RecordFacts; decision?: Decision };

// Only code supplies these consequential claims. Exact copies may also survive the writer's check.
export function codeFactSentences(record: FactRecord): string[] {
  const facts = record.facts ?? summaryFacts(record.summary);
  if (record.kind === "capture" && facts.amount != null && facts.currency) {
    const amount = formatMoney(facts.amount, facts.currency);
    if (facts.status === "COMPLETED" || (!facts.status && / paid on /.test(record.summary)))
      return [`The buyer paid ${amount}${facts.dates?.[0] ? ` on ${facts.dates[0].slice(0, 10)}` : ""}.`];
    if (facts.status)
      return [`PayPal lists the payment of ${amount} as ${facts.status.toLowerCase().replace(/_/g, " ")}.`];
  }
  if (record.kind === "tracking") {
    const sellerStatus = facts.statusSource === "seller" || record.id.startsWith("ship-");
    const source = facts.deliverySource === "paypal" ? "PayPal tracking shows" : "Our shipping record shows";
    const date = facts.deliveredAt;
    const time = date ? new Date(date) : undefined;
    const stamp =
      time && Number.isFinite(time.getTime())
        ? `${time.toISOString().slice(0, 10)} ${time.toISOString().slice(11, 16)} UTC`
        : undefined;
    const carrier = facts.carrier ?? /: (.*?) number /.exec(record.summary)?.[1];
    const tracking = facts.status
      ? `${sellerStatus ? "Our shipping record" : "The tracking record"} shows ${carrier ? `${carrier} ` : ""}${facts.trackingNumber ? `number ${facts.trackingNumber}, ` : ""}status ${facts.status.replace(/_/g, " ")}${sellerStatus ? "" : " on PayPal"}.`
      : undefined;
    return [...(tracking ? [tracking] : []), ...(stamp ? [`${source} it delivered ${stamp}.`] : [])];
  }
  if (record.kind === "order") {
    const item = facts.item ?? /^Order \S+: (.*?)(?:, shipping to |, no shipping address|$)/.exec(record.summary)?.[1];
    const shipTo = facts.shipTo ?? /, shipping to (.*)$/.exec(record.summary)?.[1];
    return item ? [`The order was ${item}${shipTo ? `, shipping to ${shipTo}` : ", no shipping address"}.`] : [];
  }
  if (record.kind === "dispute")
    return [
      ...(record.decision?.verdict === "ACCEPT" ? ["We accept the claim and refund in full."] : []),
      ...(facts.dates?.[0] ? [`The claim opened on ${facts.dates[0].slice(0, 10)}.`] : []),
    ];
  return [];
}

const currencyCodes = Intl.supportedValuesOf("currency").join("|");
const currencyPattern = `\\b(?:${currencyCodes})\\b|\\$|€|£|¥|â‚¬|Â£|Â¥`;
const currencies = new RegExp(currencyPattern, "g");
const moneyPattern = new RegExp(`([+-]?)\\s*(?:${currencyPattern})\\s*([+-]?\\d+(?:,\\d{3})*(?:\\.\\d+)?)`, "g");
const currencyCode = (token: string) =>
  ({ $: "USD", "€": "EUR", "â‚¬": "EUR", "£": "GBP", "Â£": "GBP", "¥": "JPY", "Â¥": "JPY" })[token] ??
  token.toUpperCase();
const unpaidClaim = /\b(?:never paid|did not pay|didn't pay|unpaid|payment (?:has )?failed|no payment)\b/i;
const consequentialClaim =
  /\b(?:refund\w*|revers\w*|cancel\w*|withdraw\w*|withdrew|withdrawn|agree\w*|consent\w*|chargeback\w*|fraud\w*|accept\w*|offer\w*|fight\w*|paid\s+(?:nothing|zero|less)|pa(?:id|y)\s+(?:\$?0(?:\.0+)?)(?![\d.]))\b/i;
const paymentStatusClaim = /\b(?:pending|completed|declined|failed|denied)\b/i;
const modelPaymentStatusClaim =
  /\b(?:successful|successfully|completed|complete|pending|failed|declined|cleared|settled|went through|made the payment|payment(?:\s+\w+){0,3}\s+(?:was|is)\s+made)\b/i;
const anchorStopWords = new Set(
  "a an and as at by for from in of on or the to with is was were our pay payment order item record status shipping number tracking".split(
    " ",
  ),
);

function hasRecordValue(text: string, summary: string): boolean {
  const source = summary.replace(/^[^:]+:\s*/, "");
  const sourceValues = new Set((source.match(/\b\d+(?:[.,]\d+)*\b/g) ?? []).map((value) => value.replace(/,/g, "")));
  if ((text.match(/\b\d+(?:[.,]\d+)*\b/g) ?? []).some((value) => sourceValues.has(value.replace(/,/g, ""))))
    return true;
  const sourceWords = new Set(
    (source.toLowerCase().match(/(?<![a-z0-9])[a-z][a-z0-9'-]*/g) ?? []).filter(
      (word) => !anchorStopWords.has(word) && word.length > 1,
    ),
  );
  return (text.toLowerCase().match(/(?<![a-z0-9])[a-z][a-z0-9'-]*/g) ?? []).some((word) => sourceWords.has(word));
}

export function consequentialSentence(text: string): boolean {
  return (
    consequentialClaim.test(text) ||
    unpaidClaim.test(text) ||
    paymentStatusClaim.test(text) ||
    /\b(?:deliver(?:y|ed|ies)|received)\b/i.test(text)
  );
}
const tokens = (text: string) => text.match(/(?<![A-Za-z0-9])[+-]?[A-Za-z0-9]+(?:[.,]\d+)*\b/g) ?? [];
const numeric = (token: string) => /^[+-]?\d+(?:[.,]\d+)*$/.test(token);
const value = (token: string) => Number(token.replace(/,/g, ""));

function calendarDay(year: number, month: number, day: number): string | undefined {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date.toISOString().slice(0, 10)
    : undefined;
}

function datesIn(text: string) {
  const dates: string[] = [];
  let valid = true;
  const remove = (_match: string, y: string, m: string, d: string) => {
    const date = calendarDay(Number(y), Number(m), Number(d));
    if (date) dates.push(date);
    else valid = false;
    return " ";
  };
  let rest = text.replace(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, remove);
  rest = rest.replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, (all, m, d, y) => remove(all, y, m, d));
  const months = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];
  const month = "(January|February|March|April|May|June|July|August|September|October|November|December)";
  rest = rest.replace(new RegExp(`\\b${month} (\\d{1,2})(?:st|nd|rd|th)?,? (\\d{4})\\b`, "gi"), (all, m, d, y) =>
    remove(all, y, String(months.indexOf(m.toLowerCase()) + 1), d),
  );
  rest = rest.replace(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)? ${month},? (\\d{4})\\b`, "gi"), (all, d, m, y) =>
    remove(all, y, String(months.indexOf(m.toLowerCase()) + 1), d),
  );
  return { dates, valid, rest };
}

export function summaryFacts(summary: string): RecordFacts {
  const dates = datesIn(summary);
  const trackingNumber = /\bnumber\s+([A-Za-z0-9-]+)/i.exec(summary)?.[1];
  const money = [...summary.matchAll(moneyPattern)][0];
  const code = summary.match(currencies)?.[0];
  return {
    amount: money ? value(`${money[1]}${money[2]}`) : undefined,
    currency: code ? currencyCode(code) : undefined,
    dates: dates.dates,
    status: /\bstatus\s+(\w+)/i.exec(summary)?.[1]?.toUpperCase(),
    trackingNumber,
    numbers: tokens(dates.rest)
      .filter((token) => numeric(token) && token !== trackingNumber)
      .map(value),
    unpaid: unpaidClaim.test(summary),
  };
}

export function supportedSentence(text: string, record: FactRecord, modelOnly = false): boolean {
  if (/\b[A-Z]+(?:_[A-Z]+)+\b/.test(text)) return false;
  const summary = record.summary.replace(/\. The buyer wrote: ".*"$/s, "").replace(/^[^:]+:\s*/, "");
  const facts = record.facts ?? summaryFacts(summary);
  const codeWritten =
    codeFactSentences(record).includes(text) ||
    (record.kind === "capture" &&
      (facts.status === "COMPLETED" || (!facts.status && / paid on /.test(record.summary))) &&
      facts.amount != null &&
      !!facts.currency &&
      text === `The buyer paid ${formatMoney(facts.amount, facts.currency)}.`) ||
    (text === "The payment failed." && record.kind === "capture" && facts.status === "FAILED" && facts.unpaid === true);
  // A matching amount or word cannot license an extra clause. Stored prose must match an approved line too.
  if (!codeWritten) return false;
  if (modelOnly && modelPaymentStatusClaim.test(text)) return false;
  if ((consequentialClaim.test(text) || unpaidClaim.test(text) || paymentStatusClaim.test(text)) && !codeWritten)
    return false;
  if (modelOnly && !hasRecordValue(text, summary)) return false;
  if (
    /\b(?:our|the seller's|our own) shipping record\b/i.test(text) &&
    !record.id.startsWith("ship-") &&
    !(record.kind === "tracking" && facts.deliverySource === "seller")
  )
    return false;
  if (unpaidClaim.test(text) && (facts.status === "COMPLETED" || !facts.unpaid)) return false;
  const trackingStatus = record.kind === "tracking" && !!facts.status && text === codeFactSentences(record)[0];
  if (/\b(?:deliver(?:y|ed|ies)|received)\b/i.test(text) && !trackingStatus) {
    if (
      record.kind !== "tracking" ||
      (facts.status !== "DELIVERED" && !(facts.deliverySource === "seller" && facts.deliveredAt))
    )
      return false;
    if (
      (record.id.startsWith("ship-") || facts.deliverySource === "seller") &&
      !/\b(?:our(?: own)?|(?:the )?seller'?s(?: own)?) shipping record\b/i.test(text)
    )
      return false;
  }
  if ((text.match(currencies) ?? []).some((c) => currencyCode(c) !== facts.currency?.toUpperCase())) return false;
  const sentenceDates = datesIn(text);
  const recordDates = (facts.dates ?? []).map((d) => d.slice(0, 10));
  if (!sentenceDates.valid || sentenceDates.dates.some((d) => !recordDates.includes(d))) return false;
  // Explicit money compares with the amount, never with a date or tracking token.
  if ([...text.matchAll(moneyPattern)].some((m) => value(`${m[1]}${m[2]}`) !== facts.amount)) return false;
  const trackingClaims = [
    ...text.matchAll(/\b(?:tracking number|number)\s+([A-Za-z0-9-]+)/gi),
    ...text.matchAll(/\b[Tt]racking\s+([A-Z0-9-]+)\b/g),
  ];
  if (trackingClaims.some((m) => !facts.trackingNumber || m[1] !== facts.trackingNumber)) return false;
  const sourceDates = datesIn(summary);
  const sourceTokens = new Set(tokens(sourceDates.rest));
  const numbers = new Set([...(facts.numbers ?? []), ...(facts.amount === undefined ? [] : [facts.amount])]);
  let remainder = sentenceDates.rest;
  if (facts.trackingNumber) {
    const escape = facts.trackingNumber.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    remainder = remainder.replace(new RegExp(`(?<![A-Za-z0-9-])${escape}(?![A-Za-z0-9-])`, "g"), " ");
  }
  return tokens(remainder).every((token) => {
    if (numeric(token)) return numbers.has(value(token));
    return !/\d/.test(token) || sourceTokens.has(token);
  });
}
