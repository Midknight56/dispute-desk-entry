import { loadResource } from '../components/caseView';
import { LoadNotice } from '../components/CaseStates';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AgStudioAiModule,
  studioTheme,
  clientToolRunner,
  createAiHarness,
  type AgAiRunInput,
  type AgStudioTheme,
} from 'ag-studio';
import { AgStudio, AgStudioProvider, createWidgets } from 'ag-studio-react';
import { enableStudioDevValidations } from 'ag-studio';
import type { AgWidgetParams } from 'ag-studio';
import { getDispute, getDisputes, getShipNext } from '../api';
import type { CaseData } from '../api';
import { errorMessage } from '../errors';
import { applyTheme, colors, darkColors } from '../theme';
import { toStudioRows, type StudioRow } from './data';
import { askToEvents, latestUserText, shouldFinish, type AskReply } from './runner';
import { addChartTo, type ChartRequest } from './addChart';
import { createInitialLayout } from './layout';
import { deadlineDataRows, deadlineFields, evidenceDataRows, evidenceFields } from './widgetData';
import { shapeCheckedDraft, type CheckedDraft } from './draftWidget';
import { draftRefreshResult, draftLoadState } from './draftState';
import { widgetLoadResult, type WidgetLoadState } from './widgetState';
import { readiness } from '../widgets/readiness';
import { windowLeft } from '../widgets/deadline';
import TrackingWidget from './TrackingWidget';
import './studio.css';

async function requestAsk(q: string, signal?: AbortSignal): Promise<AskReply> {
  const response = await fetch('/api/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ q }),
    signal,
  });
  const text = await response.text();
  let body: (AskReply & { error?: string }) | Record<string, never> = {};
  try {
    body = text ? (JSON.parse(text) as AskReply & { error?: string }) : {};
  } catch {
    body = {};
  }
  if (!response.ok || !('spec' in body))
    throw Object.assign(new Error('Request failed'), { status: response.status, body });
  return body as AskReply;
}

const DEBUG = new URLSearchParams(window.location.search).has('debug');
if (DEBUG) enableStudioDevValidations();

const font = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

function makeTheme(dark: boolean): AgStudioTheme {
  const token = dark ? darkColors : colors;
  const fills = [token.accent, token.chart, token.ok, token.warn, token.danger];
  // studioTheme, not createStudioTheme(): the default theme carries Studio's icon set
  return studioTheme.withParams({
    backgroundColor: token.bg,
    foregroundColor: token.text,
    accentColor: token.accent,
    borderColor: token.line,
    fontFamily: font,
    browserColorScheme: dark ? 'dark' : 'light',
    studioCanvasBackgroundColor: token.bg,
    studioWidgetBackgroundColor: token.surface,
    studioWidgetTitleTextColor: token.text,
    chartAccentColor: token.accent,
    chartBorderColor: token.line,
    chartTextColor: token.text,
    chartSubtleTextColor: token.muted,
    chartAxisLineColor: token.line,
    chartGridLineColor: token.line,
    chartFontFamily: font,
    chartPaletteFills1Color: fills[0],
    chartPaletteFills2Color: fills[1],
    chartPaletteFills3Color: fills[2],
    chartPaletteFills4Color: fills[3],
    chartPaletteFills5Color: fills[4],
    chartPaletteStrokes1Color: fills[0],
    chartPaletteStrokes2Color: fills[1],
    chartPaletteStrokes3Color: fills[2],
    chartPaletteStrokes4Color: fills[3],
    chartPaletteStrokes5Color: fills[4],
  });
}

function EvidenceWidget({ widgetApi }: AgWidgetParams) {
  const [rows, setRows] = useState<Array<Record<string, unknown>> | null>(null);
  const [state, setState] = useState<WidgetLoadState>('loading');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const schema = widgetApi.getSchema();
        const fields = schema.find((table) => table.id === 'disputes')?.fields ?? [];
        const selected = evidenceFields(schema);
        const result = await widgetApi.getData({ fields: selected });
        if (DEBUG) console.info('widget data', fields.map((f) => f.key), selected.length, result.results.rows.length);
        const next = evidenceDataRows(selected, result as { results: { rows: unknown[] } }).filter((row) => row.status !== 'Settled');
        const outcome = widgetLoadResult(rows, next.length ? next : null, false);
        if (active) { setRows(outcome.data); setState(outcome.state); }
      } catch {
        const outcome = widgetLoadResult(rows, null, true);
        if (active) { setRows(outcome.data); setState(outcome.state); }
      }
    })();
    return () => {
      active = false;
    };
  }, [widgetApi, retry]);
  const evidenceRows = rows ?? [];
  return (
    <div className="studio-evidence">
      {state === 'loading' && <p>Loading evidence</p>}
      {(state === 'error' || state === 'stale') && <p role={state === 'error' ? 'alert' : 'status'}>{state === 'stale' ? 'Not updated, showing the last good data.' : 'Evidence did not load.'} <button type="button" onClick={() => setRetry((n) => n + 1)}>Try again</button></p>}
      <div className="studio-evidence-head">
        <span>Case</span>
        <span>Payment</span>
        <span>Order</span>
        <span>Tracking</span>
        <span>Filed</span>
      </div>
      {evidenceRows.map((row) => (
        <div className="studio-evidence-row" key={String(row.id)}>
          <span>{String(row.id)}</span>
          {readiness({
            id: String(row.id),
            status: String(row.status),
            stage: '',
            reason: '',
            amount: '0',
            currency: 'USD',
            due: null,
            custom_id: null,
            updated_at: '',
            kinds: [
              ...(row.has_payment ? ['capture' as const] : []),
              ...(row.has_order ? ['order' as const] : []),
              ...(row.has_tracking ? ['tracking' as const] : []),
            ],
            filed_at: row.filed ? 'filed' : null,
          }).filled.map((filled, index) => (
            <span className={filled ? 'studio-mark is-ready' : 'studio-mark'} key={index}>
              {filled ? '✓' : '·'}
            </span>
          ))}
        </div>
      ))}
      {state === 'empty' && <p>No open disputes</p>}
    </div>
  );
}

function DeadlineWidget({ widgetApi }: AgWidgetParams) {
  const [nearest, setNearest] = useState<{ id: string; share: number; days: number } | null>(null);
  const [state, setState] = useState<WidgetLoadState>('loading');
  const [retry, setRetry] = useState(0);
  const [hasData, setHasData] = useState(false);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
      const schema = widgetApi.getSchema();
      const fields = schema.find((table) => table.id === 'disputes')?.fields ?? [];
      const selected = deadlineFields(schema);
      const result = await widgetApi.getData({ fields: selected });
      if (DEBUG)
        console.info(
          'widget data',
          fields.map((f) => f.key),
          selected.length,
          result.results.rows.length,
        );
      const candidates = deadlineDataRows(selected, result as { results: { rows: unknown[] } })
        .filter((row) => row.status !== 'Settled')
        .map((row) => ({
          row,
          window: windowLeft(String(row.created ?? ''), row.due ? String(row.due) : null, Date.now()),
        }))
        .filter((entry) => entry.window && entry.row.due)
        .sort((a, b) => Date.parse(String(a.row.due)) - Date.parse(String(b.row.due)));
      const first = candidates[0];
      if (active) { setNearest(first?.window ? { id: String(first.row.id), ...first.window } : null); setHasData(candidates.length > 0); setState('ready'); }
      } catch {
        if (active) setState(hasData ? 'stale' : 'error');
      }
    })();
    return () => {
      active = false;
    };
  }, [widgetApi, retry]);
  const circumference = 2 * Math.PI * 42;
  return (
    <div className="studio-deadline">
      {state === 'loading' && <p>Loading deadlines</p>}
      {(state === 'error' || state === 'stale') && <p role={state === 'error' ? 'alert' : 'status'}>{state === 'stale' ? 'Not updated, showing the last good data.' : 'Deadlines did not load.'} <button type="button" onClick={() => setRetry((n) => n + 1)}>Try again</button></p>}
      {nearest ? (
        <>
          <svg viewBox="0 0 100 100" role="img" aria-label={`${nearest.days} days left`}>
            <circle cx="50" cy="50" r="42" fill="none" stroke="var(--line)" strokeWidth="8" />
            <circle
              cx="50"
              cy="50"
              r="42"
              fill="none"
              stroke="var(--ok)"
              strokeWidth="8"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - nearest.share)}
              transform="rotate(-90 50 50)"
            />
            <text x="50" y="54" textAnchor="middle">
              {nearest.days}
            </text>
          </svg>
          <span>{nearest.id}</span>
        </>
      ) : state === 'empty' || (state === 'ready' && !hasData) ? (
        <p>No open deadlines</p>
      ) : null}
    </div>
  );
}

function CheckedDraftWidget() {
  const [draft, setDraft] = useState<CheckedDraft | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const detailsById = useRef(new Map<string, { updatedAt: string; detail: CaseData }>());
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const disputes = await getDisputes();
        let detailFailed = false;
        for (const dispute of [...disputes].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))) {
          const cached = detailsById.current.get(dispute.id);
          if (!cached || cached.updatedAt !== dispute.updated_at || !draftRef.current) {
            try {
              const detail = await getDispute(dispute.id);
              detailsById.current.set(dispute.id, { updatedAt: dispute.updated_at, detail });
              if (detail.data?.run) break;
            } catch {
              detailFailed = true;
              if (!draftRef.current) continue;
            }
          }
        }
        if (!active) return;
        const next = shapeCheckedDraft(disputes, [...detailsById.current.values()].map((item) => item.detail));
        const result = draftRefreshResult(draftRef.current, next, detailFailed);
        setDraft(result.draft);
        setLoaded(true);
        setFailed(result.state === 'error' || result.state === 'stale');
      } catch {
        if (!active) return;
        setFailed(true);
        setLoaded(true);
      }
    };
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 15000);
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [retry]);
  const state = draftLoadState(draft, loaded, failed, failed && Boolean(draft));
  return (
    <div className="studio-draft">
      {draft ? (
        <>
          {state === 'stale' && <p role="status">Not updated, showing the last good data. <button type="button" onClick={() => { setLoaded(false); setFailed(false); setRetry((value) => value + 1); }}>Try again</button></p>}
          <div className="studio-draft-title">
            <strong>{draft.caseId}</strong>
            <span>{draft.verdict}</span>
          </div>
          <div className="studio-draft-lines">
            {draft.sentences.map((sentence, index) => (
              <div className="studio-draft-line" key={`${sentence.recordId}-${index}`}>
                {sentence.dropped ? <del>{sentence.text}</del> : <span>{sentence.text}</span>}
                <span className="studio-draft-chip">{sentence.recordId}</span>
                {sentence.reason && <span className="studio-draft-reason">{sentence.reason}</span>}
              </div>
            ))}
          </div>
        </>
      ) : state === 'loading' ? <p>Loading draft</p> : state === 'empty' ? <p>No analysed draft yet</p> : (
        <p role="alert">The draft did not load. <button type="button" onClick={() => { setLoaded(false); setFailed(false); setRetry((value) => value + 1); }}>Try again</button></p>
      )}
    </div>
  );
}

const customWidgets = createWidgets({
  additionalTypes: [
    {
      id: 'tracking-paypal',
      label: 'Tracking on PayPal',
      comp: TrackingWidget,
      dataMapping: {},
      form: (params: any) => params.createDefaults({}),
      defaultSize: { width: 840, height: 240 },
      minSize: { width: 280, height: 180 },
    },
    {
      id: 'evidence-readiness',
      label: 'Evidence readiness',
      comp: EvidenceWidget,
      dataMapping: {},
      form: (params: any) => params.createDefaults({}),
      defaultSize: { width: 560, height: 280 },
      minSize: { width: 280, height: 180 },
    },
    {
      id: 'deadline-ring',
      label: 'Deadline ring',
      comp: DeadlineWidget,
      dataMapping: {},
      form: (params: any) => params.createDefaults({}),
      defaultSize: { width: 280, height: 280 },
      minSize: { width: 200, height: 200 },
    },
    {
      id: 'checked-draft',
      label: 'Checked draft',
      comp: CheckedDraftWidget,
      dataMapping: {},
      form: (params: any) => params.createDefaults({}),
      defaultSize: { width: 840, height: 280 },
      minSize: { width: 320, height: 180 },
    },
  ],
} as never);

function StudioPage() {
  const [rows, setRows] = useState<StudioRow[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const [api, setApi] = useState<import('ag-studio').AgStudioApi | null>(null);
  const [ask, setAsk] = useState('');
  const [askError, setAskError] = useState('');
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setDark(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => applyTheme(dark), [dark]);
  useEffect(() => {
    let mounted = true;
    const refresh = () =>
      loadResource(
        getDisputes,
        (disputes) => {
          if (mounted) {
            setRows(toStudioRows(disputes));
            setLoaded(true);
          }
        },
        (failed) => {
          if (mounted) setLoadFailed(failed);
        },
      );
    // Listing remains available even when preparing a sample case fails.
    if (retryKey === 0)
      void getShipNext()
        .catch(() => undefined)
        .then(refresh);
    else void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh().catch(() => undefined);
    }, 15000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh().catch(() => undefined);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      mounted = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [retryKey]);

  const data = useMemo(
    () => ({
      sources: [
        {
          id: 'disputes',
          name: 'Disputes',
          data: rows,
          fields: [
            { id: 'id', name: 'Case ID', format: 'textFormat' },
            { id: 'currency', name: 'Currency', format: 'textFormat' },
            { id: 'left_out', name: 'Cases left out of money totals', format: 'integerFormat' },
            { id: 'reason', name: 'Reason', format: 'textFormat' },
            { id: 'amount', name: 'Amount', format: 'currencyFormat', formatOptions: { format: '$#,##0.00' } },
            {
              id: 'held_amount',
              name: 'Money on hold',
              format: 'currencyFormat',
              formatOptions: { format: '$#,##0.00' },
            },
            { id: 'is_open', name: 'Open count', format: 'integerFormat' },
            { id: 'is_settled', name: 'Settled count', format: 'integerFormat' },
            { id: 'status', name: 'Status', format: 'textFormat' },
            { id: 'stage', name: 'Stage', format: 'textFormat' },
            { id: 'due', name: 'Due', format: 'dateFormat', formatOptions: { format: 'dd mmm yyyy' } },
            { id: 'created', name: 'Created', format: 'dateFormat' },
            { id: 'has_payment', name: 'Payment evidence', format: 'booleanFormat' },
            { id: 'has_order', name: 'Order evidence', format: 'booleanFormat' },
            { id: 'has_tracking', name: 'Tracking evidence', format: 'booleanFormat' },
            { id: 'filed', name: 'Filed', format: 'booleanFormat' },
          ],
        },
      ],
    }),
    [rows],
  );

  const compact = window.innerWidth < 1100;
  const initialState = useMemo(() => createInitialLayout(compact), [compact]);
  const panels = useMemo(() => ({ edit: { right: ['ai', 'edit'] as ('ai' | 'edit')[] } }), []);
  const layout = useMemo(() => ({ columns: 12, rowHeight: 12 }), []);

  const addChart = useCallback((input: ChartRequest) => (api ? addChartTo(api, input) : false), [api]);

  const ai = useCallback(
    ({ api: studioApi }: { api: import('ag-studio').AgStudioApi }) =>
      createAiHarness(studioApi, () => ({
        agents: [
          clientToolRunner({
            id: 'desk',
            description: 'Builds dispute charts from a request.',
            schema: (s) => s.undefined(),
            tools: () => [
              studioApi.defineAiTool({
                name: 'add_dispute_chart',
                description: 'Add a chart to the current report.',
                params: (s) =>
                  s.object({
                    chart: s.enum(['bar', 'pie'] as const),
                    groupBy: s.enum(['reason', 'status', 'stage'] as const),
                    metric: s.enum(['count', 'amount', 'held'] as const),
                    period: s.enum(['all', 'quarter', 'month'] as const),
                    title: s.string(),
                  }),
                execute: async (args, ctx) =>
                  addChartTo(studioApi, args)
                    ? ctx.success('Chart added.')
                    : ctx.error('The chart could not be added.'),
              }),
            ],
            run: async function* (input: AgAiRunInput, ctx) {
              if (ctx.signal?.aborted) return;
              if (shouldFinish(input.messages)) {
                yield* askToEvents(
                  { finish: true },
                  {
                    messageId: `message-${input.runId}`,
                    toolCallId: `call-${input.runId}`,
                  },
                );
                return;
              }
              try {
                const body = await requestAsk(latestUserText(input), ctx.signal);
                yield* askToEvents(body, { messageId: `message-${input.runId}`, toolCallId: `call-${input.runId}` });
              } catch (error) {
                if (!ctx.signal?.aborted)
                  yield* askToEvents(
                    { error: errorMessage(error) },
                    { messageId: `message-${input.runId}`, toolCallId: `call-${input.runId}` },
                  );
              }
            },
          }),
        ],
        primary: 'desk',
        promptStarters: [
          { label: 'Disputes by reason this quarter', prompt: 'Disputes by reason this quarter' },
          { label: 'Money on hold by stage', prompt: 'Money on hold by stage' },
          { label: 'Status split', prompt: 'Status split' },
        ],
      })),
    [addChart],
  );

  const askDirect = async (event: React.FormEvent) => {
    event.preventDefault();
    setAskError('');
    try {
      const reply = await requestAsk(ask);
      addChart({ ...reply.spec, title: reply.title });
      setAsk('');
    } catch (error) {
      setAskError(errorMessage(error));
    }
  };

  const theme = useMemo(() => makeTheme(dark), [dark]);
  return (
    <AgStudioProvider modules={[AgStudioAiModule]}>
      <div className="studio-shell">
        <header className="studio-topbar">
          <a href="/">Dispute Desk</a>
          <span>Studio</span>
        </header>
        <section className="studio-ask">
          <form onSubmit={askDirect}>
            <label htmlFor="studio-ask-input">Ask for a chart</label>
            <div>
              <input
                id="studio-ask-input"
                value={ask}
                onChange={(event) => setAsk(event.target.value)}
                placeholder="For example, disputes by reason this quarter"
              />
              <button type="submit">Add chart</button>
            </div>
          </form>
          {askError && <p role="alert">{askError}</p>}
        </section>
        {loaded && rows.some((row) => row.currency !== 'USD') && (
          <p className="muted-line">USD only, {rows.filter((row) => row.currency !== 'USD').length} case{rows.filter((row) => row.currency !== 'USD').length === 1 ? '' : 's'} in another currency left out</p>
        )}
        <div className="studio-canvas">
          {(!loaded || loadFailed) && <LoadNotice scope="cases" failed={loadFailed} stale={loaded} retry={() => setRetryKey((key) => key + 1)} />}
          {/* Studio reads its data once at start, so it is drawn after the first load */}
          {loaded && (
            <AgStudio
              data={data as never}
              initialState={initialState as never}
              layout={layout}
              mode="edit"
              panels={panels}
              aiToolDisplay={{
                add_dispute_chart: {
                  label: ({ args }) => ({
                    text: 'Add a chart',
                    pill: args.chart === 'pie' ? 'Pie chart' : 'Bar chart',
                  }),
                },
              }}
              widgets={customWidgets}
              theme={theme}
              ai={ai}
              onApiReady={(event) => {
                setApi(event.api);
                // kept on the window for the headless page check (tools/studio_run.mjs)
                (window as unknown as { studioApi: unknown }).studioApi = event.api;
              }}
            />
          )}
        </div>
      </div>
    </AgStudioProvider>
  );
}

createRoot(document.getElementById('root')!).render(<StudioPage />);
