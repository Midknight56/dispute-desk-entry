import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

const harness = vi.hoisted(() => ({
  values: [] as any[],
  cursor: 0,
  effects: [] as (() => unknown)[],
  collect: true,
  root: null as any,
  refresh: null as any,
  retry: null as any,
  getDisputes: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState(initial: any) {
    const slot = harness.cursor++;
    if (!(slot in harness.values)) harness.values[slot] = typeof initial === "function" ? initial() : initial;
    return [
      harness.values[slot],
      (next: any) => {
        harness.values[slot] = typeof next === "function" ? next(harness.values[slot]) : next;
      },
    ];
  },
  useEffect(effect: () => unknown) {
    if (harness.collect) harness.effects.push(effect);
  },
}));
vi.mock("react-dom/client", () => ({
  createRoot: () => ({
    render: (root: any) => {
      harness.root = root;
    },
  }),
}));
vi.mock("ag-studio", () => ({
  AgStudioAiModule: {},
  studioTheme: { withParams: () => ({}) },
  enableStudioDevValidations: vi.fn(),
  clientToolRunner: vi.fn(),
  createAiHarness: vi.fn(),
}));
vi.mock("ag-studio-react", async () => {
  const { createElement } = await import("react");
  return {
    createWidgets: (widgets: unknown) => widgets,
    AgStudioProvider: ({ children }: { children: ReactNode }) => children,
    AgStudio: ({ data }: any) =>
      createElement("div", { "data-testid": "dashboard" }, `Retained amount ${data.sources[0].data[0]?.held_amount}`),
  };
});
vi.mock("../web/src/api", () => ({
  getDisputes: harness.getDisputes,
  getShipNext: async () => ({}),
  getDispute: vi.fn(),
}));
vi.mock("../web/src/components/CaseStates", async (original) => {
  const actual = await original<any>();
  return {
    ...actual,
    LoadNotice: (props: any) => {
      harness.retry = props.retry;
      return actual.LoadNotice(props);
    },
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it("review4 item 6 shows a persistent warning and retry beside retained dashboard data", async () => {
  vi.stubGlobal("window", {
    location: { search: "" },
    innerWidth: 1400,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    setInterval(callback: () => unknown) {
      harness.refresh = callback;
      return 1;
    },
    clearInterval() {},
  });
  vi.stubGlobal("document", {
    getElementById: () => ({}),
    visibilityState: "visible",
    addEventListener() {},
    removeEventListener() {},
    documentElement: { style: { setProperty() {} } },
  });
  harness.getDisputes.mockResolvedValueOnce([
    {
      id: "R4",
      amount: "6.00",
      currency: "USD",
      status: "WAITING_FOR_SELLER_RESPONSE",
      reason: "OTHER",
      stage: "INQUIRY",
      kinds: [],
      updated_at: "",
    },
  ]);
  // @ts-expect-error The server project does not enable JSX. The test runner supports it.
  await import("../web/src/studio/main");
  const render = () => {
    harness.cursor = 0;
    return renderToStaticMarkup(harness.root);
  };
  render();
  const cleanup = harness.effects.map((effect) => effect());
  harness.collect = false;
  await vi.waitFor(() => expect(harness.getDisputes).toHaveBeenCalledTimes(1));
  expect(render()).toContain("Retained amount 6");
  harness.getDisputes.mockRejectedValueOnce(new Error("refresh failed"));
  await harness.refresh();
  const stale = render();
  expect(stale).toContain("Retained amount 6");
  expect(stale).toContain("The refresh failed. Showing saved data.");
  expect(stale).toContain("Try again");
  harness.getDisputes.mockResolvedValueOnce([
    {
      id: "R4",
      amount: "9.00",
      currency: "USD",
      status: "WAITING_FOR_SELLER_RESPONSE",
      reason: "OTHER",
      stage: "INQUIRY",
      kinds: [],
      updated_at: "",
    },
  ]);
  harness.retry();
  // A retry changes the effect dependency. Run the refreshed effect as React does.
  harness.effects = [];
  harness.collect = true;
  render();
  harness.collect = false;
  const retryCleanup = harness.effects.map((effect) => effect());
  await vi.waitFor(() => expect(harness.getDisputes).toHaveBeenCalledTimes(3));
  const fresh = render();
  expect(fresh).toContain("Retained amount 9");
  expect(fresh).not.toContain("The refresh failed. Showing saved data.");
  for (const stop of [...cleanup, ...retryCleanup]) if (typeof stop === "function") stop();
});
