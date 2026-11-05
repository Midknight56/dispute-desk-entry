// PayPal webhooks (reference/webhooks.md): verify with the five headers and the raw body, answer 200 at once,
// process after, and skip events whose processing finished. Pending events may be retried.

export interface PayPalEvent {
  id: string;
  event_type: string;
  create_time?: string;
  resource?: Record<string, unknown>;
}

export interface WebhookDeps {
  verify(headers: Headers, raw: string): Promise<boolean>;
  storeIfNew(ev: PayPalEvent, raw: string): Promise<boolean>;
  process(ev: PayPalEvent): Promise<void>;
  markProcessed(id: string): Promise<void>;
  waitUntil(p: Promise<unknown>): void;
}

export async function handleWebhook(req: Request, deps: WebhookDeps): Promise<Response> {
  const raw = await req.text();
  let ev: PayPalEvent;
  try {
    ev = JSON.parse(raw);
  } catch {
    return new Response("not an event", { status: 400 });
  }
  if (!ev || typeof ev.id !== "string" || typeof ev.event_type !== "string") {
    return new Response("not an event", { status: 400 });
  }
  if (!(await deps.verify(req.headers, raw))) {
    return new Response("signature not verified", { status: 400 });
  }
  if (await deps.storeIfNew(ev, raw)) {
    deps.waitUntil(
      deps
        .process(ev)
        .then(() => deps.markProcessed(ev.id))
        .catch((e) => console.log("webhook processing failed", ev.id, String(e))),
    );
  }
  return new Response("ok");
}
