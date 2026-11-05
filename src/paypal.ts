import { getAccessToken, paypalFetch, refreshAccessToken, type TokenEnv } from "./token";

export interface PayPalEnv extends TokenEnv {}

export class PayPalError extends Error {
  status: number;
  name: string;
  debugId?: string;
  issues: string[];

  constructor(method: string, path: string, status: number, body: any) {
    const name = body?.name || body?.error || `HTTP_${status}`;
    const issues = Array.isArray(body?.details)
      ? body.details.map((d: any) => d?.issue).filter((x: unknown): x is string => typeof x === "string")
      : [];
    super(`PayPal ${method} ${path} ${status} ${name} ${issues.join(",")}`.trim());
    this.status = status;
    this.name = name;
    this.debugId = body?.debug_id;
    this.issues = issues;
  }
}

type WriteOptions = { requestId?: string };

export function paypal(env: PayPalEnv, fetchFn: typeof fetch = fetch) {
  async function request(
    path: string,
    method: string,
    body?: BodyInit | null,
    options: WriteOptions = {},
    json = true,
  ): Promise<any> {
    let token = await getAccessToken(env, fetchFn);
    const headers = new Headers();
    if (["POST", "PUT", "PATCH"].includes(method))
      headers.set("PayPal-Request-Id", options.requestId ?? crypto.randomUUID());
    if (json && body !== undefined) headers.set("Content-Type", "application/json");
    let res: Response;
    for (let attempt = 0; ; attempt++) {
      headers.set("Authorization", `Bearer ${token}`);
      res = await paypalFetch(fetchFn, `${env.PAYPAL_BASE}${path}`, { method, headers, body });
      if (res.status !== 401 || attempt > 0) break;
      token = await refreshAccessToken(env, fetchFn);
    }
    if (res.status === 204) return {};
    const text = await res.text();
    if (!text) {
      if (!res.ok) throw new PayPalError(method, path, res.status, {});
      return {};
    }
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = {};
    }
    if (!res.ok) throw new PayPalError(method, path, res.status, data);
    return data;
  }

  return {
    async createOrder({
      value,
      customId,
      description,
      currency = "USD",
      returnUrl,
      cancelUrl,
      requestId,
    }: {
      value: string;
      customId: string;
      description: string;
      currency?: string;
      returnUrl: string;
      cancelUrl: string;
      requestId?: string;
    }) {
      if (!customId.startsWith("dd-")) throw new Error("customId must start with dd-");
      const path = "/v2/checkout/orders";
      const d = await request(
        path,
        "POST",
        JSON.stringify({
          intent: "CAPTURE",
          purchase_units: [
            { reference_id: customId, custom_id: customId, description, amount: { currency_code: currency, value } },
          ],
          payment_source: {
            paypal: {
              experience_context: {
                shipping_preference: "GET_FROM_FILE",
                user_action: "PAY_NOW",
                return_url: returnUrl,
                cancel_url: cancelUrl,
              },
            },
          },
        }),
        { requestId },
      );
      return {
        id: d.id,
        status: d.status,
        approveUrl: d.links?.find((l: any) => l.rel === "payer-action" || l.rel === "approve")?.href,
      };
    },
    async getOrder(id: string) {
      return request(`/v2/checkout/orders/${id}`, "GET");
    },
    async getCapture(id: string) {
      return request(`/v2/payments/captures/${id}`, "GET");
    },
    async captureOrder(id: string, opts: WriteOptions = {}) {
      const d = await request(`/v2/checkout/orders/${id}/capture`, "POST", JSON.stringify({}), opts);
      const c = d.purchase_units?.[0]?.payments?.captures?.[0];
      return { orderId: d.id, status: d.status, captureId: c?.id, captureStatus: c?.status };
    },
    async addTracking(
      orderId: string,
      {
        captureId,
        trackingNumber,
        carrier,
        notifyPayer = false,
        requestId,
      }: { captureId: string; trackingNumber: string; carrier: string; notifyPayer?: boolean } & WriteOptions,
    ) {
      const d = await request(
        `/v2/checkout/orders/${orderId}/track`,
        "POST",
        JSON.stringify({ capture_id: captureId, tracking_number: trackingNumber, carrier, notify_payer: notifyPayer }),
        { requestId },
      );
      return { trackerId: d.purchase_units?.[0]?.shipping?.trackers?.at(-1)?.id };
    },
    async setTrackerStatus(
      trackerId: string,
      {
        captureId,
        trackingNumber,
        carrier,
        status,
        requestId,
      }: { captureId: string; trackingNumber: string; carrier: string; status: "SHIPPED" | "DELIVERED" } & WriteOptions,
    ) {
      return request(
        `/v1/shipping/trackers/${trackerId}`,
        "PUT",
        JSON.stringify({ transaction_id: captureId, tracking_number: trackingNumber, status, carrier }),
        { requestId },
      );
    },
    async getTracker(trackerId: string) {
      return request(`/v1/shipping/trackers/${trackerId}`, "GET");
    },
    async listDisputes({ pageSize = 50 }: { pageSize?: number } = {}) {
      const items: any[] = [];
      let path = `/v1/customer/disputes?page_size=${pageSize}`;
      const base = new URL(env.PAYPAL_BASE);
      for (let page = 0; page < 20; page++) {
        const d = await request(path, "GET");
        items.push(...(d.items ?? []));
        const href = d.links?.find((link: any) => link.rel === "next")?.href;
        if (typeof href !== "string") break;
        let next: URL;
        try {
          next = new URL(href, base);
        } catch {
          break;
        }
        if (next.origin !== base.origin || !next.pathname.startsWith("/v1/customer/disputes")) break;
        path = next.pathname + next.search;
      }
      return items;
    },
    async getDispute(id: string) {
      return request(`/v1/customer/disputes/${id}`, "GET");
    },
    async provideEvidence(
      id: string,
      {
        evidences,
        files = [],
        requestId,
      }: {
        evidences: {
          evidence_type: string;
          evidence_info?: {
            tracking_info?: { carrier_name: string; tracking_number: string }[];
            refund_ids?: { refund_id: string }[];
          };
          notes?: string;
        }[];
        files?: { name: string; type: string; data: Uint8Array | string }[];
      } & WriteOptions,
    ) {
      const form = new FormData();
      form.append("input", new Blob([JSON.stringify({ evidences })], { type: "application/json" }));
      files.forEach((file, i) =>
        form.append(`file${i + 1}`, new Blob([file.data as any], { type: file.type }), file.name),
      );
      return request(`/v1/customer/disputes/${id}/provide-evidence`, "POST", form, { requestId }, false);
    },
    async provideSupportingInfo(id: string, notes: string, opts: WriteOptions = {}) {
      const form = new FormData();
      form.append("input", new Blob([JSON.stringify({ notes })], { type: "application/json" }));
      return request(`/v1/customer/disputes/${id}/provide-supporting-info`, "POST", form, opts, false);
    },
    async acceptClaim(
      id: string,
      {
        note,
        acceptClaimReason,
        acceptClaimType = "REFUND",
        refundAmount,
        requestId,
      }: {
        note: string;
        acceptClaimReason?: string;
        acceptClaimType?: "REFUND" | "PARTIAL_REFUND";
        refundAmount?: { currency_code: string; value: string };
      } & WriteOptions,
    ) {
      return request(
        `/v1/customer/disputes/${id}/accept-claim`,
        "POST",
        JSON.stringify({
          note,
          ...(acceptClaimReason !== undefined ? { accept_claim_reason: acceptClaimReason } : {}),
          accept_claim_type: acceptClaimType,
          ...(refundAmount ? { refund_amount: refundAmount } : {}),
        }),
        { requestId },
      );
    },
    async makeOffer(
      id: string,
      {
        note,
        amount,
        offerType = "REFUND",
        requestId,
      }: { note: string; amount: { currency_code: string; value: string }; offerType?: string } & WriteOptions,
    ) {
      return request(
        `/v1/customer/disputes/${id}/make-offer`,
        "POST",
        JSON.stringify({ note, offer_amount: amount, offer_type: offerType }),
        { requestId },
      );
    },
    async sendMessage(id: string, message: string, opts: WriteOptions = {}) {
      return request(`/v1/customer/disputes/${id}/send-message`, "POST", JSON.stringify({ message }), opts);
    },
    async adjudicate(id: string, outcome: "BUYER_FAVOR" | "SELLER_FAVOR", opts: WriteOptions = {}) {
      return request(
        `/v1/customer/disputes/${id}/adjudicate`,
        "POST",
        JSON.stringify({ adjudication_outcome: outcome }),
        opts,
      );
    },
    async requireEvidence(id: string, action: "BUYER_EVIDENCE" | "SELLER_EVIDENCE", opts: WriteOptions = {}) {
      return request(`/v1/customer/disputes/${id}/require-evidence`, "POST", JSON.stringify({ action }), opts);
    },
    async refundCapture(captureId: string, amount?: { currency_code: string; value: string }, opts: WriteOptions = {}) {
      return request(
        `/v2/payments/captures/${captureId}/refund`,
        "POST",
        JSON.stringify(amount ? { amount } : {}),
        opts,
      );
    },
    async verifyWebhookSignature(h: Headers, webhookId: string, rawBody: string) {
      const keys = [
        "paypal-auth-algo",
        "paypal-cert-url",
        "paypal-transmission-id",
        "paypal-transmission-sig",
        "paypal-transmission-time",
      ];
      const values = keys.map((k) => h.get(k));
      if (values.some((v) => !v)) return false;
      const [algo, cert, id, sig, time] = values;
      const body =
        '{"auth_algo":' +
        JSON.stringify(algo) +
        ',"cert_url":' +
        JSON.stringify(cert) +
        ',"transmission_id":' +
        JSON.stringify(id) +
        ',"transmission_sig":' +
        JSON.stringify(sig) +
        ',"transmission_time":' +
        JSON.stringify(time) +
        ',"webhook_id":' +
        JSON.stringify(webhookId) +
        ',"webhook_event":' +
        rawBody +
        "}";
      const d = await request("/v1/notifications/verify-webhook-signature", "POST", body, {}, true);
      return d.verification_status === "SUCCESS";
    },
    async createWebhook(url: string, eventTypes: string[], opts: WriteOptions = {}) {
      const d = await request(
        "/v1/notifications/webhooks",
        "POST",
        JSON.stringify({ url, event_types: eventTypes.map((name) => ({ name })) }),
        opts,
      );
      return { id: d.id };
    },
    async listWebhooks() {
      const d = await request("/v1/notifications/webhooks", "GET");
      return d.webhooks ?? [];
    },
    async deleteWebhook(id: string, opts: WriteOptions = {}) {
      return request(`/v1/notifications/webhooks/${id}`, "DELETE", undefined, opts);
    },
  };
}
