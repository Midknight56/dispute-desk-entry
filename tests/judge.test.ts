import { describe, it, expect, vi } from "vitest";
import worker from "../src/index";
import { assign, checkActionable, lowKinds, nextForJudge, poolCounts, type PoolRow } from "../src/judge";
import * as judge from "../src/judge";
import { responseAction } from "../src/file";
import { createD1 } from "./helpers/d1";
import { actionableRoutes, ctx, fakePayPal, makeEnv } from "./helpers/env";

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
    "migrations/0010_pool_checked.sql",
  ]);

const liveDispute = (actions: string[] = ["provide_evidence"]) => ({
  status: "WAITING_FOR_SELLER_RESPONSE",
  seller_response_due_date: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
  links: actions.map((rel) => ({ rel, href: `https://api.test/${rel}`, method: "POST" })),
});

async function seedPool(db: D1Database, id: string, position: number, kind = "fight", holder: string | null = null) {
  await db.prepare("INSERT INTO pool (dispute_id, kind, position, handed_to, added_at) VALUES (?, ?, ?, ?, 'now')")
    .bind(id, kind, position, holder).run();
}

describe("usable deadlines and filing actions", () => {
  it("keeps the shared actionable fixtures usable for fight and accept", () => {
    const dispute = actionableRoutes(["FIXTURE"])["GET /v1/customer/disputes/FIXTURE"].json;
    expect(checkActionable(dispute, "fight")).toEqual({ ok: true });
    expect(checkActionable(dispute, "accept")).toEqual({ ok: true });
  });

  it.each([undefined, null, "", "not a date"])("retires an unusable deadline %s", (deadline) => {
    expect(checkActionable({ ...liveDispute(), seller_response_due_date: deadline }, "fight"))
      .toEqual({ ok: false, retire: true, why: "no response deadline" });
  });

  it.each(["RESOLVED", "CLOSED"])("checks %s before the deadline or actions", (status) => {
    expect(checkActionable({ status }, "fight")).toEqual({ ok: false, retire: true, why: "closed" });
  });

  it.each([-1, 0, 24])("retires a deadline %s hours away", (hours) => {
    const now = Date.now();
    expect(checkActionable({ ...liveDispute(), seller_response_due_date: new Date(now + hours * 3600 * 1000).toISOString() }, "fight", now))
      .toEqual({ ok: false, retire: true, why: "deadline passed" });
  });

  it.each([
    ["fight", "FIGHT", "provide_evidence"],
    ["fight", "FIGHT", "provide_supporting_info"],
    ["accept", "ACCEPT", "accept_claim"],
  ] as const)("an actionable %s with %s and %s can file", (kind, verdict, action) => {
    const dispute = liveDispute([action]);
    expect(checkActionable(dispute, kind)).toEqual({ ok: true });
    expect(responseAction(dispute, { verdict } as any)).toBeDefined();
  });

  it("retires a fight with only an offer link", () => {
    expect(checkActionable(liveDispute(["make_offer"]), "fight"))
      .toEqual({ ok: false, retire: true, why: "no evidence action" });
  });
});

describe("returning judge checks", () => {
  it("replaces a closed held case and records verification of the new row", async () => {
    const db = await makeJudgeDb();
    await seedPool(db, "OLD", 1, "fight", "visitor");
    await seedPool(db, "NEW", 2);
    const check = vi.fn((id: string) => checkActionable(id === "OLD" ? { status: "CLOSED" } : liveDispute(), "fight"));
    expect(await nextForJudge(db, "visitor", "fight", check)).toEqual({
      disputeId: "NEW", fresh: true, replay: false, replaced: "OLD",
      why: "Your last case is closed. Here is a new one.",
    });
    expect(check.mock.calls.map(([id]) => id)).toEqual(["OLD", "NEW"]);
    expect(await db.prepare("SELECT retired_at, retired_why, handed_to FROM pool WHERE dispute_id = 'OLD'").first())
      .toMatchObject({ retired_at: expect.any(String), retired_why: "closed", handed_to: "visitor" });
    expect(await db.prepare("SELECT checked_at FROM pool WHERE dispute_id = 'NEW'").first())
      .toEqual({ checked_at: expect.any(String) });
  });

  it.each([false, true])("keeps a held row on a read failure, thrown %s", async (throws) => {
    const db = await makeJudgeDb();
    await seedPool(db, "OLD", 1, "fight", "visitor");
    const check = vi.fn(() => {
      if (throws) throw new Error("offline");
      return { ok: false as const, retire: false as const, why: "offline" };
    });
    expect(await nextForJudge(db, "visitor", "fight", check))
      .toEqual({ disputeId: "OLD", fresh: false, replay: false });
    expect(check).toHaveBeenCalledExactlyOnceWith("OLD");
    expect(await db.prepare("SELECT handed_to, retired_at, checked_at FROM pool WHERE dispute_id = 'OLD'").first())
      .toEqual({ handed_to: "visitor", retired_at: null, checked_at: null });
  });

  it("skips the check for held ship rows and leaves unchecked claims unverified", async () => {
    const db = await makeJudgeDb();
    await seedPool(db, "SHIP", 1, "ship", "visitor");
    await seedPool(db, "NEW", 1);
    const check = vi.fn(() => ({ ok: true as const }));
    expect((await nextForJudge(db, "visitor", "ship", check)).disputeId).toBe("SHIP");
    expect(check).not.toHaveBeenCalled();
    await nextForJudge(db, "visitor", "fight");
    expect(await db.prepare("SELECT checked_at FROM pool WHERE dispute_id = 'NEW'").first()).toEqual({ checked_at: null });
  });
});

describe("verified stock", () => {
  it("expires verification just after twenty four hours", async () => {
    const db = await makeJudgeDb();
    await seedPool(db, "EDGE", 1);
    const now = Date.now();
    await db.prepare("UPDATE pool SET checked_at = ?").bind(new Date(now - 24 * 3600 * 1000).toISOString()).run();
    const check = vi.fn(() => ({ ok: true as const }));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    try {
      expect((await poolCounts(db))[0].verified).toBe(1);
      expect(await judge.verifyFree(db, "fight", check)).toEqual({ checked: 0, retired: 0, failed: 0 });
      expect(check).not.toHaveBeenCalled();
      vi.setSystemTime(now + 1);
      expect((await poolCounts(db))[0].verified).toBe(0);
      expect(await judge.verifyFree(db, "fight", check)).toEqual({ checked: 1, retired: 0, failed: 0 });
      expect(check).toHaveBeenCalledExactlyOnceWith("EDGE");
    } finally {
      vi.useRealTimers();
    }
  });

  it("verifies only stale free rows in position order up to the limit and preserves failures", async () => {
    const db = await makeJudgeDb();
    for (const [index, id] of ["GOOD", "CLOSED", "FAIL", "THROW", "STALE", "EXTRA", "RECENT", "HELD", "RETIRED"].entries()) {
      await seedPool(db, id, index, "fight", id === "HELD" ? "visitor" : null);
    }
    await seedPool(db, "ACCEPT", 0, "accept");
    const recent = new Date().toISOString();
    const stale = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    await db.prepare("UPDATE pool SET checked_at = ? WHERE dispute_id = 'RECENT'").bind(recent).run();
    await db.prepare("UPDATE pool SET checked_at = ? WHERE dispute_id IN ('STALE', 'FAIL')").bind(stale).run();
    await db.prepare("UPDATE pool SET retired_at = 'now' WHERE dispute_id = 'RETIRED'").run();
    const check = vi.fn((id: string) => {
      if (id === "THROW") throw new Error("offline");
      if (id === "FAIL") return { ok: false as const, retire: false as const, why: "offline" };
      if (id === "CLOSED") return { ok: false as const, retire: true as const, why: "closed" };
      return { ok: true as const };
    });
    expect(await judge.verifyFree(db, "fight", check)).toEqual({ checked: 2, retired: 1, failed: 2 });
    expect(check.mock.calls.map(([id]) => id)).toEqual(["GOOD", "CLOSED", "FAIL", "THROW", "STALE"]);
    const rows = (await db.prepare("SELECT * FROM pool").all<any>()).results;
    expect(rows.find((r) => r.dispute_id === "FAIL").checked_at).toBe(stale);
    expect(rows.find((r) => r.dispute_id === "THROW").checked_at).toBeNull();
    expect(rows.find((r) => r.dispute_id === "CLOSED")).toMatchObject({ retired_at: expect.any(String), retired_why: "closed" });
    expect(rows.find((r) => r.dispute_id === "STALE").checked_at).not.toBe(stale);
    expect(rows.find((r) => r.dispute_id === "RECENT").checked_at).toBe(recent);
    expect(rows.every((r) => r.dispute_id === "HELD" || r.handed_to === null)).toBe(true);
    expect(await poolCounts(db)).toContainEqual({ kind: "fight", total: 9, free: 6, retired: 2, verified: 3 });
    expect(await judge.verifyFree(db, "accept", () => ({ ok: true }), 0)).toEqual({ checked: 0, retired: 0, failed: 0 });
    expect(await judge.verifyFree(db, "accept", () => ({ ok: true }), 1)).toEqual({ checked: 1, retired: 0, failed: 0 });
  });

  it("counts only recently checked free stock and preserves ship counts", async () => {
    const db = await makeJudgeDb();
    for (const [i, id] of ["RECENT", "STALE", "UNCHECKED", "HELD", "RETIRED"].entries()) {
      await seedPool(db, id, i, "fight", id === "HELD" ? "visitor" : null);
    }
    await seedPool(db, "SHIP", 0, "ship");
    await db.prepare("UPDATE pool SET checked_at = ?").bind(new Date().toISOString()).run();
    await db.prepare("UPDATE pool SET checked_at = ? WHERE dispute_id = 'STALE'").bind(new Date(Date.now() - 25 * 3600 * 1000).toISOString()).run();
    await db.prepare("UPDATE pool SET checked_at = NULL WHERE dispute_id = 'UNCHECKED'").run();
    await db.prepare("UPDATE pool SET retired_at = 'now' WHERE dispute_id = 'RETIRED'").run();
    const counts = await poolCounts(db);
    expect(counts).toContainEqual({ kind: "fight", total: 5, free: 3, retired: 1, verified: 1 });
    expect(counts).toContainEqual({ kind: "ship", total: 1, free: 1 });
  });

  it.each([false, true])("reports verified zero without checked_at, retired schema %s", async (retired) => {
    const { DB } = await makeEnv();
    if (retired) {
      await DB.prepare("ALTER TABLE pool ADD COLUMN retired_at TEXT").run();
      await DB.prepare("ALTER TABLE pool ADD COLUMN retired_why TEXT").run();
    }
    await seedPool(DB, "OLD", 1);
    expect(await poolCounts(DB)).toEqual([{ kind: "fight", total: 1, free: 1, retired: 0, verified: 0 }]);
  });
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

  it("retires resolved cases and cases missing the required action", async () => {
    const db = await makeJudgeDb();
    await db.prepare("INSERT INTO pool (dispute_id, kind, position, added_at) VALUES ('PP-RES', 'fight', 1, 'now')").run();
    await db.prepare("INSERT INTO pool (dispute_id, kind, position, added_at) VALUES ('PP-NOLINK', 'fight', 2, 'now')").run();
    await db.prepare("INSERT INTO pool (dispute_id, kind, position, added_at) VALUES ('PP-FIGHT-OK', 'fight', 3, 'now')").run();

    const fightDisputes: Record<string, any> = {
      "PP-RES": { status: "RESOLVED", links: [{ rel: "provide_evidence" }] },
      "PP-NOLINK": liveDispute(["other_action"]),
      "PP-FIGHT-OK": liveDispute(["provide_evidence"]),
    };

    const fightA = await nextForJudge(db, "judge-f", "fight", (id) => checkActionable(fightDisputes[id], "fight"));
    expect(fightA.disputeId).toBe("PP-FIGHT-OK");

    const rowRes = await db.prepare("SELECT retired_why FROM pool WHERE dispute_id = 'PP-RES'").first<any>();
    expect(rowRes?.retired_why).toBe("closed");
    const rowNoLink = await db.prepare("SELECT retired_why FROM pool WHERE dispute_id = 'PP-NOLINK'").first<any>();
    expect(rowNoLink?.retired_why).toBe("no evidence action");

    // Accept case with no accept link
    await db.prepare("INSERT INTO pool (dispute_id, kind, position, added_at) VALUES ('PP-ACC-NO', 'accept', 1, 'now')").run();
    await db.prepare("INSERT INTO pool (dispute_id, kind, position, added_at) VALUES ('PP-ACC-OK', 'accept', 2, 'now')").run();

    const acceptDisputes: Record<string, any> = {
      "PP-ACC-NO": liveDispute(["provide_evidence"]),
      "PP-ACC-OK": liveDispute(["accept_claim"]),
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

  it("a row the visitor already holds comes back after a successful check", async () => {
    const db = await makeJudgeDb();
    await db.prepare("INSERT INTO pool (dispute_id, kind, position, handed_to, handed_at, added_at) VALUES ('PP-MINE', 'fight', 1, 'judge-x', '2026-11-04', 'now')").run();

    const check = vi.fn(() => ({ ok: true as const }));
    const a = await nextForJudge(db, "judge-x", "fight", check);
    expect(a).toEqual({ disputeId: "PP-MINE", replay: false, fresh: false });
    expect(check).toHaveBeenCalledExactlyOnceWith("PP-MINE");
    expect((await db.prepare("SELECT checked_at FROM pool WHERE dispute_id = 'PP-MINE'").first<any>())?.checked_at).toBeTruthy();
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
      verified: 0,
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
  it("verifies at most five free rows per kind only on request and once per ten minutes", async () => {
    const { env } = await makeEnv();
    env.DB = await makeJudgeDb();
    const routes: Parameters<typeof fakePayPal>[0] = {};
    for (const kind of ["fight", "accept"] as const) {
      for (let i = 1; i <= 6; i++) {
        const id = `${kind}${i}`;
        await seedPool(env.DB, id, i, kind);
        routes[`GET /v1/customer/disputes/${id}`] = {
          json: i === 2 ? { status: "CLOSED" } : i === 3 ? { name: "OFFLINE" } : liveDispute([kind === "fight" ? "provide_supporting_info" : "accept_claim"]),
          status: i === 3 ? 503 : 200,
        };
      }
    }
    await seedPool(env.DB, "SHIP", 0, "ship");
    const calls = fakePayPal(routes);
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const request = (query = "") => worker.fetch(new Request(`https://desk.test/api/judge/pool${query}`), env, ctx().context);
    try {
      await request();
      expect(calls).toHaveLength(0);
      const responses = await Promise.all([request("?verify=1"), request("?verify=1")]);
      expect(responses.every((r) => r.status === 200)).toBe(true);
      expect(calls.filter((c) => c.path.startsWith("/v1/customer/disputes/"))).toHaveLength(10);
      const counts = await (await request()).json();
      for (const kind of ["fight", "accept"]) {
        expect(counts).toContainEqual({ kind, total: 6, free: 5, retired: 1, verified: 3 });
      }
      expect(counts).toContainEqual({ kind: "ship", total: 1, free: 1 });
      expect(await env.DB.prepare("SELECT value FROM meta WHERE key = 'pool_verify_at'").first()).toBeTruthy();
      vi.setSystemTime(now + 10 * 60 * 1000 - 1);
      await request("?verify=1");
      expect(calls.filter((c) => c.path.startsWith("/v1/customer/disputes/"))).toHaveLength(10);
      vi.setSystemTime(now + 10 * 60 * 1000);
      await request("?verify=1");
      expect(calls.filter((c) => c.path.startsWith("/v1/customer/disputes/"))).toHaveLength(14);
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM pool WHERE handed_to IS NOT NULL").first()).toEqual({ n: 0 });
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

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
        verified: 0,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
