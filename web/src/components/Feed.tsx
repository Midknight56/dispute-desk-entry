import { useState } from 'react';
import type { FeedRow } from '../api';
import { feedSentence } from './feedSentence';
export { feedSentence } from './feedSentence';

// With a case selected, show only rows that name the case or a record it read. "All activity" shows the last 30.
export function feedRowsFor(rows: FeedRow[], caseRefs: string[], all: boolean): FeedRow[] {
  const refs = new Set(caseRefs.filter(Boolean));
  if (all || refs.size === 0) return rows.slice(0, 30);
  return rows.filter((row) => refs.has(row.ref)).slice(0, 8);
}

export default function Feed({ rows, caseRefs = [] }: { rows: FeedRow[]; caseRefs?: string[] }) {
  const [all, setAll] = useState(false);
  if (!rows.length) return null;
  const filtered = caseRefs.some(Boolean);
  const shown = feedRowsFor(rows, caseRefs, all);
  return (
    <section className="card feed" aria-label="Activity">
      <div className="feed-head">
        <h2>Activity</h2>
        {filtered && (
          <div className="feed-filter" role="group" aria-label="Which activity">
            <button aria-pressed={!all} onClick={() => setAll(false)}>This case</button>
            <button aria-pressed={all} onClick={() => setAll(true)}>All activity</button>
          </div>
        )}
      </div>
      {shown.length > 0 ? (
        <ul className="feed-rows" aria-live="polite">
          {shown.map((row) => (
            <li className="feed-row" key={row.seq} title={`${row.title} ${row.ref}: ${row.detail}`}>
              <time>{new Date(row.at).toLocaleTimeString(undefined, { hour12: false })}</time>
              <i className={`dot ${row.kind}`} />
              <span className="feed-sentence">{feedSentence(row)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted-line">No activity for this case yet.</p>
      )}
    </section>
  );
}
