import { describe, expect, it } from "vitest";
declare const require: (id: string) => any;
const { readFileSync } = require("fs") as { readFileSync: (path: string, encoding: string) => string };
const { homedir } = require("os") as { homedir: () => string };
const { join } = require("path") as { join: (...parts: string[]) => string };

const enabled = process.env.E2E === "1" && Boolean(process.env.E2E_DISPUTE_ID);
const desk = (process.env.DESK_URL || readFileSync(join(process.cwd(), "tools", "desk-url.txt"), "utf8")).trim();

function ownerKey(): string {
  const secrets = process.env.MIDKNIGHT_SECRETS || join(homedir(), ".cloudflare");
  const text = readFileSync(join(secrets, "dispute-desk-owner.local.txt"), "utf8");
  const line = text.split(/\r?\n/).find((entry: string) => entry.startsWith("DESK_OWNER_KEY="));
  if (!line) throw new Error("Owner key is missing");
  return line.slice("DESK_OWNER_KEY=".length);
}

describe.skipIf(!enabled)("hosted sandbox loop", () => {
  it(
    "analyses, files, and reaches a final PayPal status",
    async () => {
      const id = process.env.E2E_DISPUTE_ID!;
      const key = ownerKey();
      const headers: Record<string, string> = { "content-type": "application/json", "x-desk-key": key };
      const deskFetch = async (url: string, init: RequestInit = {}) => {
        const response = await fetch(url, { ...init, headers: { ...headers, ...init.headers } });
        const cookie = response.headers.get("set-cookie");
        if (cookie) headers.cookie = cookie.split(";")[0];
        return response;
      };
      // A new dispute sits in UNDER_REVIEW for about half a minute before it waits for the seller: file only then.
      for (let i = 0; i < 18; i++) {
        const state = (await (await deskFetch(`${desk}/api/disputes/${id}`)).json()) as { status?: string };
        if (state.status === "WAITING_FOR_SELLER_RESPONSE") break;
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      }
      const analyseResponse = await deskFetch(`${desk}/api/disputes/${id}/analyse`, {
        method: "POST",
        headers,
        body: "{}",
      });
      expect(analyseResponse.status).toBe(200);
      const analysis: any = await analyseResponse.json();
      expect(analysis.run?.decision?.verdict).toMatch(/^(FIGHT|ACCEPT|OFFER)$/);

      const approveResponse = await deskFetch(`${desk}/api/disputes/${id}/approve`, {
        method: "POST",
        headers,
        body: JSON.stringify({ version: analysis.run.version }),
      });
      expect(approveResponse.status).toBe(200);
      const approval: any = await approveResponse.json();
      expect(approval.filed?.ok).toBe(true);

      const deadline = Date.now() + 6 * 60_000;
      let status = "";
      while (Date.now() < deadline) {
        const response = await deskFetch(`${desk}/api/disputes/${id}`);
        expect(response.status).toBe(200);
        const data: any = await response.json();
        status = data.status;
        if (status === "RESOLVED" || status === "WAITING_FOR_BUYER_RESPONSE") return;
        await new Promise((resolve) => setTimeout(resolve, 15_000));
      }
      throw new Error(`Timed out waiting for final dispute status, last status ${status}`);
    },
    6 * 60_000 + 15_000,
  );
});
