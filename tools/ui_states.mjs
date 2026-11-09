// Local preview of the case screen in four states: Fight, Refund, Review and Filing pending.
// Serves the built page from public/dist and answers the page's API calls with saved sample data.
// The decisions and wording come from the desk's own rules (POST /api/proof/scenario on 9 Nov 2026).
// Nothing here talks to PayPal or the live desk. Run: npm run -s web:build, then node tools/ui_states.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const PORT = Number(process.env.PORT ?? 8791);
const ROOT = join(process.cwd(), 'public', 'dist');
const policy = {
  fightLine: '$10.00',
  offerShare: 'half',
  currency: 'USD',
  reasons: ['MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED'],
  note: 'Set by this desk, not by PayPal. The desk works in USD only.',
};
const due = new Date(Date.now() + 6 * 86400000 + 5 * 3600000).toISOString();
const created = new Date(Date.now() - 4 * 86400000).toISOString();
const steps = (ids, failed = '') => [
  { tool: 'get_dispute', ref: ids.d, ok: true, summary: 'Dispute read', ms: 412 },
  { tool: 'get_capture', ref: ids.c, ok: true, summary: 'Payment read', ms: 388 },
  { tool: 'get_order', ref: ids.o, ok: true, summary: 'Order read', ms: 351 },
  ...(ids.t ? [{ tool: 'get_tracking', ref: ids.t, ok: failed !== 'tracking', summary: failed === 'tracking' ? 'PayPal did not answer' : 'Tracking read', ms: 296 }] : []),
];
function fightRun(d) {
  const ids = { d, c: `CAP-${d.slice(-4)}`, o: `ORD-${d.slice(-4)}`, t: `ship-${d.slice(-4)}` };
  return {
    disputeId: d,
    version: 'v1',
    decision: {
      verdict: 'FIGHT',
      rule: 'INR_DELIVERED_BEFORE_CLAIM',
      why: 'Our shipping record shows it delivered 2 days before the claim. PayPal tracking says DELIVERED.',
      facts: [
        { label: 'Amount', value: '$24.00', recordId: ids.d },
        { label: 'Claim opened', value: '2026-10-20 12:00 UTC', recordId: ids.d },
        { label: 'Delivered (our shipping record)', value: '2026-10-18 12:00 UTC', recordId: ids.t },
      ],
      missing: [],
      disagreements: [],
      changeIf: 'A delivery date after 2026-10-20 12:00 UTC would make the desk offer half back.',
      policy,
    },
    records: [
      { id: ids.d, kind: 'dispute', summary: `Dispute ${ids.d}: item not received, $24.00, opened 2026-10-20` },
      { id: ids.c, kind: 'capture', summary: `Payment ${ids.c}: $24.00 paid on 2026-10-19` },
      { id: ids.o, kind: 'order', summary: `Order ${ids.o}: Stoneware mug, shipping to Halifax, NS` },
      { id: ids.t, kind: 'tracking', summary: `Shipping record ${ids.t}: UPS number 1Z9999999999999999, status DELIVERED, delivered 2026-10-18` },
    ],
    sentences: [
      { text: 'Our shipping record shows it delivered 2026-10-18 12:00 UTC.', record_id: ids.t },
      { text: 'The buyer paid $24.00 on 2026-10-19.', record_id: ids.c },
      { text: 'Our shipping record shows UPS number 1Z9999999999999999, status DELIVERED.', record_id: ids.t },
      { text: 'The order was Stoneware mug, shipping to Halifax, NS.', record_id: ids.o },
    ],
    dropped: [],
    steps: steps(ids),
    writer: 'model',
    chosenTools: ['get_capture', 'get_order', 'get_tracking'],
    usage: {},
  };
}
function refundRun(d) {
  const ids = { d, c: `CAP-${d.slice(-4)}`, o: `ORD-${d.slice(-4)}` };
  return {
    disputeId: d,
    version: 'v1',
    decision: {
      verdict: 'ACCEPT',
      rule: 'NO_EVIDENCE_UNDER_LINE',
      why: 'No delivery record, and $6.00 is under the $10.00 fight line.',
      facts: [
        { label: 'Amount', value: '$6.00', recordId: ids.d },
        { label: 'Fight line', value: '$10.00' },
      ],
      missing: ['A delivery record'],
      disagreements: [],
      changeIf: 'An amount of $10.00 or more would make the desk offer half back.',
      policy,
    },
    records: [
      { id: ids.d, kind: 'dispute', summary: `Dispute ${ids.d}: item not received, $6.00, opened 2026-10-20` },
      { id: ids.c, kind: 'capture', summary: `Payment ${ids.c}: $6.00 paid on 2026-10-19` },
      { id: ids.o, kind: 'order', summary: `Order ${ids.o}: Kiln log template, digital download` },
    ],
    sentences: [
      { text: 'The buyer paid $6.00 on 2026-10-19.', record_id: ids.c },
      { text: 'We accept the claim and refund in full.', record_id: ids.d },
    ],
    dropped: [],
    steps: steps(ids),
    writer: 'template',
    chosenTools: ['get_capture', 'get_order'],
    usage: {},
  };
}
function reviewRun(d) {
  const run = fightRun(d);
  const t = run.records[3].id;
  return {
    ...run,
    decision: {
      verdict: 'REVIEW',
      rule: 'READ_FAILED',
      why: 'PayPal did not return the tracking. Analyse again before you answer.',
      facts: [
        { label: 'Amount', value: '$24.00', recordId: d },
        { label: 'Tracking read', value: 'Failed', recordId: t },
      ],
      missing: ['The tracking read'],
      disagreements: [],
      changeIf: 'A successful tracking read would let the desk decide this case again.',
      policy,
    },
    records: run.records.slice(0, 3),
    sentences: [{ text: 'The buyer paid $24.00 on 2026-10-19.', record_id: run.records[1].id }],
    steps: steps({ d, c: run.records[1].id, o: run.records[2].id, t }, 'tracking'),
    writer: 'template',
  };
}
const cases = {
  'PP-D-SHOT-0001': { amount: '24.00', run: fightRun('PP-D-SHOT-0001'), kind: 'fight' },
  'PP-D-SHOT-0002': { amount: '6.00', run: refundRun('PP-D-SHOT-0002'), kind: 'accept' },
  'PP-D-SHOT-0003': { amount: '24.00', run: reviewRun('PP-D-SHOT-0003'), kind: 'fight' },
  'PP-D-SHOT-0004': { amount: '24.00', run: fightRun('PP-D-SHOT-0004'), kind: 'fight', operation: { state: 'uncertain', id: 'op-1' } },
};
const row = (id) => ({
  id,
  status: 'WAITING_FOR_SELLER_RESPONSE',
  stage: 'CHARGEBACK',
  reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
  amount: cases[id].amount,
  currency: 'USD',
  due,
  created,
  custom_id: null,
  updated_at: created,
  verdict: cases[id].run.decision.verdict === 'REVIEW' ? null : cases[id].run.decision.verdict,
});
const feed = Object.keys(cases).flatMap((id, i) => [
  { seq: 10 * i + 3, at: new Date(Date.now() - i * 60000).toISOString(), kind: 'agent', title: `verdict ${cases[id].run.decision.verdict}`, ref: id, detail: '' },
  { seq: 10 * i + 2, at: new Date(Date.now() - i * 60000 - 2000).toISOString(), kind: 'agent', title: 'get_capture', ref: cases[id].run.records[1].id, detail: '' },
  { seq: 10 * i + 1, at: new Date(Date.now() - i * 60000 - 4000).toISOString(), kind: 'webhook', title: 'CUSTOMER.DISPUTE.CREATED', ref: id, detail: '' },
]).sort((a, b) => b.seq - a.seq);

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const json = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  if (path === '/api/disputes') return json(res, Object.keys(cases).map(row));
  const one = path.match(/^\/api\/disputes\/([^/]+)$/);
  if (one && cases[decodeURIComponent(one[1])]) {
    const id = decodeURIComponent(one[1]);
    return json(res, { ...row(id), data: { run: cases[id].run, ...(cases[id].operation ? { operation: cases[id].operation } : {}) } });
  }
  if (path === '/api/me') return json(res, { cases: Object.entries(cases).map(([dispute_id, c]) => ({ dispute_id, kind: c.kind })) });
  if (path === '/api/feed') return json(res, feed);
  if (path === '/api/judge/next') return json(res, { disputeId: 'PP-D-SHOT-0001', replay: false, fresh: false });
  if (path.startsWith('/api/')) return json(res, { error: 'Not in the preview.' }, 404);
  const file = normalize(join(ROOT, path === '/' ? 'index.html' : path));
  if (!file.startsWith(ROOT)) return json(res, { error: 'no' }, 403);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    json(res, { error: 'Not found' }, 404);
  }
}).listen(PORT, '127.0.0.1', () => console.log(`preview on http://127.0.0.1:${PORT}/`));
