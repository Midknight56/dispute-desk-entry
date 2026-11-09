import { describe, it, expect, vi } from "vitest";
import worker from "../src/index";
import { assign, checkActionable, lowKinds, nextForJudge, poolCounts, type PoolRow } from "../src/judge";
import { createD1 } from "./helpers/d1";
import { ctx, fakePayPal, makeEnv } from "./helpers/env";

const row = (id: string, over: Partial<PoolRow> = {}): PoolRow => ({
  dispute_id: id,
  kind: "fight",
  position: Number(id.replace(/\D/g, "")),
  handed_to: null,
  handed_at: null,
  ...over,
});

const makeJudgeDb = () =>
  createD1([
    "migrations/0001_init.sql",
    "migrations/0002_runs.sql",
    "migrations/0003_pool.sql",
    "migrations/0004_shipments.sql",
    "migrations/0005_meta.sql",
    "migrations/0006_sales.sql",
    "migrations/0007_event_done.sql",
    "migrations/0008_event_claim.sql",
    "migrations/0009_pool_retired.sql",
  ]);

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

  it("skips retired rows when finding free rows or returning visitor rows", () => {
    const pool = [
      row("D1", { retired_at: "2026-11-09T00:00:00Z", handed_to: "judge-a" }),
      row("D2", { retired_at: "2026-11-09T00:00:00Z" }),
      row("D3"),
    ];
    expect(assign(pool, "judge-a", "fight")).toEqual({ disputeId: "D3", replay: false, fresh: true });
  });
});

describe("actionable checks and handouts", () => {
  it("an expired case (deadline 1 hour away) is retired and the judge gets the next row", async () => {
    const db = await makeJudgeDb();
    await db.prepare("INSERT INTO pool (dispute_id, kind, position, added_at) VALUES ('PP-EXP', 'fight', 1, 'now')").run();
    await db.prepare("INSERT INTO pool (dispute_id, kind, position, added_at) VALUES ('PP-GOOD', 'fight', 2, 'now')").run();

    const disputes: Record<string, any> = {
      "PP-EXP": {
        status: "WAITING_FOR_SELLER_RESPONSE",
        seller_response_due_date: new Date(Date.now() + 3600 * 1000).toISOString(),
        links: [{ rel: "provide_evidence" }],
      },
      "PP-GOOD": {
        status: "WAITING_FOR_SELLER_RESPONSE",
        seller_response_due_date: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
        links: [{ rel: "provide_evidence" }],
      },
    };

    const check = (id: string) => checkActionable(disputes[id], "fight");
    const a = await nextForJudge(db, "judge-a", "fight", check);
    expect(a).toEqual({ disputeId: "PP-GOOD", replay: false, fresh: true });

    const retired = await db.prepare("SELECT dispute_id, retired_at, retired_why, handed_to FROM pool WHERE dispute_id = 'PP-EXP'").first<any>();
    expect(retired?.retired_at).toBeTruthy();
    expect(retired?.retired_why).toBe("deadline passed");
    expect(retired?.handed_to).toBe("judge-a");
  });

  it("a resolved case is retired; a fight case with no evidence or offer link is retired; an accept case with no accept link is retired", async () => {
    const db = await makeJudgeDb();
    await db.prepare("INSERT INTO pool (dispute_id, kind, position, added_at) VALUES ('PP-RES', 'fight', 1, 'now')").run();
    await db.prepare("INSERT INTO pool (dispute_id, kind, position, added_at) VALUES ('PP-NOLINK', 'fight', 2, 'now')").run();
    await db.prepare("INSERT INTO pool (dispute_id, kind, position, added_at) VALUES ('PP-FIGHT-OK', 'fight', 3, 'now')").run();

    const fightDisputes: Record<string, any> = {
      "PP-RES": { status: "RESOLVED", links: [{ rel: "provide_evidence" }] },
      "PP-NOLINK": { status: "WAITING_FOR_SELLER_RESPONSE", links: [{ rel: "other_action" }] },
      "PP-FIGHT-OK": { status: "WAITING_FOR_SELLER_RESPONSE", links: [{ rel: "make_offer" }] },
    };

    const fightA = await nextForJudge(db, "judge-f", "fight", (id) => checkActionable(fightDisputes[id], "fight"));
    expect(fightA.disputeId).toBe("PP-FIGHT-OK");

    const rowRes = await db.prepare("SELECT retired_why FROM pool WHERE dispute_id = 'PP-RES'").first<any>();
    expect(rowRes?.retired_why).toBe("closed");
    const rowNoLink = await db.prepare("SELECT retired_why FROM pool WHERE dispute_id = 'PP-NOLINK'").first<any>();
    expect(rowNoLink?.retired_why).toBe("no evidence or offer action");

    // Accept case with no accept link
    await db.prepare("INSERT INTO pool (dispute_id, kind, position, added_at) VALUES ('PP-ACC-NO', 'accept', 1, 'now')").run();
    await db.prepare("INSERT INTO pool (dispute_id, kind, position, added_at) VALUES ('PP-ACC-OK', 'accept', 2, 'now')").run();

    const acceptDisputes: Record<string, any> = {
      "PP-ACC-NO": { status: "WAITING_FOR_SELLER_RESPONSE", links: [{ rel: "provide_evidence" }] },
      "PP-ACC-OK": { status: "WAITING_FOR_SELLER_RESPONSE", links: [{ rel: "accept_claim" }] },
    };

    const acceptA = await nextForJudge(db, "judge-acc", "accept", (id) => checkActionable(acceptDisputes[id], "accept"));
    expect(acceptA.disputeId).toBe("PP-ACC-OK");

    const rowAccNo = await db.prepare("SELECT retired_why FROM pool WHERE dispute_id = 'PP-ACC-NO'").first<any>();
    expect(rowAccNo?.retired_why).toBe("no accept action");
  });

  it("a PayPal read failure hands out nothing, returns replay with the why line, and leaves the row free for later", async () => {
    const db = await makeJudgeDb();
    await db.prepare("INSERT INTO pool (dispute_id, kind, position, added_at) VALUES ('PP-FAIL', 'fight', 1, 'now')").run();

    const a = await nextForJudge(db, "judge-a", "fight", () => ({ ok: false, retire: false, why: "offline" }));
    expect(a).toEqual({
      disputeId: null,
      replay: true,
      fresh: false,
      why: "PayPal did not answer. Here is a recorded run.",
    });

    const row = await db.prepare("SELECT handed_to, handed_at, retired_at FROM pool WHERE dispute_id = 'PP-FAIL'").first<any>();
    expect(row?.handed_to).toBeNull();
    expect(row?.handed_at).toBeNull();
    expect(row?.retired_at).toBeNull();
  });

  it("two visitors asking at once never get the same row (simulate with two calls on the same fake db)", async () => {
    const db = await makeJudgeDb();
    await db.prepare("INSERT INTO pool (dispute_id, kind, position, added_at) VALUES ('PP-1', 'fight', 1, 'now')").run();
    await db.prepare("INSERT INTO pool (dispute_id, kind, position, added_at) VALUES ('PP-2', 'fight', 2, 'now')").run();

    const [a, b] = await Promise.all([
      nextForJudge(db, "visitor-1", "fight", () => ({ ok: true })),
      nextForJudge(db, "visitor-2", "fight", () => ({ ok: true })),
    ]);

    expect(a.disputeId).toBeTruthy();
    expect(b.disputeId).toBeTruthy();
    expect(a.disputeId).not.toBe(b.disputeId);
    expect(new Set([a.disputeId, b.disputeId])).toEqual(new Set(["PP-1", "PP-2"]));
  });

  it("a row the visitor already holds comes back without a check call", async () => {
    const db = await makeJudgeDb();
    await db.prepare("INSERT INTO pool (dispute_id, kind, position, handed_to, handed_at, added_at) VALUES ('PP-MINE', 'fight', 1, 'judge-x', '2026-11-04', 'now')").run();

    const check = vi.fn();
    const a = await nextForJudge(db, "judge-x", "fight", check);
    expect(a).toEqual({ disputeId: "PP-MINE", replay: false, fresh: false });
    expect(check).not.toHaveBeenCalled();
  });

  it("the empty pool still returns the recorded run (replay: true) as today", async () => {
    const db = await makeJudgeDb();
    const check = vi.fn();
    const a = await nextForJudge(db, "judge-x", "fight", check);
    expect(a).toEqual({ disputeId: null, replay: true, fresh: false });
    expect(check).not.toHaveBeenCalled();
  });

  it("counts: retired rows are not counted as free", async () => {
    const db = await makeJudgeDb();
    await db.prepare("INSERT INTO pool (dispute_id, kind, position, retired_at, retired_why, added_at) VALUES ('PP-RET', 'fight', 1, 'now', 'closed', 'now')").run();
    await db.prepare("INSERT INTO pool (dispute_id, kind, position, handed_to, handed_at, added_at) VALUES ('PP-HANDED', 'fight', 2, 'user-1', 'now', 'now')").run();
    await db.prepare("INSERT INTO pool (dispute_id, kind, position, added_at) VALUES ('PP-FREE', 'fight', 3, 'now')").run();

    const counts = await poolCounts(db);
    const fightCount = counts.find((c) => c.kind === "fight");
    expect(fightCount).toEqual({
      kind: "fight",
      total: 3,
      free: 1,
      retired: 1,
    });
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

describe("judge routes with PayPal check", () => {
  it("routes /api/judge/next through PayPal actionable check and /api/judge/pool reporting retired", async () => {
    const { env, DB } = await makeEnv();
    await DB.prepare("ALTER TABLE pool ADD COLUMN retired_at TEXT").run();
    await DB.prepare("ALTER TABLE pool ADD COLUMN retired_why TEXT").run();

    await DB.prepare("INSERT INTO pool (dispute_id, kind, position, added_at) VALUES ('PP-R-EXP', 'fight', 1, 'now')").run();
    await DB.prepare("INSERT INTO pool (dispute_id, kind, position, added_at) VALUES ('PP-R-LIVE', 'fight', 2, 'now')").run();

    fakePayPal({
      "GET /v1/customer/disputes/PP-R-EXP": {
        json: {
          status: "WAITING_FOR_SELLER_RESPONSE",
          seller_response_due_date: new Date(Date.now() + 1800 * 1000).toISOString(),
          links: [{ rel: "provide_evidence" }],
        },
      },
      "GET /v1/customer/disputes/PP-R-LIVE": {
        json: {
          status: "WAITING_FOR_SELLER_RESPONSE",
          seller_response_due_date: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
          links: [{ rel: "provide_evidence" }],
        },
      },
    });

    try {
      const response = await worker.fetch(
        new Request("https://desk.test/api/judge/next?kind=fight", {
          headers: { "user-agent": "judge-browser" },
        }),
        env,
        ctx().context,
      );
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toMatchObject({ disputeId: "PP-R-LIVE", fresh: true });

      const poolResponse = await worker.fetch(
        new Request("https://desk.test/api/judge/pool"),
        env,
        ctx().context,
      );
      const poolData = (await poolResponse.json()) as any[];
      const fightPool = poolData.find((p) => p.kind === "fight");
      expect(fightPool).toEqual({
        kind: "fight",
        total: 2,
        free: 0,
        retired: 1,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
