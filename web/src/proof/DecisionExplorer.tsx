import { useEffect, useState } from 'react';

export interface ScenarioSide {
  verdict: 'FIGHT' | 'ACCEPT' | 'OFFER' | 'REVIEW';
  rule: string;
  why: string;
  changeIf: string;
  missing: string[];
  sentences: string[];
  lines?: ScenarioLine[];
}

export interface ScenarioLine {
  text: string;
  recordId: string;
  recordKind: string;
  recordSummary: string;
}

export interface ScenarioComparison {
  original: ScenarioSide;
  changed: ScenarioSide;
  changedField: string;
  lineDiff?: { kept: ScenarioLine[]; added: ScenarioLine[]; removed: ScenarioLine[] };
  explain?: string;
}

function DiffList({ comparison }: { comparison: ScenarioComparison }) {
  const diff = comparison.lineDiff;
  if (!diff) return null;
  const rows: { tag: 'Kept' | 'Removed' | 'Added'; line: ScenarioLine }[] = [
    ...diff.removed.map((line) => ({ tag: 'Removed' as const, line })),
    ...diff.added.map((line) => ({ tag: 'Added' as const, line })),
    ...diff.kept.map((line) => ({ tag: 'Kept' as const, line })),
  ];
  return (
    <div className="decision-diff" aria-live="polite">
      <h3>What changed in the draft</h3>
      {comparison.explain && <p className="decision-explain">{comparison.explain}</p>}
      <ul className="decision-diff-list">
        {rows.map(({ tag, line }, idx) => (
          <li key={idx} className={`diff-${tag.toLowerCase()}`}>
            <span className={`diff-tag ${tag.toLowerCase()}`}>{tag}</span>
            <span className="diff-text">{line.text}</span>
            <span className="diff-source">from {line.recordSummary}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function lineClass(side: 'original' | 'changed', text: string, comparison: ScenarioComparison): string | undefined {
  const diff = comparison.lineDiff;
  if (!diff) return undefined;
  if (side === 'original' && diff.removed.some((l) => l.text === text)) return 'line-removed';
  if (side === 'changed' && diff.added.some((l) => l.text === text)) return 'line-added';
  return undefined;
}

export interface DecisionExplorerProps {
  initialComparison?: ScenarioComparison;
}

const DEFAULT_COMPARISON: ScenarioComparison = {
  original: {
    verdict: 'FIGHT',
    rule: 'INR_DELIVERED_BEFORE_CLAIM',
    why: 'Our shipping record shows it delivered 2 days before the claim. PayPal tracking says DELIVERED.',
    changeIf: 'A delivery date after 2026-10-20T12:00:00Z would make the desk offer half back.',
    missing: [],
    sentences: [
      'Our shipping record shows UPS number 1Z9999999999999999, status DELIVERED.',
      'Our shipping record shows it delivered 2026-10-18 12:00 UTC.',
      'The order was item, shipping to Customer.',
      'The buyer paid $24.00 on 2026-10-17.',
    ],
  },
  changed: {
    verdict: 'OFFER',
    rule: 'WEAK_EVIDENCE',
    why: 'The delivery record does not establish delivery before the claim, so offer half back.',
    changeIf: 'A delivery date before 2026-10-20T12:00:00Z would make the desk fight.',
    missing: [],
    sentences: [
      'Our shipping record shows UPS number 1Z9999999999999999, status DELIVERED.',
      'Our shipping record shows it delivered 2026-10-20 13:00 UTC.',
      'The buyer paid $24.00 on 2026-10-17.',
    ],
  },
  changedField: 'deliveredAt',
};

export default function DecisionExplorer(props: DecisionExplorerProps) {
  const [fixture, setFixture] = useState('delivered');
  const [field, setField] = useState('deliveredAt');
  const [value, setValue] = useState('2026-10-20T13:00:00Z');
  const [comparison, setComparison] = useState<ScenarioComparison>(props.initialComparison ?? DEFAULT_COMPARISON);
  const [error, setError] = useState('');

  function handleFieldChange(newField: string) {
    setField(newField);
    if (newField === 'deliveredAt') {
      setValue('2026-10-20T13:00:00Z');
    } else if (newField === 'trackingRead') {
      setValue('failed');
    } else if (newField === 'orderRead') {
      setValue('failed');
    } else if (newField === 'amount') {
      setValue('12');
    }
  }

  useEffect(() => {
    let cancelled = false;
    const val = field === 'amount' ? Number(value) : value;
    void fetch('/api/proof/scenario', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fixture, change: { field, value: val } }),
    })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Scenario comparison failed');
        if (!cancelled) {
          setComparison(data);
          setError('');
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Scenario comparison failed');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [fixture, field, value]);

  const different = comparison.original.verdict !== comparison.changed.verdict;

  return (
    <section className="proof-part decision-explorer">
      <h2>One changed fact</h2>
      <p className="decision-subtitle">
        Change one fact and see what the desk would decide. Nothing is filed and no model is called.
      </p>

      {error && (
        <p className="decision-error" role="alert">
          {error}
        </p>
      )}

      <div className="decision-controls">
        <div className="decision-control-group">
          <label htmlFor="decision-case">Case</label>
          <select
            id="decision-case"
            value={fixture}
            onChange={(e) => setFixture(e.target.value)}
          >
            <option value="delivered">Delivered ($24.00 USD)</option>
            <option value="refund">Refund ($6.00 USD)</option>
          </select>
        </div>

        <div className="decision-control-group">
          <label htmlFor="decision-fact">Fact to change</label>
          <select
            id="decision-fact"
            value={field}
            onChange={(e) => handleFieldChange(e.target.value)}
          >
            <option value="deliveredAt">Delivery date</option>
            <option value="trackingRead">Tracking read</option>
            <option value="orderRead">Order read</option>
            <option value="amount">Amount</option>
          </select>
        </div>

        <div className="decision-control-group">
          <label htmlFor="decision-val">Value</label>
          {field === 'deliveredAt' && (
            <select
              id="decision-val"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            >
              <option value="2026-10-18T12:00:00Z">2 days before the claim</option>
              <option value="2026-10-20T13:00:00Z">1 hour after the claim</option>
              <option value="">no delivery record</option>
            </select>
          )}

          {field === 'trackingRead' && (
            <select
              id="decision-val"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            >
              <option value="ok">ok</option>
              <option value="failed">failed</option>
            </select>
          )}

          {field === 'orderRead' && (
            <select
              id="decision-val"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            >
              <option value="ok">ok</option>
              <option value="failed">failed</option>
            </select>
          )}

          {field === 'amount' && (
            <input
              id="decision-val"
              type="number"
              min={1}
              max={500}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
        </div>
      </div>

      <div className="decision-columns">
        <div className="decision-column">
          <h3>As recorded</h3>
          <div className="decision-chip-row">
            <span className={`decision-chip ${comparison.original.verdict.toLowerCase()}`}>
              {comparison.original.verdict}
            </span>
          </div>
          <p className="decision-why">{comparison.original.why}</p>
          <div className="decision-change-box">
            <span className="decision-box-title">This would change it</span>
            <p>{comparison.original.changeIf}</p>
          </div>
          <div className="decision-drafts-box">
            <span className="decision-box-title">Draft lines</span>
            {comparison.original.sentences.length === 0 ? (
              <p className="decision-empty">No draft lines</p>
            ) : (
              <ul className="decision-sentences">
                {comparison.original.sentences.map((sentence, idx) => (
                  <li key={idx} className={lineClass('original', sentence, comparison)}>{sentence}</li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="decision-column">
          <h3>With one change</h3>
          <div className="decision-chip-row">
            <span
              className={`decision-chip ${comparison.changed.verdict.toLowerCase()} ${
                different ? 'highlight' : ''
              }`}
            >
              {comparison.changed.verdict}
            </span>
          </div>
          <p className="decision-why">{comparison.changed.why}</p>
          <div className="decision-change-box">
            <span className="decision-box-title">This would change it</span>
            <p>{comparison.changed.changeIf}</p>
          </div>
          <div className="decision-drafts-box">
            <span className="decision-box-title">Draft lines</span>
            {comparison.changed.sentences.length === 0 ? (
              <p className="decision-empty">No draft lines</p>
            ) : (
              <ul className="decision-sentences">
                {comparison.changed.sentences.map((sentence, idx) => (
                  <li key={idx} className={lineClass('changed', sentence, comparison)}>{sentence}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
      <DiffList comparison={comparison} />
    </section>
  );
}
