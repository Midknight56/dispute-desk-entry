import { useEffect, useState } from 'react';
import { getSales, trackSale, type Sale } from '../api';
import { errorMessage } from '../errors';

function duration(ms: number) {
  const hours = Math.max(0, Math.floor(ms / 3600000));
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function TrackingRows({
  rows,
  onTrack,
  busy,
  now = Date.now(),
}: {
  rows: Sale[];
  onTrack: (id: string) => void;
  busy?: string | null;
  now?: number;
}) {
  return (
    <div className="studio-tracking">
      {rows.map((row) => (
        <div className={`studio-tracking-row tracking-${row.state}`} key={row.capture_id}>
          <span className="tracking-dot" aria-hidden="true" />
          <strong>
            {new Intl.NumberFormat('en-US', { style: 'currency', currency: row.currency }).format(Number(row.amount))}
          </strong>
          <span className="tracking-age">Paid {duration(now - Date.parse(row.captured_at))} ago</span>
          {row.yours && <span className="status-pill ownership-pill">Yours</span>}
          <span className="tracking-state">
            {row.state === 'on_paypal'
              ? 'On PayPal'
              : row.state === 'soon'
                ? `Due in ${duration(row.due_in_ms)}`
                : 'Late'}
          </span>
          {row.state === 'late' && row.yours && (
            <button
              type="button"
              aria-label={`Add tracking for ${row.capture_id}`}
              disabled={busy === row.capture_id}
              onClick={() => onTrack(row.capture_id)}
            >
              Add tracking
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export default function TrackingWidget() {
  const [rows, setRows] = useState<Sale[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const refresh = () =>
      getSales()
        .then((sales) => {
          if (active) setRows(sales);
        })
        .catch((e) => {
          if (active) setError(errorMessage(e));
        });
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 15000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
  const track = async (id: string) => {
    setBusy(id);
    setError('');
    try {
      await trackSale(id);
      setRows((sales) =>
        sales.map((row) => (row.capture_id === id ? { ...row, state: 'on_paypal', due_in_ms: 0 } : row)),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <TrackingRows
        rows={rows}
        onTrack={(id) => {
          void track(id);
        }}
        busy={busy}
      />
      {error && <p role="alert">{error}</p>}
    </>
  );
}
