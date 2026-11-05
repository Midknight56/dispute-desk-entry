import type { CaseData, Run } from '../api';
import type { Dispute } from '../format';

export type DraftLine = {
  text: string;
  recordId: string;
  dropped: boolean;
  reason?: string;
};

export type CheckedDraft = {
  caseId: string;
  verdict: string;
  sentences: DraftLine[];
};

export function shapeCheckedDraft(disputes: Dispute[], details: CaseData[]): CheckedDraft | null {
  const detailById = new Map(details.map((detail) => [detail.id, detail]));
  const newest = [...disputes]
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
    .map((dispute) => ({ dispute, run: detailById.get(dispute.id)?.data?.run }))
    .find((item): item is { dispute: Dispute; run: Run } => Boolean(item.run));

  if (!newest) return null;

  const recordIds = new Set(newest.run.records.map((record) => record.id));
  return {
    caseId: newest.dispute.id,
    verdict: newest.run.decision.verdict,
    sentences: [
      ...newest.run.sentences.map((sentence) => ({
        text: sentence.text,
        recordId: sentence.record_id,
        dropped: false,
      })),
      ...newest.run.dropped.map((sentence) => ({
        text: sentence.text,
        recordId: sentence.record_id,
        dropped: true,
        reason: recordIds.has(sentence.record_id) ? 'Details not in record' : 'Record not in case',
      })),
    ],
  };
}
