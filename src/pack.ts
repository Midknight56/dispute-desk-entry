import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { plain } from "./agent";
import { formatMoney, type Decision } from "./rules";

export type PackInput = {
  disputeId: string;
  amount: number | string;
  currency: string;
  reason: string;
  verdict: string;
  why: string;
  facts?: Decision["facts"];
  missing?: string[];
  changeIf?: string;
  disagreements?: string[];
  sentences: Array<{ text: string; record_id: string }>;
  records: Array<{ id: string; kind: string; summary: string; decision?: Decision }>;
  filed?: { call: string; at: string };
  generatedAt: string;
};

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const LEFT = 54;
const RIGHT = 54;
const TOP = 54;
const FOOTER_RESERVE = 48;
const BODY_SIZE = 10;
const LINE_HEIGHT = 14;
// Ledger light accent and text from web/src/theme.ts (ledger.light).
const LEDGER_TEXT = rgb(0x1d / 255, 0x1d / 255, 0x1b / 255);
const LEDGER_ACCENT = rgb(0x1f / 255, 0x5c / 255, 0x45 / 255);
const COLORS = {
  ink: LEDGER_TEXT,
  muted: rgb(0.38, 0.42, 0.47),
  accent: LEDGER_ACCENT,
};

export function layoutLine(baselineY: number, fontSize: number): { baselineY: number; nextBaselineY: number } {
  return { baselineY, nextBaselineY: baselineY - Math.max(LINE_HEIGHT, fontSize * 1.25) };
}

function safeText(value: string): string {
  return Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0xff && !(code <= 0x1f || (code >= 0x7f && code <= 0x9f)) ? character : "?";
  }).join("");
}

function exhibitLetter(index: number): string {
  let number = index + 1;
  let label = "";
  while (number > 0) {
    number -= 1;
    label = String.fromCharCode(65 + (number % 26)) + label;
    number = Math.floor(number / 26);
  }
  return label;
}

function wrapText(text: string, maxWidth: number, measure: (line: string) => number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const parts: string[] = [];
    let remainder = word;
    while (measure(remainder) > maxWidth) {
      let split = 1;
      while (split < remainder.length && measure(remainder.slice(0, split + 1)) <= maxWidth) split += 1;
      parts.push(remainder.slice(0, split));
      remainder = remainder.slice(split);
    }
    parts.push(remainder);
    for (const part of parts) {
      const candidate = line ? `${line} ${part}` : part;
      if (line && measure(candidate) > maxWidth) {
        lines.push(line);
        line = part;
      } else {
        line = candidate;
      }
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

export async function buildPack(input: PackInput): Promise<Uint8Array> {
  const digestInput = input.sentences.flatMap((sentence) => [sentence.text, sentence.record_id]);
  const digestBytes = new TextEncoder().encode(digestInput.join(""));
  const digest = await crypto.subtle.digest("SHA-256", digestBytes);
  const check = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12);

  const citedIds = Array.from(new Set(input.sentences.map((sentence) => sentence.record_id)));
  const recordById = new Map(input.records.map((record) => [record.id, record]));
  const labelById = new Map(citedIds.map((id, index) => [id, exhibitLetter(index)]));
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pages = [];
  let page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  pages.push(page);
  let y = PAGE_HEIGHT - TOP;

  const addPage = () => {
    page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    pages.push(page);
    y = PAGE_HEIGHT - TOP;
  };
  const ensureSpace = (height: number) => {
    if (y - height < FOOTER_RESERVE) addPage();
  };
  const drawLine = (
    text: string,
    options: { bold?: boolean; size?: number; color?: typeof COLORS.ink; indent?: number } = {},
  ) => {
    const font = options.bold ? bold : regular;
    const size = options.size ?? BODY_SIZE;
    const indent = options.indent ?? 0;
    const clean = safeText(text);
    const maxWidth = PAGE_WIDTH - LEFT - RIGHT - indent;
    const lines = wrapText(clean, maxWidth, (line) => font.widthOfTextAtSize(line, size));
    for (const line of lines) {
      ensureSpace(Math.max(LINE_HEIGHT, size * 1.25));
      const layout = layoutLine(y - size, size);
      page.drawText(line, { x: LEFT + indent, y: layout.baselineY, size, font, color: options.color ?? COLORS.ink });
      y = layout.nextBaselineY + size;
    }
  };

  drawLine("Dispute response", { bold: true, size: 20, color: COLORS.accent });
  drawLine(`Dispute ID: ${input.disputeId}`, { bold: true, size: 12 });
  drawLine(`Amount: ${formatMoney(Number(input.amount), input.currency)}`);
  const reason = plain(input.reason);
  drawLine(`Reason: ${reason.charAt(0).toUpperCase()}${reason.slice(1)}`);
  drawLine(`Verdict: ${input.verdict}`);
  drawLine(`Why: ${input.why}`);
  const decision = input.records.find((record) => record.id === input.disputeId && record.kind === "dispute")?.decision;
  const facts = input.facts ?? decision?.facts ?? [];
  if (facts.length) drawLine("Facts used", { bold: true });
  for (const fact of facts) drawLine(`${fact.label}: ${fact.value}${fact.recordId ? ` [${fact.recordId}]` : ""}`);
  for (const disagreement of input.disagreements ?? decision?.disagreements ?? [])
    drawLine(`Records that disagree: ${disagreement}`);
  for (const missing of input.missing ?? decision?.missing ?? []) drawLine(`Missing: ${missing}`);
  const changeIf = input.changeIf ?? decision?.changeIf;
  if (changeIf) drawLine(`Would change if: ${changeIf}`);
  if (input.filed) drawLine(`Filed: ${input.filed.call} at ${input.filed.at}`);
  y -= 8;

  for (let index = 0; index < input.sentences.length; index += 1) {
    const sentence = input.sentences[index];
    const label = labelById.get(sentence.record_id) ?? "?";
    const text = `${index + 1}. ${sentence.text} [Exhibit ${label}: ${sentence.record_id}]`;
    drawLine(text, { indent: 10 });
    y -= 3;
  }

  for (const id of citedIds) {
    const record = recordById.get(id) ?? { id, kind: "Record", summary: "No record details provided" };
    y -= 8;
    drawLine(`Exhibit ${labelById.get(id)}`, { bold: true, size: 14, color: COLORS.accent });
    drawLine(`Kind: ${record.kind}`);
    drawLine(`ID: ${record.id}`);
    drawLine(`Summary: ${record.summary ?? ""}`);
  }

  const pageCount = pages.length;
  pages.forEach((pdfPage, index) => {
    const footer = `${safeText(input.disputeId)}   page ${index + 1} of ${pageCount}   ${safeText(input.generatedAt)}   check ${check}`;
    pdfPage.drawLine({
      start: { x: LEFT, y: 39 },
      end: { x: PAGE_WIDTH - RIGHT, y: 39 },
      thickness: 0.5,
      color: rgb(0.82, 0.84, 0.87),
    });
    pdfPage.drawText(footer, {
      x: LEFT,
      y: 24,
      size: 8,
      font: regular,
      color: COLORS.muted,
      maxWidth: PAGE_WIDTH - LEFT - RIGHT,
    });
  });

  return pdf.save();
}
