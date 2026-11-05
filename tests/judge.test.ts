import { describe, it, expect, vi } from "vitest";
import { assign, lowKinds, nextForJudge, type PoolRow } from "../src/judge";
import { createD1 } from "./helpers/d1";

const row = (id: string, over: Partial<PoolRow> = {}): PoolRow => ({
  dispute_id: id,
  kind: "fight",
  position: Number(id.replace(/\D/g, "")),
  handed_to: null,
  handed_at: null,
  ...over,
});

describe("judge pool", () => {
  it("hands the first free dispute in order and advances the cursor", () => {
    const pool = [row("D2"), row("D1"), row("D3")];
    const a = assign(pool, "judge-a", "fight");
    expect(a).toEqual({ disputeId: "D1", replay: false, fresh: true });
    pool.find((r) => r.dispute_id === "D1")!.handed_to = "judge-a";
    const b = assign(pool, "judge-b", "fight");
    expect(b).toEqual({ disputeId: "D2", replay: false, fresh: true });
  });

  it("gives a returning judge the same dispute again", () => {
    const pool = [row("D1", { handed_to: "judge-a" }), row("D2")];
    expect(assign(pool, "judge-a", "fight")).toEqual({ disputeId: "D1", replay: false, fresh: false });
  });

  it("keeps the fight and accept cases apart", () => {
    const pool = [row("D1"), row("D2", { kind: "accept" })];
    expect(assign(pool, "judge-a", "accept").disputeId).toBe("D2");
  });

  it("falls back to the replay after the last free dispute", () => {
    const pool = [row("D1", { handed_to: "x" }), row("D2", { handed_to: "y" })];
    expect(assign(pool, "judge-c", "fight")).toEqual({ disputeId: null, replay: true, fresh: false });
  });

  it("falls back to the replay when the pool is empty", () => {
    expect(assign([], "judge-a", "accept")).toEqual({ disputeId: null, replay: true, fresh: false });
  });
});

describe("low pool alarm", () => {
  it("identifies fight and accept at two free, including missing rows", () => {
    expect(lowKinds([{ kind: "fight", total: 8, free: 8 }, { kind: "accept", total: 8, free: 8 }])).toEqual([]);
    expect(lowKinds([{ kind: "fight", total: 3, free: 2 }, { kind: "accept", total: 3, free: 3 }])).toEqual(["fight"]);
    expect(lowKinds([{ kind: "fight", total: 3, free: 3 }, { kind: "accept", total: 3, free: 3 }])).toEqual([]);
    expect(lowKinds([{ kind: "accept", total: 3, free: 0 }, { kind: "fight", total: 3, free: 1 }])).toEqual(["fight", "accept"]);
    expect(lowKinds([{ kind: "fight", total: 3, free: 3 }])).toEqual(["accept"]);
    expect(lowKinds([{ kind: "fight", total: 3, free: 3 }, { kind: "accept", total: 3, free: 3 }, { kind: "ship", total: 3, free: 0 }])).toEqual([]);
  });

  it("logs and stores the low pool after a successful fresh handout", async () => {
    const db = await createD1([
      "migrations/0001_init.sql",
      "migrations/0002_runs.sql",
      "migrations/0003_pool.sql",
      "migrations/0004_shipments.sql",
      "migrations/0005_meta.sql",
      "migrations/0006_sales.sql",
      "migrations/0007_event_done.sql",
    ]);
    for (let i = 1; i <= 3; i++) {
      await db.prepare("INSERT INTO pool (dispute_id, kind, position, added_at) VALUES (?, 'fight', ?, '2026-11-04')").bind(`F${i}`, i).run();
    }
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await nextForJudge(db, "visitor-a", "fight");
      const row = await db.prepare("SELECT value FROM meta WHERE key = 'pool_low_fight'").first<{ value: string }>();
      expect(row?.value).toMatch(/2 free$/);
      expect(log).toHaveBeenCalledWith("pool low: fight 2 free of 3");
    } finally {
      log.mockRestore();
    }
  });
});
