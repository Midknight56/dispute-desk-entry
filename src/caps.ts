// A judge is a free user and must never cost money. Workers AI's free day is 10,000 neurons for the whole
// Cloudflare account, shared by the hackathon apps through the ledger database (table ai_calls).
export const MAX_RUNS_PER_VISITOR_PER_DAY = 20;
export const MAX_RUNS_PER_DAY = 100;
export const APP_NEURONS_PER_DAY = 700;
export const ACCOUNT_NEURONS_PER_DAY = 9_000;
// Historical measured size, retained for checkCaps and the usage display only, never for reservations.
export const NEURONS_PER_RUN_ESTIMATE = 7;

// A token is never fewer than one character: bound input tokens by message characters
// plus 64 tokens for the chat template. Never cut system rules to meet these caps.
export const CHAT_TEMPLATE_TOKENS = 64;
export const TOOL_CHOICE_INPUT_CHARACTERS = 1536;
export const WRITER_INPUT_CHARACTERS = 3072;
export const WRITER_RETRY_INPUT_CHARACTERS = 4096;
export const ASK_INPUT_CHARACTERS = 640;
// Tool choice: one JSON list of at most three tool names.
export const TOOL_CHOICE_MAX_TOKENS = 64;
// Writer and retry: one JSON list of 2 to 4 short fact ids.
export const WRITER_MAX_TOKENS = 64;
export const WRITER_RETRY_MAX_TOKENS = 64;
// Ask: four fixed chart fields in a single JSON object.
export const ASK_MAX_TOKENS = 128;
export const MODEL_BOUNDS = {
  toolChoice: { characters: TOOL_CHOICE_INPUT_CHARACTERS, maxTokens: TOOL_CHOICE_MAX_TOKENS },
  writer: { characters: WRITER_INPUT_CHARACTERS, maxTokens: WRITER_MAX_TOKENS },
  writerRetry: { characters: WRITER_RETRY_INPUT_CHARACTERS, maxTokens: WRITER_RETRY_MAX_TOKENS },
  ask: { characters: ASK_INPUT_CHARACTERS, maxTokens: ASK_MAX_TOKENS },
} as const;
export type CallKind = keyof typeof MODEL_BOUNDS;
export type ModelMessage = { role: "system" | "user"; content: string };

export function boundMessages(messages: ModelMessage[], kind: CallKind): ModelMessage[] {
  const cap = MODEL_BOUNDS[kind].characters;
  if (messages.reduce((n, m) => n + m.content.length, 0) <= cap) return messages;
  const marker = "(more records left out)";
  let remaining = cap - messages.filter((m) => m.role === "system").reduce((n, m) => n + m.content.length, 0);
  if (remaining < marker.length) throw new Error("System rules exceed the message budget");
  // Keep complete record lines. The cut marker is included in the total character budget.
  remaining -= marker.length;
  let cut = false;
  const bounded = messages.map((m): ModelMessage => {
    if (m.role === "system") return m;
    const lines: string[] = [];
    for (const line of m.content.split("\n")) {
      const size = line.length + (lines.length ? 1 : 0);
      if (cut || size > remaining) {
        cut = true;
        break;
      }
      lines.push(line);
      remaining -= size;
    }
    return { ...m, content: lines.join("\n") };
  });
  // No extra separator character: its cost is already covered by the marker reservation.
  const lastUser = bounded.map((m) => m.role).lastIndexOf("user");
  if (lastUser < 0) throw new Error("System rules exceed the message budget");
  bounded[lastUser].content += marker;
  return bounded;
}

// Per call: ceil(((characters + 64) * 4625 + maxTokens * 30475) / 1M, to 0.01).
const callMax = (kind: CallKind) =>
  neuronsFor({
    prompt_tokens: MODEL_BOUNDS[kind].characters + CHAT_TEMPLATE_TOKENS,
    completion_tokens: MODEL_BOUNDS[kind].maxTokens,
  });
// Analyse: neuronsFor(1600, 64) + neuronsFor(3136, 64) + neuronsFor(4160, 64)
// = 9.36 + 16.46 + 21.20 = 47.02 neurons, including one writer retry.
export const NEURONS_PER_RUN_MAX =
  Math.round((callMax("toolChoice") + callMax("writer") + callMax("writerRetry")) * 100) / 100;
// Ask: neuronsFor(704, 128) = 7.16 neurons.
export const NEURONS_PER_ASK_MAX = callMax("ask");
// Free visitor cost: $0. App day <= 700; account day <= 9,000 < the free 10,000 neurons/day.

export interface CapUsage {
  visitorRuns: number;
  dayRuns: number;
  appNeurons: number;
  accountNeurons: number;
}

export type CapResult =
  { ok: true } | { ok: false; reason: "VISITOR" | "DAY" | "APP_NEURONS" | "ACCOUNT_NEURONS"; message: string };

export function checkCaps(u: CapUsage, estimate = NEURONS_PER_RUN_ESTIMATE): CapResult {
  if (u.visitorRuns >= MAX_RUNS_PER_VISITOR_PER_DAY) {
    return {
      ok: false,
      reason: "VISITOR",
      message: "You have used today's 20 live runs. Here is the recorded run instead.",
    };
  }
  if (u.dayRuns >= MAX_RUNS_PER_DAY) {
    return {
      ok: false,
      reason: "DAY",
      message: "The app has used today's 100 live runs. Here is the recorded run instead.",
    };
  }
  if (u.appNeurons + estimate > APP_NEURONS_PER_DAY) {
    return {
      ok: false,
      reason: "APP_NEURONS",
      message: "The app has used its neuron allowance. Here is the recorded run instead.",
    };
  }
  if (u.accountNeurons + estimate > ACCOUNT_NEURONS_PER_DAY) {
    return {
      ok: false,
      reason: "ACCOUNT_NEURONS",
      message: "The account has used its neuron allowance. Here is the recorded run instead.",
    };
  }
  return { ok: true };
}

// Rates for @cf/meta/llama-3.2-3b-instruct, Cloudflare Workers AI pricing page; checked again when the number is measured.
export function neuronsFor(usage: { prompt_tokens?: number; completion_tokens?: number }): number {
  const input = usage.prompt_tokens ?? 0;
  const output = usage.completion_tokens ?? 0;
  return Math.ceil(((input * 4_625 + output * 30_475) / 1_000_000) * 100) / 100;
}
