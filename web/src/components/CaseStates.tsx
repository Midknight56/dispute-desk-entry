import type { ReactNode } from 'react';
import type { FilingConflict, Run } from '../api';
import { citation, decisionView, filedOutcome } from './caseView';
import { actionLabel, formatMoney, moneyLine, plainReasons } from '../format';

export function FilingNotice({ id, conflict, busy, check }: { id: string; conflict?: FilingConflict | null; busy: boolean; check: () => void }) {
  return <div role="status">
    <p>{conflict ? 'PayPal shows different facts. The original filing is still uncertain.' : 'PayPal did not confirm the filing yet.'}</p>
    {conflict && <p>Open PayPal and review case {id}. <a href="https://www.sandbox.paypal.com/" target="_blank" rel="noreferrer">Open PayPal</a></p>}
    <button disabled={busy} onClick={check}>{busy ? 'Checking PayPal' : 'Check PayPal'}</button>
  </div>;
}

export function RunActions({
  run,
  amount,
  currency,
  canAnalyse,
  canApprove,
  busy,
  error,
  approvalWarning,
  analyse,
  approve,
}: {
  run: Run;
  amount: string;
  currency: string;
  canAnalyse: boolean;
  canApprove: boolean;
  busy: boolean;
  error: string;
  approvalWarning?: string;
  analyse: () => void;
  approve: () => void;
}) {
  const view = decisionView(run.decision);
  const money = view.money ? moneyLine(run.decision.verdict, amount, run.decision.offerAmount, currency) : null;
  const warning = approvalWarning && (
    <p className="file-warning action-warning" role="alert">
      {approvalWarning}
    </p>
  );
  return (
    <>
      {canAnalyse && (
        <>
          <button className={view.analyseClass} disabled={busy} onClick={analyse}>
            {busy ? 'Reading the records' : 'Analyse again'}
          </button>
          {error && <p className="offline action-warning">{error}</p>}
        </>
      )}
      {(!canApprove || !view.approve) && warning}
      {canApprove && view.approve && (
        <div className="case-action">
          {warning}
          {money && (
            <div className="money-line">
              <span>{money.label}</span>
              <strong>{money.value}</strong>
            </div>
          )}
          <button className="primary approve" disabled={busy} onClick={approve}>
            {actionLabel(run.decision.verdict, amount, run.decision.offerAmount, currency)}
          </button>
        </div>
      )}
    </>
  );
}

export function LoadNotice({ scope, failed, stale = false, retry }: { scope: 'case' | 'cases'; failed: boolean; stale?: boolean; retry: () => void }) {
  return (
    <div role={failed ? 'alert' : 'status'}>
      <p>
        {failed && stale ? 'The refresh failed. Showing saved data.' : failed
          ? scope === 'case'
            ? 'This case did not load.'
            : 'The cases did not load.'
          : scope === 'case'
            ? 'Loading the case'
            : 'Loading the cases'}
      </p>
      {failed && <button onClick={retry}>Try again</button>}
    </div>
  );
}

export function FiledOutcome({ call }: { call: string }) {
  return (
    <>
      <p className="filed-detail">{filedOutcome(call)}</p>
      <details>
        <summary>Details</summary>
        <span>{call}</span>
      </details>
    </>
  );
}

// The recommendation card: verdict and action together, then the evidence it rests on and what is missing or in conflict.
export function DecisionCard({ run, currency, children }: { run: Run; currency: string; children?: ReactNode }) {
  const view = decisionView(run.decision);
  return (
    <section className={`decision-card ${view.tone}`} aria-label="Recommendation">
      <div className={`verdict ${view.tone}`} role="status">
        <strong>
          {run.decision.verdict}
          {run.decision.verdict === 'OFFER' && run.decision.offerAmount != null
            ? ` ${formatMoney(run.decision.offerAmount, currency)}`
            : ''}
        </strong>
        <p>{run.decision.why}</p>
      </div>
      {children}
      <DecisionFacts run={run} part="summary" />
    </section>
  );
}

export function DecisionFacts({ run, part = 'all' }: { run: Run; part?: 'summary' | 'detail' | 'all' }) {
  const view = decisionView(run.decision);
  const policy = view.policy;
  const summary = part !== 'detail';
  const detail = part !== 'summary';
  return (
    <div className="decision-facts">
      {summary && view.facts.length > 0 && (
        <section>
          <h3>Decisive evidence</h3>
          <dl>
            {view.facts.map((fact, index) => (
              <div key={index}>
                <dt>{fact.label}</dt>
                <dd>
                  {fact.value}
                  {fact.recordId && (
                    <>
                      {' '}
                      <span title={fact.recordId}>{citation(fact.recordId, run.records).label}</span>
                    </>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {summary && view.missing.length > 0 && (
        <section>
          <h3>Not found</h3>
          <ul>
            {view.missing.map((value, index) => (
              <li key={index}>{value}</li>
            ))}
          </ul>
        </section>
      )}
      {summary && view.disagreements.length > 0 && (
        <section>
          <h3>Records that disagree</h3>
          <ul>
            {view.disagreements.map((value, index) => (
              <li key={index}>{value}</li>
            ))}
          </ul>
        </section>
      )}
      {detail && view.changeIf && (
        <section>
          <h3>This would change it</h3>
          <p>{view.changeIf}</p>
        </section>
      )}
      {detail && policy && (
        <section>
          <h3>Desk policy</h3>
          <p>{`Fight line ${policy.fightLine}. Weak cases offer ${policy.offerShare} back.`}</p>
          <p>{policy.note}</p>
          <p>{`Handles: ${plainReasons(policy.reasons)}`}</p>
        </section>
      )}
    </div>
  );
}
