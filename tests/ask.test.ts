import { describe, it, expect } from "vitest";
import { parseSpec, keywordSpec, chartRows, chartData, chartTitle, type ChartSpec } from "../src/ask";

const rows = [
  {
    reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    status: "RESOLVED",
    stage: "INQUIRY",
    amount: "6.00",
    currency: "USD",
    created: "2026-10-23T02:02:32Z",
  },
  {
    reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    status: "UNDER_REVIEW",
    stage: "CHARGEBACK",
    amount: "48.00",
    currency: "USD",
    created: "2026-10-23T01:39:36Z",
  },
  {
    reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
    status: "UNDER_REVIEW",
    stage: "INQUIRY",
    amount: "10.50",
    currency: "USD",
    created: "2026-07-01T00:00:00Z",
  },
];

describe("ask in words", () => {
  it("keeps a valid spec from the model's reply", () => {
    const s = parseSpec('Sure: {"chart": "bar", "groupBy": "reason", "metric": "count", "period": "quarter"}');
    expect(s).toEqual({ chart: "bar", groupBy: "reason", metric: "count", period: "quarter" });
  });

  it("refuses fields that are not on the list", () => {
    expect(parseSpec('{"chart": "bar", "groupBy": "buyer_email", "metric": "count", "period": "all"}')).toBeUndefined();
    expect(
      parseSpec('{"chart": "pie", "groupBy": "status", "metric": "sum_of_secrets", "period": "all"}'),
    ).toBeUndefined();
    expect(parseSpec("no json")).toBeUndefined();
  });

  it("reads the plain question without the model", () => {
    expect(keywordSpec("disputes by reason this quarter")).toEqual({
      chart: "bar",
      groupBy: "reason",
      metric: "count",
      period: "quarter",
    });
    expect(keywordSpec("money on hold by stage")).toEqual({
      chart: "bar",
      groupBy: "stage",
      metric: "held",
      period: "all",
    });
    expect(keywordSpec("status split as a pie")).toEqual({
      chart: "pie",
      groupBy: "status",
      metric: "count",
      period: "all",
    });
  });

  it("counts by reason for this quarter, with the seller's words as labels", () => {
    const spec: ChartSpec = { chart: "bar", groupBy: "reason", metric: "count", period: "quarter" };
    expect(chartRows(rows, spec, new Date("2026-10-23T12:00:00Z"))).toEqual([{ key: "Not received", value: 2 }]);
  });

  it("sums the amounts by stage over all time", () => {
    const spec: ChartSpec = { chart: "bar", groupBy: "stage", metric: "amount", period: "all" };
    expect(chartRows(rows, spec, new Date("2026-10-23T12:00:00Z"))).toEqual([
      { key: "Claim", value: 48 },
      { key: "Inquiry", value: 16.5 },
    ]);
  });

  it("keeps resolved money out of the held total", () => {
    const holdRows = [
      { reason: "OTHER", status: "RESOLVED", stage: "INQUIRY", amount: "100.00", currency: "USD", created: "2026-10-23T00:00:00Z" },
      { reason: "OTHER", status: "WAITING_FOR_SELLER_RESPONSE", stage: "INQUIRY", amount: "6.00", currency: "USD", created: "2026-10-23T00:00:00Z" },
    ];
    const spec = keywordSpec("Money on hold by stage");
    expect(spec.metric).toBe("held");
    expect(chartRows(holdRows, spec)).toEqual([{ key: "Inquiry", value: 6 }]);
    expect(chartRows(holdRows, { ...spec, metric: "amount" })).toEqual([{ key: "Inquiry", value: 106 }]);
    expect(parseSpec('{"chart":"bar","groupBy":"stage","metric":"held","period":"all"}')?.metric).toBe("held");
  });

  it("keeps other currencies out of money totals while counting all disputes", () => {
    const mixed = [
      { reason: "OTHER", status: "WAITING_FOR_SELLER_RESPONSE", stage: "INQUIRY", amount: "6", currency: "USD", created: "2026-10-23T00:00:00Z" },
      { reason: "OTHER", status: "WAITING_FOR_SELLER_RESPONSE", stage: "INQUIRY", amount: "100", currency: "EUR", created: "2026-10-23T00:00:00Z" },
    ];
    const spec = keywordSpec("money on hold by stage");
    expect(chartData(mixed, spec)).toEqual({ rows: [{ key: "Inquiry", value: 6 }], leftOut: 1 });
    expect(chartTitle(spec, 1)).toContain("USD only, 1 case in another currency left out");
    expect(chartRows(mixed, { ...spec, metric: "count" })).toEqual([{ key: "Inquiry", value: 2 }]);
  });
});
