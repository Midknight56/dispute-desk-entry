import type { FilingConflict, Run } from '../api';
import { citation, decisionView, filedOutcome } from './caseView';
import { actionLabel, moneyLine } from '../format';

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

export function DecisionFacts({ run }: { run: Run }) {
  const view = decisionView(run.decision);
  return (
    <div className="decision-facts">
      {view.facts.length > 0 && (
        <section>
          <h3>Why</h3>
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
      {view.missing.length > 0 && (
        <section>
          <h3>Not found</h3>
          <ul>
            {view.missing.map((value, index) => (
              <li key={index}>{value}</li>
            ))}
          </ul>
        </section>
      )}
      {view.changeIf && (
        <section>
          <h3>This would change it</h3>
          <p>{view.changeIf}</p>
        </section>
      )}
      {view.disagreements.length > 0 && (
        <section>
          <h3>Records that disagree</h3>
          <ul>
            {view.disagreements.map((value, index) => (
              <li key={index}>{value}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
