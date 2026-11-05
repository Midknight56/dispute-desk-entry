// Filing the seller's approved response. Which PayPal call files it depends on the verdict and on the actions the
// dispute offers right now (its links): PayPal changes them by stage, so the links decide, never a guess.
import type { Decision, Sentence } from "./rules";

export interface FileDeps {
  provideEvidence(
    id: string,
    a: { evidences: any[]; files?: { name: string; type: string; data: Uint8Array | string }[]; requestId: string },
  ): Promise<any>;
  provideSupportingInfo(id: string, notes: string, options: { requestId: string }): Promise<any>;
  acceptClaim(
    id: string,
    a: { note: string; acceptClaimReason?: string; acceptClaimType?: "REFUND" | "PARTIAL_REFUND"; requestId: string },
  ): Promise<any>;
  makeOffer(
    id: string,
    a: { note: string; amount: { currency_code: string; value: string }; offerType?: string; requestId: string },
  ): Promise<any>;
}

export interface Filed {
  call: string;
  ok: boolean;
  detail: string;
}

export type FilingAction = "evidence" | "supporting" | "accept" | "offer";
export interface FilingOperation {
  action: FilingAction;
  requestId: string;
  versionAt: string;
  state: "sending" | "uncertain" | "done" | "refused";
  at: string;
  detail?: string;
  sent?: boolean;
  approved?: { basisJson: string; sentences: Sentence[] };
  proof?: { note: string; trackingNumber?: string; documentNames?: string[] };
}

export function responseAction(dispute: any, decision: Decision): FilingAction | undefined {
  const links = new Set((dispute.links ?? []).map((l: any) => l.rel));
  if (String(dispute.status ?? "").toUpperCase() === "RESOLVED") return;
  if (decision.verdict === "FIGHT") {
    if (links.has("provide_evidence")) return "evidence";
    if (links.has("provide_supporting_info")) return "supporting";
  }
  if (decision.verdict === "ACCEPT" && links.has("accept_claim")) return "accept";
  if (decision.verdict === "OFFER" && decision.offerAmount && links.has("make_offer")) return "offer";
}

export interface ApprovalBasis {
  amount: string | null;
  currency: string | null;
  status: string | null;
  stage: string | null;
  reason: string | null;
  captureId: string | null;
  offerAmount: string | null;
}

export function approvalBasis(dispute: any, offerAmount?: string): ApprovalBasis {
  return {
    amount: dispute.dispute_amount?.value ?? null,
    currency: dispute.dispute_amount?.currency_code ?? null,
    status: dispute.status ?? null,
    stage: dispute.dispute_life_cycle_stage ?? null,
    reason: dispute.reason ?? null,
    captureId: dispute.disputed_transactions?.[0]?.seller_transaction_id ?? null,
    offerAmount: offerAmount ?? null,
  };
}

export function operationTookEffect(
  dispute: any,
  operation: FilingOperation,
  sentences: Sentence[],
  basis?: ApprovalBasis,
): boolean {
  const after = (date: unknown) => typeof date === "string" && Date.parse(date) > Date.parse(operation.at);
  const sameMoney = (actual: any, value: unknown, currency: unknown) =>
    typeof actual?.value === "string" &&
    typeof value === "string" &&
    actual.value.trim() !== "" &&
    value.trim() !== "" &&
    Number.isFinite(Number(value)) &&
    Number(actual.value) === Number(value) &&
    actual.currency_code === currency;
  // A buyer outcome does not identify who accepted or which request caused the refund.
  // Without an operation receipt this action stays uncertain.
  if (operation.action === "accept") return false;
  const note = operation.proof?.note ?? noteFrom(sentences);
  if (!note.trim()) return false;
  if (operation.action === "evidence") {
    return (dispute.evidences ?? []).some((e: any) =>
      e.source === "SUBMITTED_BY_SELLER" && e.evidence_type === "PROOF_OF_FULFILLMENT" &&
      e.notes === note && after(e.date) &&
      (!operation.proof?.trackingNumber || (e.evidence_info?.tracking_info ?? []).some(
        (tracking: any) => tracking.tracking_number === operation.proof!.trackingNumber)) &&
      // Uploaded document names alone do not prove document identity. Await a direct receipt.
      !operation.proof?.documentNames?.length,
    );
  }
  if (operation.action === "supporting") {
    return (dispute.supporting_info ?? []).some((info: any) =>
      info.source === "SUBMITTED_BY_SELLER" && info.notes === note && after(info.provided_time));
  }
  return (
    operation.action === "offer" &&
    (dispute.offer?.history ?? []).some(
      (o: any) =>
        o.actor === "SELLER" &&
        o.event_type === "PROPOSED" &&
        o.offer_type === "REFUND" &&
        !!note && o.notes === note &&
        after(o.offer_time) &&
        sameMoney(o.offer_amount, basis?.offerAmount, basis?.currency),
    )
  );
}

export function noteFrom(sentences: Sentence[]) {
  // PayPal's notes field takes up to 2,000 characters.
  return sentences
    .map((s) => s.text)
    .join(" ")
    .slice(0, 2000);
}

export async function fileResponse(
  deps: FileDeps,
  dispute: any,
  decision: Decision,
  sentences: Sentence[],
  tracking?: { carrier?: string; number?: string },
  files?: { name: string; type: string; data: Uint8Array | string }[],
  operation?: Pick<FilingOperation, "action" | "requestId">,
): Promise<Filed> {
  if (decision.verdict === "REVIEW") {
    return { call: "", ok: false, detail: `needs review: ${decision.why}` };
  }
  const id = dispute.dispute_id;
  const note = noteFrom(sentences);
  if (!note.trim()) return { call: "", ok: false, detail: "The draft is empty. Analyse again before you approve." };
  const currency = dispute.dispute_amount?.currency_code ?? "USD";
  // Reuse the key for a retry of this draft, and make a changed draft a new PayPal request.
  const requestId = async (action: string) => {
    if (operation) return operation.requestId;
    const offerAmount = action === "offer" ? (decision.offerAmount ?? "") : "";
    const material = [action, note, offerAmount];
    const ordinary = `dd-${id}-${action}-${"0".repeat(12)}`;
    if (ordinary.length > 100) material.push(String(id));
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(material)));
    const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    const disputeKey =
      ordinary.length > 100
        ? Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(id)))))
            .slice(0, 6)
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("")
        : String(id);
    return `dd-${disputeKey}-${action}-${hash.slice(0, 12)}`;
  };
  const links = new Set<string>((dispute.links ?? []).map((l: any) => l.rel));

  if (String(dispute.status ?? "").toUpperCase() === "RESOLVED") {
    return { call: "", ok: false, detail: "PayPal has already resolved this dispute" };
  }

  if (decision.verdict === "FIGHT") {
    if (links.has("provide_evidence") && (!operation || operation.action === "evidence")) {
      const evidence: any = { evidence_type: "PROOF_OF_FULFILLMENT", notes: note };
      if (tracking?.number) {
        evidence.evidence_info = {
          tracking_info: [{ carrier_name: tracking.carrier ?? "OTHER", tracking_number: tracking.number }],
        };
      }
      const inquiry = String(dispute.dispute_life_cycle_stage ?? "").toUpperCase() === "INQUIRY";
      // Sandbox check (3 Nov 2026): files returned 500 at INQUIRY (no files 200), and 200 at CHARGEBACK.
      const attachFiles = !inquiry && files?.length;
      await deps.provideEvidence(id, {
        evidences: [evidence],
        ...(attachFiles ? { files } : {}),
        requestId: await requestId("evidence"),
      });
      return {
        call: "POST /v1/customer/disputes/{id}/provide-evidence",
        ok: true,
        detail:
          inquiry && files?.length
            ? "evidence filed; the evidence pack goes with a claim, not an inquiry"
            : attachFiles
              ? "evidence filed with the evidence pack"
              : "evidence filed",
      };
    }
    if (links.has("provide_supporting_info") && (!operation || operation.action === "supporting")) {
      await deps.provideSupportingInfo(id, note, { requestId: await requestId("supporting") });
      return {
        call: "POST /v1/customer/disputes/{id}/provide-supporting-info",
        ok: true,
        detail: "supporting info filed",
      };
    }
  }
  if (decision.verdict === "ACCEPT" && links.has("accept_claim")) {
    // Published Disputes schema.json receipt, 5 Nov 2026: no accept_claim_reason or DID_NOT_SHIP_ITEM.
    // https://developer.paypal.com/api/customer-disputes/v1/schema.json
    await deps.acceptClaim(id, { note, acceptClaimType: "REFUND", requestId: await requestId("accept") });
    return { call: "POST /v1/customer/disputes/{id}/accept-claim", ok: true, detail: "claim accepted, full refund" };
  }
  if (decision.verdict === "OFFER" && decision.offerAmount && links.has("make_offer")) {
    await deps.makeOffer(id, {
      note,
      amount: { currency_code: currency, value: decision.offerAmount },
      offerType: "REFUND",
      requestId: await requestId("offer"),
    });
    return { call: "POST /v1/customer/disputes/{id}/make-offer", ok: true, detail: `offered ${decision.offerAmount}` };
  }
  return {
    call: "",
    ok: false,
    detail: `PayPal does not take this response at this stage (${dispute.status}, ${dispute.dispute_life_cycle_stage})`,
  };
}
