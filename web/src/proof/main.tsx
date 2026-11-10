import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { applyTheme } from '../theme';
import '../app.css';
import './proof.css';
import DecisionExplorer from './DecisionExplorer';

type Proof = {
  verdicts: { total: number; right: number; rows: { label: string; expected: string; got: string; rule: string }[] };
  checker: { total: number; struck: number; rows: { kind: string; text: string; struck: boolean; reason: string }[] };
  records: { id: string; kind: string; summary: string }[];
};
type Check = { status: 'kept' | 'struck'; reason: string };

function ProofPage() {
  const [proof, setProof] = useState<Proof | null>(null);
  const [text, setText] = useState('The buyer paid $48.00.');
  const [recordId, setRecordId] = useState('CAP1');
  const [result, setResult] = useState<Check | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    applyTheme(scheme.matches);
    const change = (event: MediaQueryListEvent) => applyTheme(event.matches);
    scheme.addEventListener('change', change);
    void fetch('/api/proof')
      .then((response) => response.json())
      .then(setProof)
      .catch(() => setError('Proof could not load.'));
    return () => scheme.removeEventListener('change', change);
  }, []);
  async function check(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    try {
      const response = await fetch('/api/proof/check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, record_id: recordId }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Check failed.');
      setResult(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Check failed.');
    }
  }
  return (
    <div className="proof-shell">
      <header className="proof-topbar">
        <a href="/">Dispute Desk</a>
        <h1>Proof</h1>
      </header>
      {error && (
        <p className="proof-error" role="alert">
          {error}
        </p>
      )}
      {!proof ? (
        <p>Loading proof</p>
      ) : (
        <main className="proof-main">
          <section className="proof-part">
            <h2>Verdict rule</h2>
            <p className="proof-count">
              {proof.verdicts.right} of {proof.verdicts.total} match the desk's rules
            </p>
            <div className="proof-table" role="table" aria-label="Verdict cases">
              <div className="proof-row proof-head" role="row">
                <span>Case</span>
                <span>Plan</span>
                <span>Code</span>
                <span>Rule</span>
              </div>
              {proof.verdicts.rows.map((row) => (
                <div className="proof-row proof-verdict-row" role="row" key={row.label}>
                  <span className="proof-row-label">{row.label}</span>
                  <span className="proof-verdict-plan">{row.expected}</span>
                  <span className="proof-verdict-code">{row.got}</span>
                  <span className="proof-verdict-rule">
                    {row.rule.split('_').map((part, index, parts) => (
                      <span key={index}>
                        {part}
                        {index < parts.length - 1 && (
                          <>
                            _<wbr />
                          </>
                        )}
                      </span>
                    ))}
                  </span>
                </div>
              ))}
            </div>
            <small>Guarded by tests/decision.test.ts</small>
          </section>
          <section className="proof-part">
            <h2>Sentence check</h2>
            <p className="proof-count">
              {proof.checker.struck} of {proof.checker.total} altered sentences struck
            </p>
            <div className="proof-table" role="table" aria-label="Sentence checks">
              <div className="proof-row proof-head" role="row">
                <span>Change</span>
                <span>Sentence</span>
                <span>Result</span>
                <span>Reason</span>
              </div>
              {proof.checker.rows.map((row, i) => (
                <div className="proof-row" role="row" key={`${row.kind}-${i}`}>
                  <span className="proof-row-label">{row.kind}</span>
                  <span className="proof-check-sentence">{row.text}</span>
                  <span className="proof-check-result">{row.struck ? 'Struck' : 'Kept'}</span>
                  <span className="proof-check-reason">{row.reason}</span>
                </div>
              ))}
            </div>
            <small>Guarded by tests/drop_rule.test.ts and tests/agent.test.ts</small>
          </section>
          <section className="proof-part">
            <h2>Records the checker reads</h2>
            <ul className="proof-records">
              {proof.records.map((record) => (
                <li key={record.id}>
                  <code>{record.id}</code>
                  <span>{record.summary}</span>
                </li>
              ))}
            </ul>
            <small>Guarded by tests/proof.test.ts</small>
          </section>
          <section className="proof-part">
            <h2>Try the checker</h2>
            <form className="proof-form" onSubmit={check}>
              <label htmlFor="proof-text">Your sentence</label>
              <textarea
                id="proof-text"
                maxLength={500}
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
              <label htmlFor="proof-record">Record id</label>
              <select id="proof-record" value={recordId} onChange={(event) => setRecordId(event.target.value)}>
                {proof.records.map((record) => (
                  <option key={record.id} value={record.id}>
                    {record.id}
                  </option>
                ))}
                <option value="MISSING">MISSING</option>
              </select>
              <button className="proof-button" type="submit">
                Check
              </button>
            </form>
            {result && (
              <p className={`proof-result ${result.status}`}>
                <strong>{result.status === 'kept' ? 'Kept' : 'Struck'}</strong>
                <span>{result.reason}</span>
              </p>
            )}
            <small>Guarded by tests/proof.test.ts</small>
          </section>
          <DecisionExplorer />
        </main>
      )}
    </div>
  );
}

const scheme = window.matchMedia('(prefers-color-scheme: dark)');
applyTheme(scheme.matches);
createRoot(document.getElementById('root')!).render(<ProofPage />);
