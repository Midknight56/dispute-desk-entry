import type { FeedRow } from '../api';
import { feedSentence } from './feedSentence';
export { feedSentence } from './feedSentence';

export default function Feed({ rows }: { rows: FeedRow[] }) {
  if (!rows.length) return null;
  return (
    <section className="card feed">
      <h2>Feed</h2>
      <ul className="feed-rows" aria-live="polite">
        {rows.slice(0, 30).map((row) => (
          <li className="feed-row" key={row.seq} title={`${row.title} ${row.ref}: ${row.detail}`}>
            <time>{new Date(row.at).toLocaleTimeString(undefined, { hour12: false })}</time>
            <i className={`dot ${row.kind}`} />
            <span className="feed-sentence">{feedSentence(row)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
