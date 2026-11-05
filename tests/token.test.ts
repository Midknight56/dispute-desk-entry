import { describe, it, expect, beforeEach } from "vitest";
import { getAccessToken, resetTokenMemory, type TokenEnv } from "../src/token";

// A KV namespace stand in: only get and put are used by the token cache.
function memoryKv() {
  const data = new Map<string, string>();
  return {
    data,
    async get(key: string) {
      return data.has(key) ? data.get(key)! : null;
    },
    async put(key: string, value: string) {
      data.set(key, value);
    },
  };
}

function fakePayPal(expiresIn = 32400) {
  const calls: { url: string; init: RequestInit }[] = [];
  let n = 0;
  const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    n += 1;
    return new Response(JSON.stringify({ access_token: `tok-${n}`, expires_in: expiresIn, token_type: "Bearer" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetchFn: fetchFn as typeof fetch };
}

describe("PayPal access token cache", () => {
  let env: TokenEnv;
  let kv: ReturnType<typeof memoryKv>;

  beforeEach(() => {
    resetTokenMemory();
    kv = memoryKv();
    env = {
      PAYPAL_CLIENT_ID: "id-for-test",
      PAYPAL_CLIENT_SECRET: "secret-for-test",
      PAYPAL_BASE: "https://api-m.sandbox.paypal.com",
      TOKEN: kv as unknown as KVNamespace,
    };
  });

  it("fetches the token once and reuses it until 60 s before expiry", async () => {
    const pp = fakePayPal(3600);
    let now = 1_000_000;
    const clock = () => now;

    const a = await getAccessToken(env, pp.fetchFn, clock);
    now += 1000 * (3600 - 61); // 61 s before expiry: still good
    const b = await getAccessToken(env, pp.fetchFn, clock);

    expect(a).toBe("tok-1");
    expect(b).toBe("tok-1");
    expect(pp.calls.length).toBe(1);
  });

  it("fetches a new token inside the last 60 s", async () => {
    const pp = fakePayPal(3600);
    let now = 1_000_000;
    const clock = () => now;

    await getAccessToken(env, pp.fetchFn, clock);
    now += 1000 * (3600 - 59); // 59 s before expiry: refresh
    const b = await getAccessToken(env, pp.fetchFn, clock);

    expect(b).toBe("tok-2");
    expect(pp.calls.length).toBe(2);
  });

  it("reuses the KV copy in a fresh isolate without calling PayPal", async () => {
    const pp = fakePayPal(3600);
    const clock = () => 1_000_000;
    await getAccessToken(env, pp.fetchFn, clock);
    resetTokenMemory(); // a new isolate has no memory copy
    const b = await getAccessToken(env, pp.fetchFn, clock);
    expect(b).toBe("tok-1");
    expect(pp.calls.length).toBe(1);
  });

  it("calls the documented token endpoint with Basic auth and the client credentials grant", async () => {
    const pp = fakePayPal();
    await getAccessToken(env, pp.fetchFn, () => 0);
    const { url, init } = pp.calls[0];
    expect(url).toBe("https://api-m.sandbox.paypal.com/v1/oauth2/token");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Basic " + btoa("id-for-test:secret-for-test"));
    expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(String(init.body)).toBe("grant_type=client_credentials");
  });

  it("throws with the HTTP code and never the secret when PayPal refuses", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 })) as unknown as typeof fetch;
    const err = await getAccessToken(env, fetchFn, () => 0).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("401");
    expect((err as Error).message).toContain("invalid_client");
    expect((err as Error).message).not.toContain("secret-for-test");
  });
});
