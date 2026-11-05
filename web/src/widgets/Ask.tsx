import { lazy, Suspense, useState, type FormEvent } from 'react';
import { colors } from '../theme';
import { chartOptions, type AskReply } from './chart';

const AgCharts = lazy(async () => {
  const [{ AgCharts }, { AllCommunityModule, ModuleRegistry }] = await Promise.all([
    import('ag-charts-react'),
    import('ag-charts-community'),
  ]);
  ModuleRegistry.registerModules([AllCommunityModule]);
  return { default: AgCharts };
});

export default function Ask() {
  const [query, setQuery] = useState('');
  const [reply, setReply] = useState<AskReply | null>(null);
  const [busy, setBusy] = useState(false);
  const [warning, setWarning] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setWarning('');
    try {
      const response = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ q: query }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Could not answer that question');
      setReply(body as AskReply);
    } catch (error) {
      setWarning(error instanceof Error ? error.message : 'Could not reach the service');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card ask-card">
      <form className="ask-form" onSubmit={submit}>
        <input
          aria-label="Ask about your disputes"
          placeholder="Ask about your disputes"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button disabled={busy || !query.trim()}>Ask</button>
      </form>
      {warning && <p className="offline ask-warning">{warning}</p>}
      {reply && (
        <>
          <h2>{reply.title}</h2>
          <Suspense fallback={<div className="ask-chart" aria-busy="true" />}>
            <div className="ask-chart">
              <AgCharts options={chartOptions(reply, colors)} />
            </div>
          </Suspense>
        </>
      )}
    </section>
  );
}
