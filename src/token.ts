// PayPal access token: client credentials grant, cached in memory and in KV.
// PayPal's guidance (reference/authentication.md): read expires_in, cache the token, refresh before it runs out.
// We refresh 60 s early. One token lasts hours (expires_in was 32,400 s on 22 Oct), so KV sees a few writes a day.

export interface TokenEnv {
  PAYPAL_CLIENT_ID: string;
  PAYPAL_CLIENT_SECRET: string;
  PAYPAL_BASE: string;
  TOKEN: KVNamespace;
}

export const REFRESH_EARLY_MS = 60_000;
// One live approve made four PayPal calls in 10.9 s in all (docs/STATUS.md); 20 s per call leaves room without hanging a request.
export const PAYPAL_TIMEOUT_MS = 20_000;
const KV_KEY = "paypal:token";

interface Cached {
  token: string;
  expiresAt: number; // ms since epoch
}

let memory: Cached | null = null;

export async function paypalFetch(
  fetchFn: typeof fetch,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fetchFn(input, init),
      new Promise<Response>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`PayPal request timed out after ${PAYPAL_TIMEOUT_MS} ms`)),
          PAYPAL_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function resetTokenMemory() {
  memory = null;
}

export async function refreshAccessToken(env: TokenEnv, fetchFn: typeof fetch = fetch): Promise<string> {
  memory = null;
  await env.TOKEN.delete?.(KV_KEY);
  return getAccessToken(env, fetchFn);
}

function fresh(c: Cached | null, now: number): c is Cached {
  return !!c && now < c.expiresAt - REFRESH_EARLY_MS;
}

export async function getAccessToken(
  env: TokenEnv,
  fetchFn: typeof fetch = fetch,
  clock: () => number = Date.now,
): Promise<string> {
  const now = clock();
  if (fresh(memory, now)) return memory.token;

  const stored = await env.TOKEN.get(KV_KEY);
  if (stored) {
    try {
      const c = JSON.parse(stored) as Cached;
      if (fresh(c, now)) {
        memory = c;
        return c.token;
      }
    } catch {
      // a broken KV value is treated as no value
    }
  }

  const res = await paypalFetch(fetchFn, `${env.PAYPAL_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      authorization: "Basic " + btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const text = await res.text();
  if (!res.ok) {
    let name = "";
    try {
      const j = JSON.parse(text);
      name = j.error || j.name || "";
    } catch {
      // not JSON
    }
    throw new Error(`PayPal token ${res.status} ${name}`.trim());
  }
  const j = JSON.parse(text) as { access_token: string; expires_in: number };
  const c: Cached = { token: j.access_token, expiresAt: now + j.expires_in * 1000 };
  memory = c;
  // KV keeps it a little past expiry at most; the freshness check above decides use.
  await env.TOKEN.put(KV_KEY, JSON.stringify(c), { expirationTtl: Math.max(60, j.expires_in) });
  return c.token;
}
