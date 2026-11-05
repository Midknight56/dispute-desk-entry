// Session identity owns cases; address based usage limits stay in usage.ts.
export type Session = { id: string; fresh: boolean };
type SessionEnv = { SESSION_SECRET?: string };
const encoder = new TextEncoder();

async function key(secret: string) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}
function base64url(bytes: ArrayBuffer) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
export async function session(req: Request, env: SessionEnv): Promise<Session> {
  const value = req.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("dd_session="))
    ?.slice(11);
  if (env.SESSION_SECRET && value) {
    const match = value.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/i);
    if (match) {
      try {
        const signature = Uint8Array.from(atob(match[2].replace(/-/g, "+").replace(/_/g, "/") + "="), (c) =>
          c.charCodeAt(0),
        );
        if (await crypto.subtle.verify("HMAC", await key(env.SESSION_SECRET), signature, encoder.encode(match[1])))
          return { id: match[1], fresh: false };
      } catch {
        /* Malformed cookies start a new session. */
      }
    }
  }
  return { id: crypto.randomUUID(), fresh: true };
}
export async function sessionCookie(id: string, env: SessionEnv): Promise<string> {
  const signature = env.SESSION_SECRET
    ? base64url(await crypto.subtle.sign("HMAC", await key(env.SESSION_SECRET), encoder.encode(id)))
    : "";
  return `dd_session=${id}.${signature}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`;
}
