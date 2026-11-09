import { vi } from 'vitest';
import { createD1 } from './d1';
import type { Env } from '../../src/index';

type Reply = { response: unknown; usage?: { prompt_tokens?: number; completion_tokens?: number } };

export async function makeEnv() {
  const migrations = [
    'migrations/0001_init.sql',
    'migrations/0002_runs.sql',
    'migrations/0003_pool.sql',
    'migrations/0004_shipments.sql',
    'migrations/0005_meta.sql',
    'migrations/0006_sales.sql',
    'migrations/0007_event_done.sql',
    'migrations/0008_event_claim.sql',
  ];
  const DB = await createD1(migrations);
  const LEDGER = await createD1(['migrations-ledger/0001_ai_calls.sql']);
  const kv = new Map<string, string>();
  const replies: Reply[] = [];
  const env = {
    DB,
    LEDGER,
    TOKEN: {
      async get(key: string) {
        return kv.get(key) ?? null;
      },
      async put(key: string, value: string) {
        kv.set(key, value);
      },
    },
    AI: {
      async run() {
        return replies.shift() ?? { response: '', usage: {} };
      },
    },
    PAYPAL_BASE: 'https://api.test',
    PAYPAL_CLIENT_ID: 'id-for-test',
    PAYPAL_CLIENT_SECRET: 'secret-for-test',
    PAYPAL_WEBHOOK_ID: 'WH-ID',
    DESK_OWNER_KEY: 'owner-for-test',
    SESSION_SECRET: 'fixed-session-secret-for-tests',
  } as unknown as Env;
  return { env, replies, DB, LEDGER };
}

export function fakePayPal(routes: Record<string, { json: unknown; status?: number }>) {
  const calls: { method: string; path: string; body?: string; headers: Headers }[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const path = url.pathname + url.search;
    calls.push({ method, path, body: typeof init.body === 'string' ? init.body : undefined, headers: new Headers(init.headers) });
    if (path === '/v1/oauth2/token') return Response.json({ access_token: 'token-for-test', expires_in: 3600 });
    const route = routes[`${method} ${path}`] ?? routes[`${method} ${url.pathname}`];
    return route
      ? Response.json(route.json, { status: route.status ?? 200 })
      : Response.json({ name: 'RESOURCE_NOT_FOUND' }, { status: 404 });
  });
  return calls;
}

// PayPal answers for pool cases that are still open and actionable, for tests that ask /api/judge/next.
export function actionableRoutes(ids: string[]) {
  return Object.fromEntries(
    ids.map((id) => [
      `GET /v1/customer/disputes/${id}`,
      { json: { dispute_id: id, status: 'WAITING_FOR_SELLER_RESPONSE', links: [{ rel: 'provide_evidence' }, { rel: 'accept_claim' }, { rel: 'make_offer' }] } },
    ]),
  );
}

export function ctx() {
  const promises: Promise<unknown>[] = [];
  return {
    context: {
      waitUntil(promise: Promise<unknown>) {
        promises.push(promise);
      },
    } as unknown as ExecutionContext,
    async wait() {
      await Promise.all(promises);
    },
  };
}
