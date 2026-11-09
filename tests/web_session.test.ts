/// <reference lib="dom" />
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Run } from '../web/src/api';

// Exercise the panel's handlers with React hooks kept across explicit renders.
const hooks = vi.hoisted(() => ({ values: [] as any[], cursor: 0, effects: [] as (() => void)[], deps: [] as any[] }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState(initial: unknown) {
    const i = hooks.cursor++;
    if (!(i in hooks.values)) hooks.values[i] = initial;
    return [
      hooks.values[i],
      (value: unknown) => {
        hooks.values[i] = typeof value === 'function' ? value(hooks.values[i]) : value;
      },
    ];
  },
  useRef(initial: unknown) {
    const i = hooks.cursor++;
    if (!(i in hooks.values)) hooks.values[i] = { current: initial };
    return hooks.values[i];
  },
  useEffect(effect: () => void, deps: unknown[]) {
    const i = hooks.cursor++;
    if (!hooks.deps[i] || deps.some((value, j) => value !== hooks.deps[i][j])) hooks.effects.push(effect);
    hooks.deps[i] = deps;
  },
}));
vi.mock('../web/src/api', () => ({ getDispute: vi.fn(), analyseDispute: vi.fn(), approveDispute: vi.fn() }));
import { getDispute, analyseDispute, approveDispute } from '../web/src/api';
// @ts-expect-error Root typecheck excludes TSX, as in the other web tests.
import CasePanel from '../web/src/components/CasePanel';
const run = (version: string): Run => ({
  version,
  disputeId: 'A',
  decision: { verdict: 'ACCEPT', rule: '', why: version },
  sentences: [],
  dropped: [],
  records: [],
  steps: [],
  writer: 'template',
  chosenTools: [],
  usage: {},
});
const record = (id: string, draft?: Run) => ({
  id,
  status: 'WAITING_FOR_SELLER_RESPONSE',
  stage: 'CHARGEBACK',
  reason: 'OTHER',
  amount: '5',
  currency: 'USD',
  due: null,
  custom_id: null,
  updated_at: '',
  data: { run: draft },
});
function render(id: string, mine = new Set(['A', 'B']), ownerKey: string | null = null): any {
  hooks.cursor = 0;
  const tree = CasePanel({ id, mine, ownerKey, refreshKey: 0 });
  hooks.effects.splice(0).forEach((effect) => effect());
  return tree;
}
function nodes(tree: any): any[] {
  if (!tree || typeof tree !== 'object') return [];
  if (
    typeof tree.type === 'function' &&
    ['RunActions', 'LoadNotice', 'FiledOutcome', 'DecisionCard', 'DecisionFacts', 'FilingNotice'].includes(tree.type.name)
  )
    return nodes(tree.type(tree.props));
  return [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)];
}
function button(tree: any, className: string) {
  return nodes(tree).find((node) => node.type === 'button' && node.props.className === className);
}
async function load(id: string, draft?: Run) {
  vi.mocked(getDispute).mockResolvedValue(record(id, draft));
  render(id);
  await Promise.resolve();
  return render(id);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  hooks.values = [];
  hooks.deps = [];
  hooks.effects = [];
  hooks.cursor = 0;
  vi.resetAllMocks();
});
describe('case panel sessions and late answers', () => {
  it('restores analysis after PayPal checking clears an operation never sent', async () => {
    vi.mocked(getDispute).mockResolvedValue({ ...record('A', run('v1')), data: { run: run('v1'), operation: { state: 'sending', sent: false } } });
    render('A');
    await Promise.resolve();
    const check = nodes(render('A')).find(node => node.type === 'button' && node.props.children === 'Check PayPal');
    vi.mocked(approveDispute).mockResolvedValue({ kind: 'refused', detail: 'Analyse again before you approve.', operationCleared: true });
    await check.props.onClick();
    expect(button(render('A'), 'analyse-again')).toBeDefined();
    expect(nodes(render('A')).some(node => node.type === 'button' && node.props.children === 'Check PayPal')).toBe(false);
  });
  it('shows a changed facts conflict with a PayPal handoff and blocks duplicate approval', async () => {
    const tree = await load('A', run('v1'));
    const conflict = { changed: ['amount'], paypalUrl: 'https://www.sandbox.paypal.com/' };
    vi.mocked(approveDispute).mockResolvedValue({ kind: 'uncertain', message: 'Check the original filing.', operation: { state: 'uncertain' }, conflict });
    await button(tree, 'primary approve').props.onClick();
    const next = nodes(render('A'));
    expect(next.some(node => node.props?.children === 'PayPal shows different facts. The original filing is still uncertain.')).toBe(true);
    expect(next.some(node => node.type === 'a' && node.props.children === 'Open PayPal' && node.props.href === conflict.paypalUrl)).toBe(true);
    expect(next.some(node => node.type === 'button' && node.props.children === 'Check PayPal')).toBe(true);
    expect(button(render('A'), 'primary approve')).toBeUndefined();
    expect(button(render('A'), 'analyse-again')).toBeUndefined();
  });
  it('keeps an uncertain filing visible and uses Check PayPal to reconcile until filed', async () => {
    const tree = await load('A', run('v1'));
    vi.mocked(approveDispute).mockResolvedValueOnce({ kind: 'uncertain', message: 'PayPal did not confirm the filing yet.', operation: { state: 'uncertain' } });
    await button(tree, 'primary approve').props.onClick();
    const uncertainTree = render('A');
    expect(nodes(uncertainTree).some((node) => node.props?.children === 'PayPal did not confirm the filing yet.')).toBe(true);
    expect(button(uncertainTree, 'primary')).toBeUndefined();
    const check = nodes(uncertainTree).find((node) => node.type === 'button' && node.props.children === 'Check PayPal');
    expect(check).toBeDefined();
    vi.mocked(approveDispute).mockResolvedValueOnce({ kind: 'filed', filed: { ok: true, call: 'POST /provide-evidence', detail: 'Filed' }, status: 'UNDER_REVIEW', stage: 'PENDING' });
    await check.props.onClick();
    const filedTree = render('A');
    expect(nodes(filedTree).some((node) => node.props?.className === 'filed')).toBe(true);
    expect(nodes(filedTree).some((node) => node.props?.className === 'filed-detail' && node.props.children === 'Evidence sent to PayPal')).toBe(true);
    expect(approveDispute).toHaveBeenCalledTimes(2);
  });
  it('shows the first load failure and retries from the visible button, retaining a case on refresh failure', async () => {
    vi.mocked(getDispute).mockRejectedValueOnce(new Error('offline'));
    expect(nodes(render('A')).some((node) => node.props?.children === 'Loading the case')).toBe(true);
    await Promise.resolve();
    const failed = render('A');
    expect(nodes(failed).some((node) => node.props?.children === 'This case did not load.')).toBe(true);
    const retry = nodes(failed).find((node) => node.type === 'button' && node.props.children === 'Try again');
    vi.mocked(getDispute).mockResolvedValueOnce(record('A', run('loaded')));
    retry.props.onClick();
    render('A');
    await Promise.resolve();
    expect(nodes(render('A')).some((node) => node.props?.children === 'loaded')).toBe(true);
    expect(getDispute).toHaveBeenCalledTimes(2);
    vi.mocked(getDispute).mockRejectedValueOnce(new Error('refresh failed'));
    hooks.cursor = 0;
    CasePanel({ id: 'A', mine: new Set(['A']), ownerKey: null, refreshKey: 1 });
    hooks.effects.splice(0).forEach((effect) => effect());
    await Promise.resolve();
    expect(nodes(render('A')).some((node) => node.props?.children === 'loaded')).toBe(true);
  });
  it('shows REVIEW neutrally, offers Analyse again to its visitor and hides approval and money', async () => {
    const review = {
      ...run('Needs another read'),
      decision: { ...run('').decision, verdict: 'REVIEW' as const, why: 'Needs another read' },
    };
    const tree = await load('A', review);
    expect(nodes(tree).some((node) => node.props?.className === 'verdict review')).toBe(true);
    expect(nodes(tree).some((node) => node.props?.children === 'Needs another read')).toBe(true);
    expect(button(tree, 'primary').props.children).toBe('Analyse again');
    expect(button(tree, 'primary approve')).toBeUndefined();
    expect(nodes(tree).some((node) => node.props?.className === 'money-line')).toBe(false);
    expect(button(render('A', new Set()), 'primary')).toBeUndefined();
  });
  it('shows the analyse instruction after a 409 returns a stored run without version', async () => {
    const legacy = run('legacy');
    delete legacy.version;
    vi.mocked(approveDispute).mockRejectedValueOnce({ status: 409, body: { run: legacy, error: 'Conflict' } });
    await button(await load('A', run('old')), 'primary approve').props.onClick();
    expect(
      nodes(render('A')).some((node) => node.props?.children === 'Analyse again to make a new draft, then approve.'),
    ).toBe(true);
  });
  it('ignores an Analyse answer after selecting another case', async () => {
    const pending = deferred<any>();
    vi.mocked(analyseDispute).mockReturnValue(pending.promise);
    const tree = await load('A');
    const action = button(tree, 'primary').props.onClick();
    await load('B');
    pending.resolve({ run: run('late'), cap: null });
    await action;
    expect(nodes(render('B')).some((node) => node.props?.className === 'verdict refund')).toBe(false);
  });
  it('ignores an Approve answer after selecting another case', async () => {
    const pending = deferred<any>();
    vi.mocked(approveDispute).mockReturnValue(pending.promise);
    const tree = await load('A', run('read-version'));
    const action = button(tree, 'primary approve').props.onClick();
    await load('B', run('other-version'));
    pending.resolve({ filed: { ok: true, detail: 'Filed', call: 'accept' } });
    await action;
    expect(nodes(render('B')).some((node) => node.props?.className === 'filed')).toBe(false);
    expect(approveDispute).toHaveBeenCalledWith('A', 'read-version', undefined);
  });
  it.each(['analyse', 'approve'])('ignores a late %s failure after selection changes', async (action) => {
    let reject!: (reason: unknown) => void;
    const pending = new Promise<any>((_resolve, fail) => {
      reject = fail;
    });
    const initial = action === 'approve' ? run('old') : undefined;
    const tree = await load('A', initial);
    if (action === 'analyse') vi.mocked(analyseDispute).mockReturnValue(pending);
    else vi.mocked(approveDispute).mockReturnValue(pending);
    const request = button(tree, action === 'approve' ? 'primary approve' : 'primary').props.onClick();
    await load('B');
    reject({ status: 409, body: { error: 'late error', run: run('late draft') } });
    await request;
    const next = nodes(render('B'));
    expect(next.some((node) => node.props?.children === 'late error')).toBe(false);
    expect(next.some((node) => node.props?.children === 'late draft')).toBe(false);
  });
  it('shows the replacement draft and warning on 409 and sends its version on the next approval', async () => {
    vi.mocked(approveDispute).mockRejectedValueOnce({
      status: 409,
      body: { error: 'The draft changed. Read it again before you approve.', run: run('replacement') },
    });
    await button(await load('A', run('old')), 'primary approve').props.onClick();
    const tree = render('A');
    expect(nodes(tree).some((node) => node.props?.children === 'replacement')).toBe(true);
    expect(
      nodes(tree).some((node) => node.props?.children === 'The draft changed. Read it again before you approve.'),
    ).toBe(true);
    vi.mocked(approveDispute).mockResolvedValue({ kind: 'filed', filed: { ok: true, call: '', detail: '' }, status: '', stage: '' });
    await button(tree, 'primary approve').props.onClick();
    expect(approveDispute).toHaveBeenLastCalledWith('A', 'replacement', undefined);
  });
  it('hides Analyse for a case held by another visitor and allows an owner', async () => {
    await load('A');
    const otherVisitor = render('A', new Set());
    expect(button(otherVisitor, 'primary')).toBeUndefined();
    expect(
      nodes(otherVisitor).some(
        (node) => node.props?.children === 'This case belongs to another visitor. You can read it, not file it.',
      ),
    ).toBe(true);
    const tree = render('A', new Set(), 'owner');
    vi.mocked(analyseDispute).mockResolvedValue({ run: run('owner'), cap: null, neurons: 0 });
    await button(tree, 'primary').props.onClick();
    expect(analyseDispute).toHaveBeenCalledWith('A', 'owner');
  });
  it('sends the draft version and owner key in the approval API request', async () => {
    const { approveDispute: realApprove, analyseDispute: realAnalyse } =
      await vi.importActual<typeof import('../web/src/api')>('../web/src/api');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({}));
    await realApprove('A', 'read', 'owner');
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/disputes/A/approve',
      expect.objectContaining({
        body: '{"version":"read"}',
        headers: expect.objectContaining({ 'x-desk-key': 'owner' }),
      }),
    );
    await realAnalyse('A', 'owner');
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/disputes/A/analyse',
      expect.objectContaining({ headers: expect.objectContaining({ 'x-desk-key': 'owner' }) }),
    );
    fetchMock.mockRestore();
  });
});
