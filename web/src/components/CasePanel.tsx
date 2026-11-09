import { useEffect, useRef, useState } from 'react';
import type { CaseData, Filed, FilingConflict, Run } from '../api';
import { approveDispute, analyseDispute, getDispute } from '../api';
import {
  caseProgress,
  caseStatus,
  evidenceText,
  formatMoney,
  filedTime,
  reasonLabel,
  replyBy,
  statusLabel,
  statusTone,
} from '../format';
import { showsApprove } from '../judge';
import { errorMessage } from '../errors';
import DeadlineRing from '../widgets/DeadlineRing';
import { beginRequest } from './requestGuard';
import { approvalMessage, citation, filingNeedsCheck, loadResource, recordType, uniqueRecords } from './caseView';
import { DecisionCard, DecisionFacts, FiledOutcome, FilingNotice, LoadNotice, RunActions } from './CaseStates';

function shortRef(value: string) {
  return value.length > 18 ? `${value.slice(0, 18)}…` : value;
}

export default function CasePanel({
  id,
  refreshKey,
  mine,
  ownerKey,
  replay,
  created,
  onRefs,
}: {
  id: string | null;
  refreshKey: number;
  mine: Set<string>;
  ownerKey: string | null;
  created?: string;
  onRefs?: (refs: string[]) => void;
  replay?: { label: string; run: Run; dispute: Omit<CaseData, 'updated_at' | 'data'> };
}) {
  const [loadFailed, setLoadFailed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [record, setRecord] = useState<CaseData | null>(replay ? { ...replay.dispute, updated_at: '' } : null);
  const [run, setRun] = useState<Run | null>(replay?.run ?? null);
  const [cap, setCap] = useState<string | null>(null);
  const [filed, setFiled] = useState<Filed | null>(null);
  const [filedAt, setFiledAt] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [approvalWarning, setApprovalWarning] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const selectedId = useRef(id);
  selectedId.current = id;
  const [error, setError] = useState('');
  const [openRecord, setOpenRecord] = useState<string | null>(null);
  const [conflict, setConflict] = useState<FilingConflict | null>(null);
  useEffect(() => {
    if (!id) {
      setRecord(null);
      setRun(null);
      setFiled(null);
      setFiledAt(null);
      setUncertain(false);
      return;
    }
    let active = true;
    if (replay) {
      setRecord({ ...replay.dispute, updated_at: '' });
      setRun(replay.run);
      setFiled(null);
      setUncertain(false);
      setFiledAt(null);
      return () => {
        active = false;
      };
    }
    if (record?.id !== id) {
      setRecord(null);
      setRun(null);
      setFiled(null);
      setCap(null);
      setError('');
      setApprovalWarning('');
      setOpenRecord(null);
    }
    void loadResource(
      () => getDispute(id),
      (data) => {
        if (!active) return;
        setRecord(data);
        setRun(data.data?.run ?? null);
        setFiled(data.data?.filed ?? null);
        setFiledAt(filedTime(data.data?.filed));
        setUncertain(filingNeedsCheck(data.data?.filed, data.data?.operation));
        setConflict(data.data?.filingConflict ?? null);
      },
      (failed) => {
        if (active) setLoadFailed(failed);
      },
    );
    return () => {
      active = false;
    };
  }, [id, refreshKey, replay, retryKey]);
  // Tell the activity list which ids belong to this case: the case and every record it read.
  useEffect(() => {
    onRefs?.(id ? [id, ...(run?.records ?? []).map((item) => item.id)] : []);
  }, [id, run, onRefs]);
  const analyse = async () => {
    if (!id) return;
    if (
      !beginRequest(busyRef.current, (value) => {
        busyRef.current = value;
        setBusy(value);
      })
    )
      return;
    setError('');
    try {
      const result = await analyseDispute(id, ownerKey ?? undefined);
      if (selectedId.current !== id) return;
      setRun(result.run);
      setCap(result.cap);
      setFiled(null);
      setApprovalWarning('');
    } catch (e) {
      if (selectedId.current !== id) return;
      setError(errorMessage(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const approve = async () => {
    if (!id) return;
    if (
      !beginRequest(busyRef.current, (value) => {
        busyRef.current = value;
        setBusy(value);
      })
    )
      return;
    setError('');
    try {
      const result = await approveDispute(id, run?.version, ownerKey ?? undefined);
      if (selectedId.current !== id) return;
      if (result.kind === 'uncertain') {
        setUncertain(true);
        setConflict(result.conflict ?? null);
      } else if (result.kind === 'filed' && result.filed.ok) {
        setFiled(result.filed);
        setFiledAt(new Date().toISOString());
        setUncertain(false);
        setConflict(null);
      } else if (result.kind === 'filed') setApprovalWarning(result.filed.detail);
      else {
        setApprovalWarning(result.detail);
        if (result.operationCleared) {
          setUncertain(false);
          setConflict(null);
          setRecord(current => current ? { ...current, data: { ...current.data, operation: undefined, filingConflict: undefined } } : current);
        }
      }
    } catch (e) {
      if (selectedId.current !== id) return;
      const body = (e as { body?: { filed?: Filed; error?: string; run?: Run } }).body;
      if ((e as { status?: number }).status === 409 && body?.run) setRun(body.run);
      setApprovalWarning(approvalMessage((e as { status?: number }).status, body, errorMessage(e)));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  if (!id) return null;
  if (!record || record.id !== id)
    return (
      <section className="card case-panel" aria-label="Case panel">
        <LoadNotice scope="case" failed={loadFailed} retry={() => setRetryKey((key) => key + 1)} />
      </section>
    );
  const status = caseStatus(record.status, filed?.ok === true);
  const progress = caseProgress(status);
  const deadline = replyBy(record.due, status);
  const canApprove = showsApprove({ ...record, replay: Boolean(replay) }, mine, ownerKey) && status !== 'RESOLVED';
  const canAnalyse = !filed && !replay && status !== 'RESOLVED' && (mine.has(id) || Boolean(ownerKey));
  const filingUncertain = uncertain || filingNeedsCheck(filed ?? undefined, record.data?.operation);
  return (
    <section className="card case-panel" aria-labelledby="case-heading">
      {replay && <p className="replay-banner">{replay.label}</p>}
      <div className="case-heading">
        <div className="case-heading-meta">
          <strong className="case-amount">{formatMoney(record.amount, record.currency)}</strong>
          <span className={`status-pill ${statusTone(status)}`}>{statusLabel(status)}</span>
        </div>
        <div className="case-reason">
          <span>{reasonLabel(record.reason)}</span>
          <h2 id="case-heading">{record.id}</h2>
        </div>
        {deadline && (
          <div className="case-deadline">
            <span>{deadline}</span>
            <DeadlineRing created={record.created ?? created} due={record.due} />
          </div>
        )}
      </div>
      {progress && (
        <ol className="case-progress" aria-label="Case progress">
          {progress.steps.map((step) => (
            <li key={step.label} className={step.state} aria-current={step.state === 'current' ? 'step' : undefined}>
              <span className="progress-mark" />
              {step.label}
            </li>
          ))}
        </ol>
      )}
      {filed && (
        <div className={filed.ok ? 'filed' : 'file-warning'}>
          {filed.ok ? (
            <>
              Filed <time>{filedAt ? new Date(filedAt).toLocaleTimeString(undefined, { hour12: false }) : ''}</time>
              <FiledOutcome call={filed.call} />
            </>
          ) : (
            filed.detail
          )}
        </div>
      )}
      {filingUncertain && <FilingNotice id={id} conflict={conflict} busy={busy} check={approve} />}
      {!run && canAnalyse && !filingUncertain && (
        <>
          <button className="primary" disabled={busy} onClick={analyse}>
            {busy ? 'Reading the records' : 'Analyse'}
          </button>
          {error && <p className="offline action-warning">{error}</p>}
        </>
      )}
      {!run && !replay && !canApprove && !filed && status !== 'RESOLVED' && (
        <p className="muted-line">This case belongs to another visitor. You can read it, not file it.</p>
      )}
      {run && (
        <>
          <DecisionCard run={run} currency={record.currency}>
            {!replay && !canApprove && !filed && status !== 'RESOLVED' && (
              <p className="muted-line">This case belongs to another visitor. You can read it, not file it.</p>
            )}
            <RunActions
              run={run}
              amount={record.amount}
              currency={record.currency}
              canAnalyse={canAnalyse && !filingUncertain}
              canApprove={canApprove && !filed && !filingUncertain}
              busy={busy}
              error={error}
              approvalWarning={approvalWarning}
              analyse={analyse}
              approve={approve}
            />
          </DecisionCard>
          {cap && <p className="muted-line">{cap}</p>}
          <div className="draft">
            <h3>Draft</h3>
            {run.sentences.map((sentence, index) => {
              const info = run.records.find((item) => item.id === sentence.record_id);
              return (
                <p className="sentence" key={`${sentence.record_id}-${index}`}>
                  {sentence.text}{' '}
                  <span
                    className={`record-wrap ${openRecord === sentence.record_id ? 'record-open' : ''}`}
                    onPointerEnter={() => setOpenRecord(sentence.record_id)}
                    onPointerLeave={() => setOpenRecord(null)}
                    onFocus={() => setOpenRecord(sentence.record_id)}
                    onBlur={() => setOpenRecord(null)}
                  >
                    <button
                      className="record-chip"
                      aria-label={citation(sentence.record_id, run.records).description}
                      aria-expanded={openRecord === sentence.record_id}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') setOpenRecord(null);
                      }}
                    >
                      {citation(sentence.record_id, run.records).label}
                    </button>
                    {info && (
                      <span className="record-popover" aria-hidden={openRecord !== sentence.record_id}>
                        {sentence.record_id}: {info.summary}
                      </span>
                    )}
                  </span>
                </p>
              );
            })}
          </div>
          {run.writer === 'template' && <p className="muted-line">Written from the records by the template</p>}
          {run.writer === 'model' && <p className="muted-line">The model chose these facts. Each line is written from the records.</p>}
          {run.dropped.length > 0 && (
            <div className="dropped">
              <h3>Dropped</h3>
              {run.dropped.map((sentence, index) => (
                <p key={`${sentence.record_id}-${index}`}>
                  <s>{sentence.text}</s>{' '}
                  <span title={sentence.record_id}>{citation(sentence.record_id, run.records).label}</span>
                </p>
              ))}
            </div>
          )}
          <a
            className="evidence-pack"
            aria-label="Evidence pack"
            href={`/api/disputes/${encodeURIComponent(record.id)}/pack.pdf`}
            download={`${record.id}-evidence.pdf`}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
              <path d="M4 1h5l3 3v11H4z M9 1v4h3 M6 8h4 M6 11h4" />
            </svg>
            Evidence pack <span>PDF</span>
          </a>
          <DecisionFacts run={run} part="detail" />
          <details className="records-detail">
            <summary>
              {`${run.decision.verdict === 'FIGHT' ? 'Evidence behind this draft' : 'Records read'}, ${uniqueRecords(run.records).length} records`}
            </summary>
            <ul className="evidence-rows">
              {uniqueRecords(run.records).map((item) => (
                <li key={item.id}>
                  <span className="evidence-kind">{recordType(item.kind)}</span>
                  <span>{evidenceText(item.summary, record.reason)}</span>
                </li>
              ))}
            </ul>
          </details>
          <details className="steps-detail" open={run.steps.some((step) => !step.ok)}>
            <summary>
              Checks on PayPal, {run.steps.filter((step) => step.ok).length} of {run.steps.length} worked
            </summary>
            <ul className="steps">
              {run.steps.map((step, index) => (
                <li
                  className={`step ${step.ok ? '' : 'failed'}`}
                  key={`${step.tool}-${step.ref}-${index}`}
                  aria-label={`${step.tool}, ${shortRef(step.ref)}, ${step.ok ? 'succeeded' : 'failed'}: ${step.summary}, ${step.ms} ms`}
                >
                  <code>{step.tool}</code>
                  <code className="step-ref" title={step.ref}>
                    {shortRef(step.ref)}
                  </code>
                  <span>{step.summary}</span>
                  <small>{step.ms} ms</small>
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </section>
  );
}
