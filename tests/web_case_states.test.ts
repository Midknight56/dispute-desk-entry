import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Run } from '../web/src/api';
import { approveDispute } from '../web/src/api';
import { approvalMessage, citation, decisionView, filingNeedsCheck, loadResource, recordType } from '../web/src/components/caseView';
import { feedSentence } from '../web/src/components/feedSentence';
// @ts-expect-error Vitest handles TSX; the server project does not enable JSX.
import { DecisionFacts, FiledOutcome, LoadNotice, RunActions } from '../web/src/components/CaseStates';
// @ts-expect-error Vitest handles TSX; the server project does not enable JSX.
import CasePanel from '../web/src/components/CasePanel';

const run: Run = {
  disputeId: 'D1',
  decision: {
    verdict: 'FIGHT',
    rule: 'test',
    why: 'Delivered before the claim',
    facts: [{ label: 'Paid', value: '$48.00', recordId: 'FULL-PAYMENT-ID' }],
    missing: ['A signature'],
    changeIf: 'A later delivery',
    disagreements: ['Amounts differ'],
  },
  records: [{ id: 'FULL-PAYMENT-ID', kind: 'capture', summary: 'Paid in full' }],
  sentences: [{ text: 'The buyer paid.', record_id: 'FULL-PAYMENT-ID' }],
  dropped: [{ text: 'Unbacked', record_id: 'FULL-PAYMENT-ID' }],
  steps: [],
  writer: 'template',
  chosenTools: [],
  usage: {},
};

describe('case and Studio loading', () => {
  it.each(['case', 'cases'] as const)('shows the %s first load failure and retries successfully', async (scope) => {
    let failed = false;
    let saved: string | null = null;
    const fetch = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue('loaded');
    const retry = () =>
      loadResource(
        fetch,
        (value) => {
          saved = value;
        },
        (value) => {
          failed = value;
        },
      );
    const loading = renderToStaticMarkup(createElement(LoadNotice, { scope, failed, retry }));
    expect(loading).toContain(scope === 'case' ? 'Loading the case' : 'Loading the cases');
    await retry();
    expect(failed).toBe(true);
    expect(saved).toBeNull();
    const notice = createElement(LoadNotice, { scope, failed, retry });
    const html = renderToStaticMarkup(notice);
    expect(html).toContain(scope === 'case' ? 'This case did not load.' : 'The cases did not load.');
    expect(html).toContain('Try again');
    await notice.props.retry();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(saved).toBe('loaded');
    expect(failed).toBe(false);
    fetch.mockRejectedValueOnce(new Error('refresh failed'));
    await retry();
    expect(saved).toBe('loaded');
  });
});

describe('case evidence and outcomes', () => {
  it('renders decision sections, typed citations, full accessible ids, and typed dropped records', () => {
    const html = renderToStaticMarkup(
      createElement(CasePanel, {
        id: 'D1',
        refreshKey: 0,
        mine: new Set(['D1']),
        ownerKey: null,
        replay: {
          label: 'Replay',
          run,
          dispute: {
            id: 'D1',
            amount: '48',
            currency: 'USD',
            status: 'WAITING_FOR_SELLER_RESPONSE',
            reason: 'OTHER',
            stage: 'INQUIRY',
            due: null,
            custom_id: null,
          },
        },
      }),
    );
    for (const text of [
      'Why',
      'Paid',
      '$48.00',
      'Not found',
      'A signature',
      'This would change it',
      'A later delivery',
      'Records that disagree',
      'Amounts differ',
    ])
      expect(html).toContain(text);
    expect(html).toContain('aria-label="Payment FULL-PAYMENT-ID: Paid in full"');
    expect(html).toContain('>Payment</button>');
    expect(html).toContain('FULL-PAYMENT-ID: Paid in full</span>');
    expect(html).toContain('<s>Unbacked</s> <span title="FULL-PAYMENT-ID">Payment</span>');
    expect(citation('FULL-PAYMENT-ID', run.records).label).toBe('Payment');
    expect(['capture', 'order', 'tracking', 'dispute'].map(recordType)).toEqual([
      'Payment',
      'Order',
      'Shipping',
      'Dispute',
    ]);
  });
  it('renders no decision sections for an old run', () => {
    const old = { ...run, decision: { verdict: 'ACCEPT', rule: 'old', why: 'Old decision' } } as Run;
    expect(renderToStaticMarkup(createElement(DecisionFacts, { run: old }))).toBe('<div class="decision-facts"></div>');
  });
  it('labels model and template writers separately', () => {
    const modelRun = { ...run, writer: 'model' as const };
    const modelHtml = renderToStaticMarkup(createElement(CasePanel, { id: 'D1', refreshKey: 0, mine: new Set(['D1']), ownerKey: null, replay: { label: 'Replay', run: modelRun, dispute: { id: 'D1', amount: '48', currency: 'USD', status: 'WAITING_FOR_SELLER_RESPONSE', reason: 'OTHER', stage: 'INQUIRY', due: null, custom_id: null } } }));
    const templateHtml = renderToStaticMarkup(createElement(CasePanel, { id: 'D1', refreshKey: 0, mine: new Set(['D1']), ownerKey: null, replay: { label: 'Replay', run, dispute: { id: 'D1', amount: '48', currency: 'USD', status: 'WAITING_FOR_SELLER_RESPONSE', reason: 'OTHER', stage: 'INQUIRY', due: null, custom_id: null } } }));
    expect(modelHtml).toContain('The model chose these facts. Each line is written from the records.');
    expect(templateHtml).toContain('Written from the records by the template');
  });
  it('maps a 202 filing to uncertain without reading a missing filed result', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 202, ok: true, json: async () => ({ error: 'Not confirmed', operation: { state: 'uncertain', id: 'op1' } }) });
    vi.stubGlobal('fetch', fetchMock);
    await expect(approveDispute('D1', 'v1')).resolves.toEqual({ kind: 'uncertain', message: 'PayPal did not confirm the filing yet.', operation: { state: 'uncertain', id: 'op1' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
  it('restores the check state from stored sending or uncertain operations', () => {
    expect(filingNeedsCheck(undefined, { state: 'sending' })).toBe(true);
    expect(filingNeedsCheck(undefined, { state: 'uncertain' })).toBe(true);
    expect(filingNeedsCheck(undefined, { state: 'complete' })).toBe(false);
    expect(filingNeedsCheck({ call: '', ok: true, detail: '' }, { state: 'uncertain' })).toBe(false);
  });
  it('keeps 409 run conflicts thrown and reports a 200 as filed', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ status: 200, ok: true, json: async () => ({ filed: { call: 'POST /file', ok: true, detail: 'Filed' }, status: 'UNDER_REVIEW', stage: 'PENDING' }) })
      .mockResolvedValueOnce({ status: 409, ok: false, json: async () => ({ error: 'Version changed', run }) });
    vi.stubGlobal('fetch', fetchMock);
    await expect(approveDispute('D1', 'v1')).resolves.toMatchObject({ kind: 'filed', filed: { ok: true } });
    await expect(approveDispute('D1', 'v1')).rejects.toMatchObject({ status: 409, body: { run } });
    vi.unstubAllGlobals();
  });
  it.each([
    ['provide-evidence', 'Evidence sent to PayPal'],
    ['accept-claim', 'Refund accepted'],
    ['make-offer', 'Offer sent'],
    ['provide-supporting-info', 'Note sent to PayPal'],
  ])('renders the plain %s outcome with the call in Details', (action, sentence) => {
    const call = `POST /v1/customer/disputes/{id}/${action}`;
    expect(renderToStaticMarkup(createElement(FiledOutcome, { call }))).toBe(
      `<p class="filed-detail">${sentence}</p><details><summary>Details</summary><span>${call}</span></details>`,
    );
  });
  it('uses neutral REVIEW and enables analysis instead of approval or money', () => {
    expect(decisionView({ ...run.decision, verdict: 'REVIEW' })).toMatchObject({
      tone: 'review',
      approve: false,
      money: false,
      analyseClass: 'primary',
    });
    const props = {
      run: { ...run, decision: { ...run.decision, verdict: 'REVIEW' as const } },
      amount: '48',
      currency: 'USD',
      canAnalyse: true,
      canApprove: true,
      busy: false,
      error: '',
      analyse: () => {},
      approve: () => {},
    };
    const html = renderToStaticMarkup(createElement(RunActions, props));
    expect(html).toContain('class="primary">Analyse again</button>');
    expect(html).not.toContain('approve');
    expect(html).not.toContain('money-line');
    expect(renderToStaticMarkup(createElement(RunActions, { ...props, canAnalyse: false }))).toBe('');
    const refund = renderToStaticMarkup(
      createElement(RunActions, { ...props, run: { ...run, decision: { ...run.decision, verdict: 'ACCEPT' } } }),
    );
    expect(refund).toContain('money-line');
    expect(refund).toContain('Refund to buyer');
    expect(refund).toContain('$48.00');
    expect(refund).toContain('Accept and refund $48.00');
    expect(decisionView(run.decision)).toMatchObject({
      tone: 'fight',
      approve: true,
      money: true,
      analyseClass: 'analyse-again',
    });
  });
  it('explains a legacy 409 and preserves current conflict details', () => {
    expect(approvalMessage(409, { run, error: 'Conflict' }, 'Fallback')).toBe(
      'Analyse again to make a new draft, then approve.',
    );
    expect(approvalMessage(409, { run: { ...run, version: 'v2' }, error: 'New draft' }, 'Fallback')).toBe('New draft');
    expect(approvalMessage(422, { filed: { call: '', ok: false, detail: 'Refused' } }, 'Fallback')).toBe('Refused');
    expect(approvalMessage(500, undefined, 'Fallback')).toBe('Fallback');
  });
  it('wires tested helpers into both live loading paths and REVIEW controls', async () => {
    const fsModule = 'fs';
    const { readFileSync } = await import(fsModule);
    const panel = readFileSync('web/src/components/CasePanel.tsx', 'utf8');
    const studio = readFileSync('web/src/studio/main.tsx', 'utf8');
    const connected = (source: string, fragment: string) =>
      expect(source.replace(/\s/g, '')).toContain(fragment.replace(/\s/g, ''));
    connected(panel, 'loadResource(() => getDispute(id)');
    connected(panel, 'scope="case" failed={loadFailed} retry={() => setRetryKey');
    connected(panel, '[id, refreshKey, replay, retryKey]');
    connected(studio, 'loadResource(getDisputes');
    connected(studio, 'scope="cases" failed={loadFailed} stale={loaded} retry={() => setRetryKey');
    connected(studio, '}, [retryKey])');
    connected(panel, '<RunActions run={run}');
    connected(panel, 'canAnalyse={canAnalyse&&!filingUncertain}');
    connected(panel, 'canApprove={canApprove && !filed && !filingUncertain}');
    connected(panel, 'approvalMessage((e as { status?: number }).status, body');
    connected(panel, 'filingNeedsCheck(data.data?.filed,data.data?.operation)');
    connected(panel, '<FilingNotice id={id} conflict={conflict} busy={busy} check={approve}');
  });
});

describe('feed sentences for every server title', () => {
  const titles = [
    ['call', 'GET /v1/customer/disputes/{id}', 'The desk read the dispute'],
    ['call', 'POST /v2/checkout/orders/{id}/track', 'The desk sent tracking to PayPal'],
    ['call', 'PUT /v1/shipping/trackers/{id}', 'The desk updated delivery on PayPal'],
    ['call', 'POST /v1/customer/disputes/{id}/provide-evidence', 'The desk sent evidence'],
    ['call', 'POST /v1/customer/disputes/{id}/provide-supporting-info', 'The desk sent a note to PayPal'],
    ['call', 'POST /v1/customer/disputes/{id}/accept-claim', 'The desk accepted the claim'],
    ['call', 'POST /v1/customer/disputes/{id}/make-offer', 'The desk sent an offer'],
    ['call', 'file refused', 'Filing refused: Detail'],
    ['call', 'refresh failed', 'Refresh failed, the filing is saved'],
    ['agent', 'get_dispute', 'The desk read the dispute'],
    ['agent', 'get_capture', 'The desk read the payment'],
    ['agent', 'get_order', 'The desk read the order'],
    ['agent', 'get_tracking', 'The desk checked shipping'],
    ['agent', 'get_delivery_date', 'The desk checked the delivery date'],
    ['agent', 'get_invoice', 'The desk checked for an invoice'],
    ['agent', 'verdict FIGHT', 'The desk recommends sending evidence'],
    ['agent', 'verdict ACCEPT', 'The desk recommends a refund'],
    ['agent', 'verdict OFFER', 'The desk recommends an offer'],
    ['agent', 'verdict REVIEW', 'The case needs review'],
    ['agent', 'evidence pack', 'The evidence pack could not be built'],
    ['webhook', 'CUSTOMER.DISPUTE.CREATED', 'PayPal opened a dispute'],
    ['webhook', 'CUSTOMER.DISPUTE.UPDATED', 'PayPal sent an update'],
    ['webhook', 'CUSTOMER.DISPUTE.RESOLVED', 'PayPal resolved a dispute'],
    ['webhook', 'PAYMENT.CAPTURE.COMPLETED', 'PayPal confirmed a payment'],
    ['webhook', 'ANY.FUTURE.EVENT', 'Detail'],
    ['note', 'anything', 'Detail'],
    ['agent', 'unknown', 'Detail'],
    ['call', 'unknown', 'Detail'],
  ] as const;
  it.each(titles)('%s %s', (kind, title, expected) =>
    expect(feedSentence({ kind, title, detail: 'Detail' })).toBe(expected),
  );
});
