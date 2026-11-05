import { describe, it, expect } from "vitest";
import { needsSync } from "../src/sync";

describe("timed sync after a lost webhook", () => {
  const item = { dispute_id: "D1", status: "WAITING_FOR_SELLER_RESPONSE", update_time: "2026-10-23T05:00:00Z" };

  it("reads a dispute the desk has never stored", () => {
    expect(needsSync(item, undefined)).toBe(true);
  });

  it("reads a dispute whose status changed", () => {
    expect(needsSync(item, { status: "UNDER_REVIEW", updated: "2026-10-23T05:10:00Z" })).toBe(true);
  });

  it("reads a dispute PayPal changed after the desk last stored it", () => {
    expect(
      needsSync(
        { ...item, update_time: "2026-10-23T06:00:00Z" },
        { status: item.status, updated: "2026-10-23T05:30:00Z" },
      ),
    ).toBe(true);
  });

  it("skips a dispute that is unchanged since it was stored", () => {
    expect(needsSync(item, { status: item.status, updated: "2026-10-23T05:30:00Z" })).toBe(false);
  });
});
