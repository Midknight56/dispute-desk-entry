/// <reference lib="dom" />
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Dispute } from "../web/src/format";
import type { NextCase } from "../web/src/api";

const hooks = vi.hoisted(() => ({ values: [] as any[], cursor: 0, effects: [] as (() => void)[], deps: [] as any[] }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState(initial: any) {
    const slot = hooks.cursor++;
    if (!(slot in hooks.values)) hooks.values[slot] = initial;
    return [
      hooks.values[slot],
      (next: any) => {
        hooks.values[slot] = typeof next === "function" ? next(hooks.values[slot]) : next;
      },
    ];
  },
  useRef(initial: any) {
    const slot = hooks.cursor++;
    if (!(slot in hooks.values)) hooks.values[slot] = { current: initial };
    return hooks.values[slot];
  },
  useCallback: (callback: any) => callback,
  useMemo: (calculate: any) => calculate(),
  useEffect(effect: () => void, deps: any[]) {
    const slot = hooks.cursor++;
    // App's callback is stable in React. This harness runs its mount effect once.
    if (!hooks.deps[slot]) hooks.effects.push(effect);
    hooks.deps[slot] = deps;
  },
}));
vi.mock("../web/src/api", () => ({
  getDisputes: vi.fn(),
  getFeed: vi.fn(),
  getMe: vi.fn(),
  getNext: vi.fn(),
  getShipNext: vi.fn(),
}));
vi.mock("../web/src/components/DisputeGrid", () => ({ default: () => null }));
vi.mock("../web/src/components/CasePanel", () => ({ default: () => null }));
vi.mock("../web/src/widgets/Ask", () => ({ default: () => null }));
import { getDisputes, getFeed, getMe, getNext, getShipNext } from "../web/src/api";
// @ts-expect-error The root project excludes JSX. The test runner supports it.
import App from "../web/src/App";
// @ts-expect-error The root project excludes JSX. The test runner supports it.
import DisputeGrid from "../web/src/components/DisputeGrid";
// @ts-expect-error The root project excludes JSX. The test runner supports it.
import CasePanel from "../web/src/components/CasePanel";
// @ts-expect-error The root project excludes JSX. The test runner supports it.
import Tiles from "../web/src/components/Tiles";
// @ts-expect-error The root project excludes JSX. The test runner supports it.
import Feed from "../web/src/components/Feed";

const row = (id: string, amount = "10"): Dispute => ({
  id,
  amount,
  currency: "USD",
  status: "WAITING_FOR_SELLER_RESPONSE",
  stage: "INQUIRY",
  reason: "OTHER",
  due: null,
  custom_id: null,
  updated_at: "",
});
const replay = (id: string): NextCase => ({
  disputeId: null,
  fresh: false,
  replay: {
    label: "Saved case",
    dispute: row(id),
    neurons: 0,
    run: {
      disputeId: id,
      decision: { verdict: "FIGHT", rule: "", why: "" },
      sentences: [],
      dropped: [],
      records: [],
      steps: [],
      writer: "template",
      chosenTools: [],
      usage: {},
    },
  },
});
let poll: () => void;
function render(): any {
  hooks.cursor = 0;
  const tree = App();
  hooks.effects.splice(0).forEach((effect) => effect());
  return tree;
}
function props(type: any): any {
  return findProps(type, render());
}
function findProps(type: any, tree: any): any {
  if (!tree || typeof tree !== "object") return;
  if (tree.type === type) return tree.props;
  for (const child of [tree.props?.children].flat(Infinity)) {
    const found = findProps(type, child);
    if (found) return found;
  }
}
async function settle() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}
beforeEach(() => {
  hooks.values = [];
  hooks.deps = [];
  hooks.effects = [];
  hooks.cursor = 0;
  vi.resetAllMocks();
  vi.stubGlobal("window", {
    sessionStorage: { getItem: () => null },
    location: { search: "" },
    setInterval: (callback: () => void) => {
      poll = callback;
      return 1;
    },
    clearInterval() {},
  });
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener() {}, removeEventListener() {} });
  vi.mocked(getNext).mockResolvedValue({ disputeId: "owned", replay: false, fresh: false });
  vi.mocked(getShipNext).mockResolvedValue({ disputeId: null, replay: false, fresh: false });
  vi.mocked(getMe).mockResolvedValue({ cases: [{ dispute_id: "owned", kind: "fight" }] });
  vi.mocked(getDisputes).mockImplementation(async () => []);
  vi.mocked(getFeed).mockResolvedValue([]);
});
afterEach(() => vi.unstubAllGlobals());

it("keeps both cached replay rows, selection and totals through every refresh", async () => {
  vi.mocked(getNext).mockResolvedValueOnce(replay("fight")).mockResolvedValueOnce(replay("accept"));
  render();
  await settle();
  expect(props(DisputeGrid).rows.map((item: Dispute) => item.id)).toEqual(["fight", "accept"]);
  const selected = props(CasePanel).id;
  expect(selected).not.toBeNull();
  for (let i = 0; i < 2; i++) {
    poll();
    await settle();
    expect(props(DisputeGrid).rows.map((item: Dispute) => item.id)).toEqual(["fight", "accept"]);
    expect(props(CasePanel).id).toBe(selected);
    expect(props(CasePanel).replay).toBeDefined();
    expect(props(Tiles).values).toMatchObject({ open: 2, onHold: 20 });
  }
  // A live row with the same ID wins without counting the replay twice.
  vi.mocked(getDisputes).mockResolvedValue([row("fight", "25")]);
  poll();
  await settle();
  expect(props(DisputeGrid).rows).toHaveLength(2);
  expect(props(Tiles).values.onHold).toBe(35);
});

it("retains ownership after the first list fails and restores access on retry", async () => {
  vi.mocked(getDisputes)
    .mockRejectedValueOnce(new Error("list failed"))
    .mockResolvedValue([row("owned")]);
  render();
  await settle();
  poll();
  await settle();
  expect(props(DisputeGrid).rows.map((item: Dispute) => item.id)).toEqual(["owned"]);
  expect(props(CasePanel).mine.has("owned")).toBe(true);
  expect(props(CasePanel).id).toBe("owned");
  expect(getNext).toHaveBeenCalledTimes(2);
  expect(getShipNext).toHaveBeenCalledTimes(1);
});

it("loads cases when shipping assignment fails and retries only the failed assignment", async () => {
  vi.mocked(getShipNext).mockRejectedValueOnce(new Error("shipping failed"));
  vi.mocked(getDisputes).mockResolvedValue([row("owned")]);
  render();
  await settle();
  expect(getDisputes).toHaveBeenCalledTimes(1);
  expect(props(DisputeGrid).loaded).toBe(true);
  expect(props(CasePanel).mine.has("owned")).toBe(true);
  expect(JSON.stringify(render())).toContain("Some updates did not load. Retrying.");
  poll();
  await settle();
  expect(getShipNext).toHaveBeenCalledTimes(2);
  expect(getNext).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(render())).not.toContain("Some updates did not load. Retrying.");
});

it("keeps the list and ownership available when the feed fails and recovers the feed separately", async () => {
  vi.mocked(getDisputes).mockResolvedValue([row("owned")]);
  vi.mocked(getFeed).mockRejectedValueOnce(new Error("feed failed"));
  render();
  await settle();
  expect(props(DisputeGrid).rows).toHaveLength(1);
  expect(props(CasePanel).mine.has("owned")).toBe(true);
  const event = { seq: 1, at: "", kind: "note" as const, title: "Saved event", ref: "", detail: "" };
  vi.mocked(getFeed).mockResolvedValueOnce([event]);
  poll();
  await settle();
  expect(getFeed).toHaveBeenCalledTimes(2);
  expect(props(CasePanel).mine.has("owned")).toBe(true);
  expect(props(Feed).rows).toEqual([event]);
  vi.mocked(getFeed).mockRejectedValueOnce(new Error("feed failed again"));
  vi.mocked(getMe).mockRejectedValueOnce(new Error("ownership refresh failed"));
  poll();
  await settle();
  expect(props(Feed).rows).toEqual([event]);
  expect(props(CasePanel).mine.has("owned")).toBe(true);
  expect(props(DisputeGrid).rows).toHaveLength(1);
});

it("loads the list despite a failed case assignment or ownership read and recovers both", async () => {
  vi.mocked(getNext).mockRejectedValueOnce(new Error("fight failed"));
  vi.mocked(getMe).mockRejectedValueOnce(new Error("ownership failed"));
  vi.mocked(getDisputes).mockResolvedValue([row("owned")]);
  render();
  await settle();
  expect(props(DisputeGrid).loaded).toBe(true);
  expect(props(CasePanel).mine.has("owned")).toBe(false);
  poll();
  await settle();
  expect(props(CasePanel).mine.has("owned")).toBe(true);
  expect(getNext).toHaveBeenCalledTimes(3);
  expect(getShipNext).toHaveBeenCalledTimes(1);
});

it("retains a fetched replay when the first list fails", async () => {
  vi.mocked(getNext).mockResolvedValueOnce(replay("fight"));
  vi.mocked(getDisputes).mockRejectedValueOnce(new Error("list failed"));
  render();
  await settle();
  poll();
  await settle();
  expect(props(DisputeGrid).rows.map((item: Dispute) => item.id)).toEqual(["fight"]);
  expect(props(CasePanel).replay).toBeDefined();
});
