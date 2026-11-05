import fight from "../samples/replay-fight.json";
import accept from "../samples/replay-accept.json";
import { templateSentences, type AgentRun, type EvidenceRecord } from "./agent";
import type { Decision } from "./rules";
import { summaryFacts } from "./sentence-facts";

// Saved source summaries remain intact. Only the draft is reconstructed with current wording.
export function replayDraft(kind: "fight" | "accept") {
  const saved = kind === "accept" ? accept : fight;
  const decision = { ...saved.run.decision } as Decision;
  decision.why =
    kind === "accept"
      ? "The saved records show a $6.00 payment and no delivery record."
      : "The saved tracking record lists delivery. This draft uses the saved records.";
  const records: EvidenceRecord[] = saved.run.records.map((record) => ({
    ...record,
    ...(record.kind === "capture"
      ? {
          facts: {
            ...summaryFacts(record.summary),
            status: saved.run.steps
              .find((step) => step.tool === "get_capture" && step.ref === record.id)
              ?.summary.split(",")[0],
          },
        }
      : {}),
    ...(record.kind === "dispute" ? { decision } : {}),
  })) as EvidenceRecord[];
  const sentences = templateSentences(decision, records);
  const run: AgentRun = {
    disputeId: saved.dispute.id,
    decision,
    records,
    sentences,
    dropped: saved.run.sentences,
    steps: [],
    writer: "template",
    chosenTools: [],
    usage: { calls: 0, prompt_tokens: 0, completion_tokens: 0 },
  };
  return {
    label: "Draft reconstruction from saved sandbox records. No new filing was made.",
    dispute: saved.dispute,
    run,
    neurons: 0,
  };
}

export function replayById(id: string) {
  if (id === fight.dispute.id) return replayDraft("fight");
  if (id === accept.dispute.id) return replayDraft("accept");
}
