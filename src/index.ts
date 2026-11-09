import { MODEL, runAgent, type AgentRun, type ModelFn, type Shipment } from "./agent";
import { ASK_SYSTEM, chartData, chartTitle, keywordSpec, parseSpec, type ChartRow } from "./ask";
import {
  ACCOUNT_NEURONS_PER_DAY, APP_NEURONS_PER_DAY, checkCaps, NEURONS_PER_RUN_ESTIMATE,
  NEURONS_PER_RUN_MAX, NEURONS_PER_ASK_MAX, MODEL_BOUNDS, boundMessages, neuronsFor,
} from "./caps";
import { approvalBasis, fileResponse, noteFrom, operationTookEffect, responseAction, type ApprovalBasis, type FilingOperation } from "./file";
import { paypal, PayPalError, type PayPalEnv } from "./paypal";
import { store } from "./store";
import { finishRun, readUsage, recordRun, reserveRun, reserveNeurons, utcDay, visitorId } from "./usage";
import { handleWebhook, type PayPalEvent } from "./webhooks";
import { needsSync } from "./sync";
import { nextForJudge, poolCounts, checkActionable, verifyFree, type CaseKind, type DisputeCheck } from "./judge";
import { replayDraft, replayById } from "./replay";
import { checkSentence, runProof } from "./proof";
import { compareScenario, scenarioOptions } from "./scenario";
import { buildPack } from "./pack";
import { session, sessionCookie } from "./session";
import { shipState } from "./ship";

export interface Env extends PayPalEnv {
  DB: D1Database;
  LEDGER: D1Database;
  AI: Ai;
  PAYPAL_WEBHOOK_ID: string;
  DESK_OWNER_KEY?: string;
  SESSION_SECRET?: string;
  ASSETS: Fetcher;
}

function judgeCheck(env: Env, kind: CaseKind): DisputeCheck {
  const pp = paypal(env);
  return async (disputeId) => {
    let dispute: any;
    try {
      dispute = await pp.getDispute(disputeId);
    } catch {
      return { ok: false, retire: false, why: "read failure" };
    }
    return checkActionable(dispute, kind);
  };
}

const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};
const contentSecurityPolicy =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

function secure(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(securityHeaders)) headers.set(name, value);
  if ((headers.get("content-type") ?? "").includes("text/html"))
    headers.set("Content-Security-Policy", contentSecurityPolicy);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// Who may file on a dispute: the judge it was handed to, or the owner with the desk key. Filing moves real
// sandbox money and closes a case, so a visitor cannot file on someone else's dispute.
async function mayFile(req: Request, env: Env, id: string, sessionId: string): Promise<boolean> {
  const key = req.headers.get("x-desk-key");
  if (env.DESK_OWNER_KEY && key && key === env.DESK_OWNER_KEY) return true;
  const row = await env.DB.prepare("SELECT handed_to FROM pool WHERE dispute_id = ?")
    .bind(id)
    .first<{ handed_to: string | null }>();
  return !!row?.handed_to && row.handed_to === sessionId;
}

// Only disputes on this app's own orders: the shared sandbox app serves five apps, and ours carry custom_id dd-.
export function isOurs(dispute: any): boolean {
  return (dispute?.disputed_transactions ?? []).some((t: any) => String(t?.custom ?? "").startsWith("dd-"));
}

export async function syncDispute(env: Env, id: string) {
  const pp = paypal(env);
  const s = store(env.DB);
  const d = await pp.getDispute(id);
  if (!isOurs(d)) return null;
  await s.putDispute({
    id: d.dispute_id,
    status: d.status,
    stage: d.dispute_life_cycle_stage,
    reason: d.reason,
    amount: d.dispute_amount?.value,
    currency: d.dispute_amount?.currency_code,
    due: d.seller_response_due_date ?? null,
    customId: d.disputed_transactions?.[0]?.custom,
    data: { dispute: d },
  });
  await s.feed({
    kind: "call",
    title: "GET /v1/customer/disputes/{id}",
    ref: d.dispute_id,
    detail: `${d.status} ${d.dispute_life_cycle_stage}`,
  });
  return d;
}

async function processEvent(env: Env, ev: PayPalEvent) {
  const s = store(env.DB);
  const ref = String(ev.resource?.["dispute_id"] ?? ev.resource?.["id"] ?? "");
  const feed = () => s.feed({ kind: "webhook", title: ev.event_type, ref, detail: `event ${ev.id}` });
  // The shared sandbox app sends every app's events to every registered URL: keep only our dd- sales.
  if (ev.event_type.startsWith("CUSTOMER.DISPUTE.")) {
    if (ref && isOurs(ev.resource)) {
      await feed();
      await syncDispute(env, ref);
    }
  } else if (String(ev.resource?.["custom_id"] ?? "").startsWith("dd-")) {
    const r = ev.resource as any;
    const orderId = r?.supplementary_data?.related_ids?.order_id;
    // A capture without its order id cannot get tracking later, so it is not kept as a sale.
    if (ev.event_type === "PAYMENT.CAPTURE.COMPLETED" && orderId && r?.amount?.value) {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO sales (capture_id, order_id, custom_id, amount, currency, captured_at, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(
          r.id,
          orderId,
          r.custom_id,
          r.amount.value,
          r.amount.currency_code,
          r.create_time,
          new Date().toISOString(),
        )
        .run();
    }
    await feed();
  }
}

export function workersAi(env: Env, accounting: { uncertain: boolean }): ModelFn {
  return async (messages, kind) => {
    try {
      const r: any = await env.AI.run(MODEL as any, {
        messages: boundMessages(messages, kind),
        max_tokens: MODEL_BOUNDS[kind].maxTokens,
        temperature: 0.2,
      } as any);
      const known = [r?.usage?.prompt_tokens, r?.usage?.completion_tokens].every(
        (value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
      );
      if (!known) accounting.uncertain = true;
      return {
        text:
          typeof r?.choices?.[0]?.message?.content === "string"
            ? r.choices[0].message.content
            : typeof r?.response === "string"
              ? r.response
              : JSON.stringify(r?.response ?? ""),
        usage: known ? r.usage : undefined,
      };
    } catch (error) {
      accounting.uncertain = true;
      throw error;
    }
  };
}

async function analyse(req: Request, env: Env, id: string): Promise<Response> {
  const s = store(env.DB);
  const pp = paypal(env);
  // A dispute PayPal cannot return (404 on a made up id) is simply not one of ours, never a crash.
  const rec = await s.getDispute(id);
  if (waitingForFiling(rec?.data)) return filingWaiting(rec?.data);
  const d = rec?.data?.dispute ?? (await syncDispute(env, id).catch(() => null));
  if (!d || !isOurs(d)) return Response.json({ error: "not one of this desk's disputes" }, { status: 404 });

  const day = utcDay();
  const visitor = await visitorId(req);
  let cap = checkCaps(await readUsage(env.DB, env.LEDGER, visitor, day));
  const reservation = cap.ok ? await reserveRun(env.DB, { day, visitor, disputeId: id }) : null;
  if (cap.ok && !reservation) cap = checkCaps(await readUsage(env.DB, env.LEDGER, visitor, day));
  const neuronReservationId = cap.ok && reservation ? await reserveNeurons(env.LEDGER, day) : null;
  const budget = neuronReservationId !== null;
  if (cap.ok && !budget) cap = checkCaps(await readUsage(env.DB, env.LEDGER, visitor, day));
  const accounting = { uncertain: false };

  let run: AgentRun & { basis?: ApprovalBasis };
  let basis: ApprovalBasis | undefined;
  try {
    run = await runAgent(id, {
      policy: env as Env & { FIGHT_LINE_USD?: unknown; OFFER_SHARE?: unknown },
      getDispute: async (x) => {
        const dispute = await pp.getDispute(x);
        basis = approvalBasis(dispute);
        return dispute;
      },
      getCapture: (x) => pp.getCapture(x),
      getOrder: (x) => pp.getOrder(x),
      getTracker: (x) => pp.getTracker(x),
      deliveredAt: async (tid) =>
        // the delivery time lives in `delivered` (trackers put on PayPal first) or in `shipments` (put on at filing)
        (
          await env.DB.prepare(
            "SELECT at FROM delivered WHERE tracker_id = ?1 UNION ALL SELECT delivered_at FROM shipments WHERE tracker_id = ?1 AND delivered_at IS NOT NULL",
          )
            .bind(tid)
            .first<{ at: string }>()
        )?.at,
      shipment: async (custom) =>
        (await env.DB.prepare("SELECT * FROM shipments WHERE custom_id = ?").bind(custom).first<Shipment>()) ??
        undefined,
      model: budget ? workersAi(env, accounting) : undefined,
      onStep: (st) => s.feed({ kind: "agent", title: st.tool, ref: st.ref, detail: st.summary }),
    });
  } catch (error) {
    if (reservation)
      await env.DB.prepare("DELETE FROM runs WHERE at = ? AND writer = 'reserved'").bind(reservation).run();
    return Response.json(
      { error: `Could not analyse dispute: ${String((error as Error)?.message ?? error)}` },
      { status: 502 },
    );
  }
  const neurons = accounting.uncertain
    ? Math.max(NEURONS_PER_RUN_MAX, neuronsFor(run.usage))
    : neuronsFor(run.usage);
  if (reservation)
    await finishRun(env.DB, env.LEDGER, reservation, neuronReservationId, { day, writer: run.writer, neurons, uncertain: accounting.uncertain });
  else await recordRun(env.DB, env.LEDGER, { day, visitor, disputeId: id, writer: run.writer, neurons });
  await s.feed({
    kind: "agent",
    title: `verdict ${run.decision.verdict}`,
    ref: id,
    detail: `${run.decision.why} ${run.sentences.length} sentences kept, ${run.dropped.length} dropped, ${run.writer}`,
  });

  run.version = crypto.randomUUID();
  if (basis) run.basis = { ...basis, offerAmount: run.decision.offerAmount ?? null };
  const fresh = await pp.getDispute(id);
  const saved = await s.putDispute({
    id,
    status: fresh.status,
    stage: fresh.dispute_life_cycle_stage,
    reason: fresh.reason,
    amount: fresh.dispute_amount?.value,
    currency: fresh.dispute_amount?.currency_code,
    due: fresh.seller_response_due_date ?? null,
    customId: fresh.disputed_transactions?.[0]?.custom,
    data: { dispute: fresh, run, neurons },
  });
  if (!saved) return filingWaiting();
  return Response.json({ run, neurons, cap: cap.ok ? null : cap.message });
}

const FILING_HOLD_MS = 120_000;

function waitingForFiling(data: any): boolean {
  return ["sending", "uncertain"].includes(data?.operation?.state) || data?.filing >= Date.now() - FILING_HOLD_MS;
}

function filingWaiting(data?: any) {
  if (data?.filingConflict) return Response.json({
    error: "PayPal shows different facts. Use Check PayPal or open PayPal to review the original filing.",
    conflict: data.filingConflict, operation: data.operation,
  }, { status: 409 });
  return Response.json({ error: "A filing is waiting for PayPal. Use Check PayPal before you continue." }, { status: 409 });
}

function filingUncertain(operation: FilingOperation) {
  return Response.json({
    error: "PayPal did not confirm the filing. The desk will check before it sends anything else.", operation,
  }, { status: 202 });
}

type StoredDispute = { amount?: string; currency?: string; reason?: string; data: any };

function buildStoredPack(id: string, rec: StoredDispute, run: AgentRun): Promise<Uint8Array> {
  return buildPack({
    disputeId: id,
    amount: rec.amount ?? "0.00",
    currency: rec.currency ?? "",
    reason: rec.reason ?? "",
    verdict: run.decision.verdict,
    why: [rec.data.reconstructionLabel, run.decision.why].filter(Boolean).join(" "),
    sentences: run.sentences,
    records: run.records,
    filed: rec.data.filed,
    generatedAt: new Date().toISOString(),
  });
}

async function approve(req: Request, env: Env, id: string): Promise<Response> {
  const s = store(env.DB);
  const pp = paypal(env);
  const rec = await s.getDispute(id);
  const run: (AgentRun & { basis?: ApprovalBasis }) | undefined = rec?.data?.run;
  if (!rec || !run) return Response.json({ error: "analyse this dispute first" }, { status: 409 });
  const body = (await req.json().catch(() => null)) as { version?: unknown } | null;
  if (!run.version || body?.version !== run.version)
    return Response.json({ error: "The draft changed. Read it again before you approve.", run }, { status: 409 });
  if (rec.data.filed) return Response.json({ error: "already filed", filed: rec.data.filed }, { status: 409 });
  // A resolved case is refused here. Which response PayPal takes now is read from the dispute's fresh links when
  // filing (src/file.ts), not from the stored copy, which may be older than the last webhook.
  const pendingOperation = ["sending", "uncertain"].includes(rec.data.operation?.state);
  if (run.basis && !pendingOperation && String(rec.data.dispute?.status ?? (rec as any).status).toUpperCase() === "RESOLVED") {
    return Response.json({ error: "PayPal has already resolved this dispute" }, { status: 422 });
  }
  // One filing at a time: the claim holds the time it was taken, so a request that died mid filing frees the case
  // after FILING_HOLD_MS instead of leaving it claimed for ever.
  const now = Date.now();
  const claim = await env.DB.prepare(
    "UPDATE disputes SET data = json_set(data, '$.filing', ?2) WHERE id = ?1 AND json_extract(data, '$.run.version') = ?4 AND json_extract(data, '$.filed') IS NULL AND (json_extract(data, '$.filing') IS NULL OR json_extract(data, '$.filing') < ?3)",
  )
    .bind(id, now, now - FILING_HOLD_MS, run.version)
    .run();
  if (!claim.meta.changes) {
    const current = await s.getDispute(id);
    if (current?.data?.run?.version !== run.version)
      return Response.json(
        { error: "The draft changed. Read it again before you approve.", run: current?.data?.run },
        { status: 409 },
      );
    return Response.json({ error: "already filed" }, { status: 409 });
  }
  // Another request may have become uncertain after this request read the row but before it won the claim.
  let operation: FilingOperation | undefined = (await s.getDispute(id))?.data.operation;
  const neverSent = operation?.sent === false;
  const reconciling = operation?.sent !== false && (operation?.state === "sending" || operation?.state === "uncertain");
  if (!reconciling) {
    if (operation?.sent === false) await s.mergeData(id, { operation: null, filingConflict: null });
    operation = undefined;
  }
  let readForReconciliation = false;
  try {
    let d = await pp.getDispute(id);
    readForReconciliation = true;
    const changedFacts = (dispute: any) => {
      if (!run.basis) return ["basis"];
      const fresh = approvalBasis(dispute, run.decision.offerAmount);
      return (Object.keys(fresh) as (keyof ApprovalBasis)[]).filter((key) => fresh[key] !== run.basis![key]);
    };
    const factsConflict = async (changed: string[]) => {
      if (reconciling && operation) {
        const conflict = { changed, paypalUrl: "https://www.sandbox.paypal.com/" };
        await s.mergeData(id, { filing: null, filingConflict: conflict });
        return Response.json({
          error: "PayPal shows different facts. Check the original filing on PayPal before you continue.",
          operation, conflict,
        }, { status: 202 });
      }
      // Tracking or pack preparation may have started, but the response was never sent.
      await s.mergeData(id, { filing: null, operation: null, filingConflict: null });
      return Response.json({
        error: "PayPal shows different facts now. Analyse again before you approve.", changed,
        ...(neverSent || operation?.sent === false ? { operationCleared: true } : {}),
      }, { status: 409 });
    };
    if (!run.basis) return factsConflict(["basis"]);
    // A retry checks PayPal before tracking, pack creation, or another filing write.
    if (reconciling && operation && operationTookEffect(d, operation, operation.approved?.sentences ?? run.sentences, operation.approved ? JSON.parse(operation.approved.basisJson) : run.basis)) {
      const filed = { call: "GET /v1/customer/disputes/{id}", ok: true, detail: "PayPal confirmed the filing", at: new Date().toISOString() };
      operation = { ...operation, state: "done" };
      await s.mergeData(id, { filed, operation, filing: null, filingConflict: null });
      await syncDispute(env, id).catch(() => null);
      return Response.json({ filed, operation, status: d.status, stage: d.dispute_life_cycle_stage });
    }
    const changed = changedFacts(d);
    if (changed.length) return factsConflict(changed);
    if (reconciling && operation && responseAction(d, run.decision) !== operation.action) {
      operation = { ...operation, state: "uncertain" };
      await s.mergeData(id, { operation, filing: null });
      return filingUncertain(operation);
    }
    const action = reconciling ? operation?.action : responseAction(d, run.decision);
    if (!action) {
      const filed = await fileResponse(pp, d, run.decision, run.sentences);
      await s.mergeData(id, { filing: null });
      await s.feed({ kind: "call", title: "file refused", ref: id, detail: filed.detail });
      return Response.json({ filed, status: d.status, stage: d.dispute_life_cycle_stage }, { status: 422 });
    }
    if (action) {
      operation = {
        ...(reconciling ? operation : {}),
        action,
        sent: reconciling ? operation?.sent : false,
        approved: reconciling ? operation?.approved : { basisJson: JSON.stringify(run.basis), sentences: run.sentences },
        requestId: reconciling && operation ? operation.requestId : `dd-${crypto.randomUUID()}`,
        versionAt: run.version!, state: "sending", at: reconciling && operation ? operation.at : new Date().toISOString(),
      };
      await s.mergeData(id, { operation });
    }
    const trk = run.records.find((r) => r.kind === "tracking");
    let tracker: any;
    if (trk?.id.startsWith("ship-") && run.decision.verdict === "FIGHT") {
      // The seller's shipping record goes onto PayPal now, as part of the response.
      const ship = await env.DB.prepare("SELECT * FROM shipments WHERE custom_id = ?")
        .bind(trk.id.slice(5))
        .first<Shipment>();
      if (ship) {
        let trackerId = ship.tracker_id ?? undefined;
        if (!trackerId) {
          trackerId = (
            await pp.addTracking(ship.order_id, {
              captureId: ship.capture_id,
              trackingNumber: ship.tracking_number,
              carrier: ship.carrier,
              requestId: `dd-${id}-track`,
            })
          ).trackerId;
          await s.feed({
            kind: "call",
            title: "POST /v2/checkout/orders/{id}/track",
            ref: trackerId ?? ship.order_id,
            detail: `${ship.carrier} ${ship.tracking_number}`,
          });
          if (trackerId && ship.delivered_at) {
            await pp.setTrackerStatus(trackerId, {
              captureId: ship.capture_id,
              trackingNumber: ship.tracking_number,
              carrier: ship.carrier,
              status: "DELIVERED",
              requestId: `dd-${id}-delivered`,
            });
            await s.feed({
              kind: "call",
              title: "PUT /v1/shipping/trackers/{id}",
              ref: trackerId,
              detail: "DELIVERED",
            });
          }
          await env.DB.prepare("UPDATE shipments SET tracker_id = ? WHERE custom_id = ?")
            .bind(trackerId ?? null, ship.custom_id)
            .run();
        }
        tracker = { carrier: ship.carrier, tracking_number: ship.tracking_number };
        d = await pp.getDispute(id);
        const changed = changedFacts(d);
        if (changed.length) return factsConflict(changed);
      }
    } else if (trk) {
      tracker = await pp.getTracker(trk.id).catch(() => undefined);
    }
    let files: { name: string; type: string; data: Uint8Array }[] | undefined;
    if (run.decision.verdict === "FIGHT") {
      try {
        const data = await buildStoredPack(id, rec, run);
        files = [{ name: `${id}-evidence.pdf`, type: "application/pdf", data }];
      } catch (error) {
        await s.feed({
          kind: "agent",
          title: "evidence pack",
          ref: id,
          detail: `pack could not be built: ${String((error as Error)?.message ?? error)}`,
        });
        if (String(d.dispute_life_cycle_stage ?? "").toUpperCase() !== "INQUIRY") {
          // A filing that may already have reached PayPal stays on record as uncertain; a new one is dropped.
          await s.mergeData(id, reconciling && operation
            ? { filing: null, operation: { ...operation, state: "uncertain" } }
            : { filing: null, operation: null, filingConflict: null });
          return Response.json(
            { error: "The evidence pack could not be built. The dispute response was not filed. Try again." },
            { status: 502 },
          );
        }
      }
    }
    if (operation && !reconciling) {
      operation = { ...operation, proof: {
        note: noteFrom(run.sentences),
        ...(operation.action === "evidence" ? {
          trackingNumber: tracker?.tracking_number,
          documentNames: String(d.dispute_life_cycle_stage).toUpperCase() === "INQUIRY" ? [] : files?.map(file => file.name),
        } : {}),
      } };
      await s.mergeData(id, { operation });
    }
    let filed;
    try {
      if (operation) {
        operation = { ...operation, sent: true, at: reconciling ? operation.at : new Date().toISOString() };
        await s.mergeData(id, { operation, filingConflict: null });
      }
      filed = await fileResponse(
        pp,
        d,
        run.decision,
        run.sentences,
        tracker ? { carrier: tracker.carrier, number: tracker.tracking_number } : undefined,
        files,
        operation,
      );
    } catch (e) {
      if (operation) {
        // A refused retry does not establish the outcome of the earlier request.
        const refused = !reconciling && e instanceof PayPalError && e.status >= 400 && e.status < 500;
        operation = { ...operation, state: refused ? "refused" : "uncertain", detail: String((e as Error).message || e) };
        await s.mergeData(id, { operation, filing: null });
        if (!refused) return filingUncertain(operation);
      }
      filed = { call: "", ok: false, detail: String((e as Error).message || e) };
    }
    if (filed.ok) {
      filed = { ...filed, at: new Date().toISOString() };
      if (operation) operation = { ...operation, state: "done" };
      await s.mergeData(id, { filed, filing: null, ...(operation ? { operation } : {}) });
    } else {
      if (reconciling && operation) {
        operation = { ...operation, state: "uncertain", detail: filed.detail };
        await s.mergeData(id, { operation, filing: null });
        return filingUncertain(operation);
      }
      if (operation) operation = { ...operation, state: "refused", detail: filed.detail };
      await s.mergeData(id, { filing: null, ...(operation ? { operation } : {}) });
    }
    await s.feed({ kind: "call", title: filed.call || "file refused", ref: id, detail: filed.detail });
    let fresh;
    try {
      fresh = await syncDispute(env, id);
    } catch (error) {
      await s.feed({
        kind: "call",
        title: "refresh failed",
        ref: id,
        detail: String((error as Error)?.message ?? error),
      });
      return Response.json(
        { filed, status: d.status, stage: d.dispute_life_cycle_stage, refresh: "failed" },
        { status: filed.ok ? 200 : 422 },
      );
    }
    return Response.json(
      { filed, status: fresh?.status, stage: fresh?.dispute_life_cycle_stage },
      { status: filed.ok ? 200 : 422 },
    );
  } catch (error) {
    if (operation?.sent === false) {
      await s.mergeData(id, { filing: null, operation: null, filingConflict: null });
    } else if (operation && (operation.state === "sending" || operation.state === "uncertain")) {
      operation = { ...operation, state: "uncertain", detail: String((error as Error)?.message ?? error) };
      await s.mergeData(id, { operation, filing: null });
      if (reconciling && !readForReconciliation) return filingUncertain(operation);
    } else await s.mergeData(id, { filing: null });
    return Response.json(
      { error: `Could not file response: ${String((error as Error)?.message ?? error)}` },
      { status: 502 },
    );
  }
}

async function ask(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { q?: unknown };
  const q = typeof body.q === "string" ? body.q.slice(0, 200) : "";
  if (!q.trim()) return Response.json({ error: "ask a question" }, { status: 400 });
  const day = utcDay();
  const visitor = await visitorId(req);
  let cap = checkCaps(await readUsage(env.DB, env.LEDGER, visitor, day), NEURONS_PER_ASK_MAX);
  const reservation = cap.ok ? await reserveRun(env.DB, { day, visitor, disputeId: "ask" }) : null;
  if (cap.ok && !reservation) cap = checkCaps(await readUsage(env.DB, env.LEDGER, visitor, day), NEURONS_PER_ASK_MAX);
  const neuronReservationId = cap.ok && reservation ? await reserveNeurons(env.LEDGER, day, "ask") : null;
  const budget = neuronReservationId !== null;
  if (cap.ok && !budget) cap = checkCaps(await readUsage(env.DB, env.LEDGER, visitor, day), NEURONS_PER_ASK_MAX);
  const accounting = { uncertain: false };
  let spec;
  let by: "model" | "words" = "words";
  let neurons = 0;
  if (budget) {
    try {
      const r = await workersAi(
        env,
        accounting,
      )([
        { role: "system", content: ASK_SYSTEM },
        { role: "user", content: q },
      ], "ask");
      neurons = r.usage ? neuronsFor(r.usage) : NEURONS_PER_ASK_MAX;
      spec = parseSpec(r.text);
      if (spec) by = "model";
    } catch {
      // the words path below answers
    }
  }
  if (accounting.uncertain) neurons = Math.max(NEURONS_PER_ASK_MAX, neurons);
  spec ??= keywordSpec(q);
  if (reservation)
    await finishRun(env.DB, env.LEDGER, reservation, neuronReservationId, { day, writer: `ask-${by}`, neurons, uncertain: accounting.uncertain });
  else await recordRun(env.DB, env.LEDGER, { day, visitor, disputeId: "ask", writer: `ask-${by}`, neurons });
  const rows = (
    await env.DB.prepare(
      "SELECT reason, status, stage, amount, currency, json_extract(data, '$.dispute.create_time') AS created FROM disputes",
    ).all<ChartRow>()
  ).results;
  const result = chartData(rows, spec);
  return Response.json({ spec, title: chartTitle(spec, result.leftOut), rows: result.rows, by, neurons });
}

// Reads again the disputes PayPal lists that the desk does not hold, or holds with an older status.
export async function syncAll(env: Env) {
  const pp = paypal(env);
  const items = await pp.listDisputes({ pageSize: 50 });
  const stored = new Map(
    (
      await env.DB.prepare("SELECT id, status, updated_at FROM disputes").all<{
        id: string;
        status: string;
        updated_at: string;
      }>()
    ).results.map((r) => [r.id, { status: r.status, updated: r.updated_at }]),
  );
  let read = 0;
  for (const item of items) {
    if (!needsSync(item, stored.get(item.dispute_id))) continue;
    await syncDispute(env, item.dispute_id).catch((e) => console.log("sync failed", item.dispute_id, String(e)));
    read += 1;
  }
  return { listed: items.length, read };
}

// At most once every 15 minutes, a page load of the disputes list starts the sync in the background. No cron trigger:
// the Free plan allows 5 per account, and five hackathon apps share this account.
export const SYNC_EVERY_MS = 15 * 60_000;

export async function drainPendingEvents(env: Env) {
  const s = store(env.DB);
  for (const event of await s.pendingEvents()) {
    if (!(await s.claimEvent(event.id))) continue;
    try {
      await processEvent(env, JSON.parse(event.raw));
      await s.markEventProcessed(event.id);
    } catch (error) {
      await s.releaseEvent(event.id);
      console.log("webhook processing failed", event.id, String(error));
    }
  }
}

async function maybeSync(env: Env, ctx: ExecutionContext) {
  const claim = await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES ('last_sync', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE meta.value < ?`,
  )
    .bind(new Date().toISOString(), new Date(Date.now() - SYNC_EVERY_MS).toISOString())
    .run();
  if (!claim.meta.changes) return;
  ctx.waitUntil(
    drainPendingEvents(env).then(() => syncAll(env))
      .then((r) => console.log("timed sync", JSON.stringify(r)))
      .catch((e) => console.log("sync failed", String(e))),
  );
}

async function route(req: Request, env: Env, ctx: ExecutionContext, sessionId: string): Promise<Response> {
  const url = new URL(req.url);
  const s = store(env.DB);
  const path = url.pathname;

  if (path === "/health") return Response.json({ ok: true, app: "dispute-desk" });

  if (path === "/api/proof" && req.method === "GET") return Response.json(runProof());
  if (path === "/api/proof/check" && req.method === "POST") {
    const parsed = await req.json().catch(() => ({}));
    const body = (parsed && typeof parsed === "object" ? parsed : {}) as { text?: unknown; record_id?: unknown };
    if (typeof body.text !== "string" || typeof body.record_id !== "string")
      return Response.json({ error: "Add a sentence and record id." }, { status: 400 });
    return Response.json(checkSentence(body.text, body.record_id));
  }
  if (path === "/api/proof/scenario" && req.method === "GET") return Response.json(scenarioOptions());
  if (path === "/api/proof/scenario" && req.method === "POST") {
    const parsed = await req.json().catch(() => ({}));
    const body = (parsed && typeof parsed === "object" ? parsed : {}) as {
      fixture?: unknown;
      change?: { field?: unknown; value?: unknown };
    };
    if (typeof body.fixture !== "string" || !body.change || typeof body.change.field !== "string")
      return Response.json({ error: "Add a fixture and change." }, { status: 400 });
    try {
      return Response.json(compareScenario(body.fixture, { field: body.change.field, value: body.change.value }));
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    }
  }

  if (path === "/webhooks/paypal" && req.method === "POST") {
    const pp = paypal(env);
    return handleWebhook(req, {
      verify: (h, raw) => pp.verifyWebhookSignature(h, env.PAYPAL_WEBHOOK_ID, raw),
      storeIfNew: (ev, raw) => s.storeEventIfNew(ev, raw),
      process: (ev) => processEvent(env, ev),
      markProcessed: (id) => s.markEventProcessed(id),
      waitUntil: (p) => ctx.waitUntil(p),
    });
  }

  if (path === "/api/feed") return Response.json(await s.recentFeed());
  if (path === "/api/usage" && req.method === "GET") {
    const day = utcDay();
    const [runs, app, account] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS n FROM runs WHERE day = ?").bind(day).first<{ n: number }>(),
      env.LEDGER.prepare("SELECT COALESCE(SUM(neurons), 0) AS n FROM ai_calls WHERE day = ? AND app = ?")
        .bind(day, "dispute-desk")
        .first<{ n: number }>(),
      env.LEDGER.prepare("SELECT COALESCE(SUM(neurons), 0) AS n FROM ai_calls WHERE day = ?")
        .bind(day)
        .first<{ n: number }>(),
    ]);
    return Response.json({
      day,
      runs: runs?.n ?? 0,
      appNeurons: app?.n ?? 0,
      appCap: APP_NEURONS_PER_DAY,
      accountNeurons: account?.n ?? 0,
      accountCap: ACCOUNT_NEURONS_PER_DAY,
      freeDay: 10000,
      perRun: NEURONS_PER_RUN_ESTIMATE,
    });
  }
  if (path === "/api/ask" && req.method === "POST") return ask(req, env);

  if (path === "/api/judge/next") {
    const requested = url.searchParams.get("kind");
    const kind: CaseKind = requested === "ship" ? "ship" : requested === "accept" ? "accept" : "fight";
    const a = await nextForJudge(env.DB, sessionId, kind, judgeCheck(env, kind));
    if (a.replay && kind !== "ship") {
      return Response.json({ ...a, replay: replayDraft(kind) });
    }
    return Response.json(a);
  }
  if (path === "/api/judge/pool") {
    if (req.method === "GET" && url.searchParams.get("verify") === "1") {
      const now = Date.now();
      const claim = await env.DB.prepare(`INSERT INTO meta (key, value) VALUES ('pool_verify_at', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(meta.value AS INTEGER) <= ?`)
        .bind(String(now), now - 10 * 60 * 1000).run();
      if ((claim.meta.changes ?? 0) > 0) {
        for (const kind of ["fight", "accept"] as const) {
          await verifyFree(env.DB, kind, judgeCheck(env, kind), 5);
        }
      }
    }
    return Response.json(await poolCounts(env.DB));
  }
  if (path === "/api/me") {
    const v = sessionId;
    const mine = await env.DB.prepare("SELECT dispute_id, kind FROM pool WHERE handed_to = ?").bind(v).all();
    return Response.json({ cases: mine.results });
  }
  if (path === "/api/sales" && req.method === "GET") {
    const rows = await s.listSales();
    const mine = await env.DB.prepare("SELECT dispute_id FROM pool WHERE kind = 'ship' AND handed_to = ?")
      .bind(sessionId)
      .all<{ dispute_id: string }>();
    const ids = new Set(mine.results.map((row) => row.dispute_id));
    const now = Date.now();
    return Response.json(rows.map((row) => ({ ...row, ...shipState(row, now), yours: ids.has(row.capture_id) })));
  }
  const saleMatch = path.match(/^\/api\/sales\/([^/]*)\/track$/);
  if (saleMatch && req.method === "POST") {
    const id = saleMatch[1];
    if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) return Response.json({ error: "Invalid capture id." }, { status: 400 });
    const row = (await s.listSales()).find((sale) => sale.capture_id === id);
    if (!row) return Response.json({ error: "not found" }, { status: 404 });
    if (!(await mayFile(req, env, id, sessionId)))
      return Response.json({ error: "This sale belongs to another visitor." }, { status: 403 });
    if (row.tracker_id) return Response.json({ already: true });
    // No model call and no cap change: a PayPal sandbox call costs nothing.
    let trackerId: string;
    try {
      const result = await paypal(env).addTracking(row.order_id, {
        captureId: id,
        trackingNumber: row.tracking_number,
        carrier: row.carrier,
        notifyPayer: false,
      });
      if (!result.trackerId) throw new Error("No tracker id returned");
      trackerId = result.trackerId;
    } catch {
      return Response.json({ error: "Could not add tracking on PayPal." }, { status: 502 });
    }
    await env.DB.prepare("UPDATE shipments SET tracker_id = ? WHERE custom_id = ?")
      .bind(trackerId, row.custom_id)
      .run();
    await s.feed({
      kind: "call",
      title: "POST /v2/checkout/orders/{id}/track",
      ref: id,
      detail: "tracking on PayPal before any dispute",
    });
    const updated = { ...row, tracker_id: trackerId };
    return Response.json({ ...updated, ...shipState(updated, Date.now()), yours: true });
  }
  if (path === "/api/disputes") {
    await maybeSync(env, ctx);
    return Response.json(await s.listDisputes());
  }

  const m = path.match(/^\/api\/disputes\/([^/]*)(?:\/(analyse|approve|pack\.pdf))?$/);
  if (m) {
    const [, id, action] = m;
    if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) return Response.json({ error: "Invalid dispute id." }, { status: 400 });
    if (!action && req.method === "GET") {
      const rec = await s.getDispute(id);
      return rec ? Response.json(rec) : Response.json({ error: "not found" }, { status: 404 });
    }
    if (action === "analyse" && req.method === "POST") {
      if (!(await mayFile(req, env, id, sessionId)))
        return Response.json({ error: "This case belongs to another visitor." }, { status: 403 });
      return analyse(req, env, id);
    }
    if (action === "approve" && req.method === "POST") {
      if (!(await mayFile(req, env, id, sessionId)))
        return Response.json({ error: "This case belongs to another visitor." }, { status: 403 });
      return approve(req, env, id);
    }
    if (action === "pack.pdf" && req.method === "GET") {
      const savedReplay = replayById(id);
      const rec = (await s.getDispute(id)) as StoredDispute | null ?? (savedReplay
        ? { ...savedReplay.dispute, data: { run: savedReplay.run, reconstructionLabel: savedReplay.label } }
        : null);
      if (!rec) return Response.json({ error: "not found" }, { status: 404 });
      const run: AgentRun | undefined = rec.data?.run;
      if (!run) return Response.json({ error: "analyse this dispute first" }, { status: 409 });
      const bytes = await buildStoredPack(id, rec, run);
      const body = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(body).set(bytes);
      return new Response(body, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${id}-evidence.pdf"`,
        },
      });
    }
  }

  return env.ASSETS.fetch(req);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const visitor = await session(req, env);
    const response = secure(await route(req, env, ctx, visitor.id));
    if (visitor.fresh) response.headers.append("Set-Cookie", await sessionCookie(visitor.id, env));
    return response;
  },
} satisfies ExportedHandler<Env>;
