import { describe, it, expect } from "vitest";
import {
  runAgent,
  firstJson,
  sentenceStrings,
  normalizeSentences,
  dropUnsupportedNumbers,
  type AgentDeps,
  type ModelFn,
} from "../src/agent";

const replyA = `{"sentences": [
  "The payment was made on 2026-11-03 for $10.00, as shown in the payment record [06T4262533119530V].",
  "The shipping record [ship-dd-p060] shows that the package was delivered on 2026-11-03 00:48 UTC with UPS number 1Z999AA193666881, which is marked as DELIVERED.",
  "The order [4RR35355RL5596630] was shipped to Toronto, ON, CA, and the delivery was confirmed by UPS on the same day, 2026-11-03."`;

const replyB = `{"sentences": [
  "The order was shipped with UPS number 1Z999AA193666576, which is recorded as DELIVERED on 2026-11-03 00:42 UTC, record ID: [ship-dd-p059].",
  "The payment for the order was made on 2026-11-03, record ID: [5WC72421N7153143J].",
  "The total amount of the order is $7.25, record ID: [PP-R-DQF-10196051].",
  "The order was shipped to San Jose, CA, US, record ID: [2YW93255P1961943M]"`;

// Shapes copied from the sandbox answers of 22 Oct (ids made up).
function dispute(over: any = {}) {
  return {
    dispute_id: "PP-R-1",
    reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    status: "UNDER_REVIEW",
    dispute_life_cycle_stage: "CHARGEBACK",
    create_time: "2026-10-23T01:39:36.407Z",
    dispute_amount: { currency_code: "USD", value: "48.00" },
    disputed_transactions: [{ seller_transaction_id: "CAP1", custom: "dd-0001" }],
    evidences: [{ evidence_type: "CREATE", source: "SUBMITTED_BY_BUYER", notes: "They never arrived." }],
    ...over,
  };
}
const capture = (over: any = {}) => ({
  id: "CAP1",
  status: "COMPLETED",
  amount: { currency_code: "USD", value: "48.00" },
  create_time: "2026-10-20T01:26:57Z",
  supplementary_data: { related_ids: { order_id: "ORD1" } },
  ...over,
});
const order = (trackers: any[] = [{ id: "CAP1-1Z9" }]) => ({
  id: "ORD1",
  status: "COMPLETED",
  purchase_units: [
    {
      description: "Hand thrown mug, set of two",
      shipping: { address: { admin_area_2: "Toronto", admin_area_1: "ON", country_code: "CA" }, trackers },
    },
  ],
});
const tracker = { transaction_id: "CAP1", tracking_number: "1Z9", status: "DELIVERED", carrier: "UPS" };
const paymentSentence = { text: "The buyer paid $48.00 on 2026-10-20.", record_id: "CAP1" };
const trackingSentences = (id = "CAP1-1Z9", seller = false, time = "2026-10-20 12:00", number = "1Z9") => [
  {
    text: `${seller ? "Our shipping record" : "The tracking record"} shows UPS number ${number}, status DELIVERED${seller ? "" : " on PayPal"}.`,
    record_id: id,
  },
  { text: `Our shipping record shows it delivered ${time} UTC.`, record_id: id },
];
const orderSentence = {
  text: "The order was Hand thrown mug, set of two, shipping to Toronto, ON, CA.",
  record_id: "ORD1",
};
const fightTemplate = [trackingSentences()[1], paymentSentence, trackingSentences()[0], orderSentence];

function deps(over: Partial<AgentDeps> = {}): AgentDeps {
  return {
    getDispute: async () => dispute(),
    getCapture: async () => capture(),
    getOrder: async () => order(),
    getTracker: async () => tracker,
    deliveredAt: async () => "2026-10-20T12:00:00Z",
    ...over,
  };
}

function model(...replies: string[]): ModelFn & { calls: number } {
  const f = (async () => {
    f.calls += 1;
    return { text: replies[f.calls - 1] ?? "", usage: { prompt_tokens: 300, completion_tokens: 40 } };
  }) as unknown as ModelFn & { calls: number };
  f.calls = 0;
  return f;
}

describe("dispute agent", () => {
  it("fetches required tracking when the model picks only an invoice", async () => {
    let trackingCalls = 0;
    const m = model('{"tools": ["get_invoice"]}', "not json");
    const r = await runAgent(
      "PP-R-1",
      deps({
        model: m,
        getTracker: async () => {
          trackingCalls += 1;
          return tracker;
        },
      }),
    );
    expect(trackingCalls).toBe(1);
    expect(r.decision.verdict).toBe("FIGHT");
    expect(r.steps.some((s) => s.summary === "added by the rule: not received needs tracking")).toBe(true);
    expect(r.steps.find((s) => s.tool === "get_invoice")?.summary).toBe("no invoice for this sale");
  });

  it("fetches the not as described reason's required records when the model picks nothing", async () => {
    let orderCalls = 0;
    const m = model('{"tools": []}', "not json");
    const r = await runAgent(
      "PP-R-1",
      deps({
        model: m,
        getDispute: async () => dispute({ reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED" }),
        getOrder: async () => {
          orderCalls += 1;
          return order();
        },
      }),
    );
    expect(orderCalls).toBe(1);
    expect(r.records.some((record) => record.kind === "order")).toBe(true);
    expect(r.steps.map((s) => s.tool)).toContain("get_order");
  });

  it("case 1: item not received, delivered before the claim, fights with backed sentences", async () => {
    const m = model('{"tools": ["get_order", "get_tracking"]}', 'Here you go: {"facts":["F3","F1"]}');
    const r = await runAgent("PP-R-1", deps({ model: m }));
    expect(r.decision.verdict).toBe("FIGHT");
    expect(r.decision.rule).toBe("INR_DELIVERED_BEFORE_CLAIM");
    expect(r.writer).toBe("model");
    expect(r.sentences).toEqual([trackingSentences()[1], paymentSentence]);
    expect(r.selected).toEqual(["F3", "F1"]);
    expect(r.dropped).toEqual([]);
    expect(r.steps.map((s) => s.tool)).toEqual(["get_dispute", "get_capture", "get_order", "get_tracking"]);
    expect(r.steps[0].summary).toBe("not received, with PayPal, $48.00");
    expect(r.usage).toEqual({ prompt_tokens: 600, completion_tokens: 80, calls: 2 });
  });

  it("case 2: a $6.00 digital item with no tracking is accepted", async () => {
    const m = model(
      '{"tools": ["get_order", "get_tracking"]}',
      '{"sentences": [{"text": "We refund in full.", "record_id": "PP-R-2"}]}',
    );
    const r = await runAgent(
      "PP-R-2",
      deps({
        model: m,
        getDispute: async () =>
          dispute({ dispute_id: "PP-R-2", dispute_amount: { currency_code: "USD", value: "6.00" } }),
        getCapture: async () => capture({ amount: { currency_code: "USD", value: "6.00" } }),
        getOrder: async () => order([]),
      }),
    );
    expect(r.decision.verdict).toBe("ACCEPT");
    expect(r.decision.why).toContain("$6.00");
    expect(r.sentences).toEqual([
      { text: "The buyer paid $6.00 on 2026-10-20.", record_id: "CAP1" },
      { text: "We accept the claim and refund in full.", record_id: "PP-R-2" },
    ]);
    expect(r.dropped).toEqual([{ text: "We refund in full.", record_id: "PP-R-2" }]);
    expect(r.writer).toBe("template");
  });

  it("uses the template when the model is not available, and every sentence still names a record", async () => {
    const r = await runAgent("PP-R-1", deps());
    expect(r.writer).toBe("template");
    expect(r.decision.verdict).toBe("FIGHT");
    expect(r.sentences).toEqual(fightTemplate);
    const ids = new Set(r.records.map((x) => x.id));
    expect(r.sentences.length).toBeGreaterThan(0);
    for (const s of r.sentences) expect(ids.has(s.record_id)).toBe(true);
  });

  it("falls back to the default tools when the model names none it knows", async () => {
    const m = model('{"tools": ["rm_rf", 7]}', "not json at all");
    const r = await runAgent("PP-R-1", deps({ model: m }));
    expect(r.chosenTools).toEqual(["get_order", "get_tracking"]);
    expect(r.writer).toBe("template");
  });

  it("keeps the fight when every model sentence names a wrong record: the template writes from the records", async () => {
    const m = model(
      '{"tools": ["get_order", "get_tracking"]}',
      '{"sentences": [{"text": "Trust me.", "record_id": "X"}]}',
    );
    const r = await runAgent("PP-R-1", deps({ model: m }));
    expect(r.decision.verdict).toBe("FIGHT");
    expect(r.writer).toBe("template");
    expect(r.dropped.map((s) => s.record_id)).toEqual(["X"]);
    for (const s of r.sentences) expect(r.records.some((x) => x.id === s.record_id)).toBe(true);
  });

  it("does not fight when the delivery was marked after the claim", async () => {
    const r = await runAgent("PP-R-1", deps({ deliveredAt: async () => "2026-10-24T00:00:00Z" }));
    expect(r.decision.verdict).toBe("OFFER");
    expect(r.decision.rule).toBe("WEAK_EVIDENCE");
  });

  it("drops a sentence whose numbers are not in the record it names", async () => {
    const m = model(
      '{"tools": ["get_order", "get_tracking"]}',
      '{"sentences": [{"text": "The buyer paid $48.00 on 2026-10-20.", "record_id": "CAP1"},' +
        '{"text": "The buyer paid $95.00 on 2026-10-20.", "record_id": "CAP1"}]}',
    );
    const r = await runAgent("PP-R-1", deps({ model: m }));
    expect(r.sentences).toEqual(fightTemplate);
    expect(r.dropped.map((s) => s.text)).toEqual([paymentSentence.text, "The buyer paid $95.00 on 2026-10-20."]);
  });

  it("uses the seller's shipping record when PayPal holds no tracker", async () => {
    const r = await runAgent(
      "PP-R-1",
      deps({
        getOrder: async () => order([]),
        shipment: async () => ({
          custom_id: "dd-0001",
          order_id: "ORD1",
          capture_id: "CAP1",
          carrier: "UPS",
          tracking_number: "1Z9",
          delivered_at: "2026-10-20T12:00:00Z",
        }),
      }),
    );
    expect(r.decision.verdict).toBe("FIGHT");
    expect(r.records.find((x) => x.kind === "tracking")?.id).toBe("ship-dd-0001");
    expect(r.sentences.some((s) => s.record_id === "ship-dd-0001")).toBe(true);
  });

  it("tells the writer how to cite its shipping record and rejects a claim that the buyer did not pay", async () => {
    const prompts: string[] = [];
    const r = await runAgent(
      "PP-R-1",
      deps({
        getOrder: async () => order([]),
        shipment: async () => ({
          custom_id: "dd-0001",
          order_id: "ORD1",
          capture_id: "CAP1",
          carrier: "UPS",
          tracking_number: "1Z9",
          delivered_at: "2026-10-20T12:00:00Z",
        }),
        model: async (messages) => {
          prompts.push(messages[0].content);
          return {
            text:
              prompts.length === 1
                ? '{"tools": ["get_order", "get_tracking"]}'
                : '{"sentences": [{"text": "Our shipping record shows UPS number 1Z9 delivered on 2026-10-20.", "record_id": "ship-dd-0001"}]}',
          };
        },
      }),
    );
    expect(prompts[1]).toContain("Pick 2 to 4 listed fact ids");
    expect(prompts[1]).toContain("Code writes every line");
    expect(r.sentences).toEqual([
      trackingSentences("ship-dd-0001", true)[1],
      paymentSentence,
      trackingSentences("ship-dd-0001", true)[0],
      orderSentence,
    ]);
    expect(r.dropped).toEqual([
      { text: "Our shipping record shows UPS number 1Z9 delivered on 2026-10-20.", record_id: "ship-dd-0001" },
    ]);
    expect(r.writer).toBe("template");
  });

  it("rejects legacy sentence objects even when the old parser can recover them", async () => {
    const broken =
      'Here is the response: {"sentences": [{"text": "The buyer paid $48.00 on 2026-10-20.", "record_id": "CAP1"}, ' +
      '{"text": "UPS shows the parcel delivered.", "record_id": "CAP1-1Z9"},] } Note: all facts are from records.';
    const m = model('{"tools": ["get_order", "get_tracking"]}', broken);
    const r = await runAgent("PP-R-1", deps({ model: m }));
    expect(r.writer).toBe("template");
    expect(r.sentences).toEqual(fightTemplate);
    expect(r.dropped).toEqual([paymentSentence, { text: "UPS shows the parcel delivered.", record_id: "CAP1-1Z9" }]);
    expect(r.rawWriter).toContain("Here is the response");
  });

  it("rejects legacy sentence strings with bracketed ids and uses code facts", async () => {
    const m = model(
      '{"tools": ["get_order", "get_tracking"]}',
      '{"sentences": ["The buyer paid $48.00 on 2026-10-20 [CAP1].", "UPS shows the parcel delivered [CAP1-1Z9]."]}',
    );
    const r = await runAgent("PP-R-1", deps({ model: m }));
    expect(r.decision.verdict).toBe("FIGHT");
    expect(r.sentences).toEqual(fightTemplate);
    expect(r.dropped).toEqual([paymentSentence, { text: "UPS shows the parcel delivered.", record_id: "CAP1-1Z9" }]);
  });

  it("removes punctuation left before a bracketed record id", () => {
    expect(normalizeSentences(["The payment was $6.50, [66F98060FT886244H]."], new Set(["66F98060FT886244H"]))).toEqual(
      [{ text: "The payment was $6.50.", record_id: "66F98060FT886244H" }],
    );
  });

  it("removes punctuation left before an inline record id", () => {
    expect(normalizeSentences(["The payment was $6.50, 66F98060FT886244H."], new Set(["66F98060FT886244H"]))).toEqual([
      { text: "The payment was $6.50.", record_id: "66F98060FT886244H" },
    ]);
  });

  it("strikes raw uppercase underscore codes while template sentences use readable words", async () => {
    const raw = "The reason for the dispute is MERCHANDISE_OR_SERVICE_NOT_RECEIVED, [PP-R-QPA-10196472].";
    const r = await runAgent(
      "PP-R-1",
      deps({
        model: model('{"tools": ["get_order", "get_tracking"]}', JSON.stringify({ sentences: [raw] })),
      }),
    );
    expect(r.sentences.every((sentence) => !/\b[A-Z]+(?:_[A-Z]+)+\b/.test(sentence.text))).toBe(true);
    expect(r.dropped).toContainEqual({
      text: "The reason for the dispute is MERCHANDISE_OR_SERVICE_NOT_RECEIVED.",
      record_id: "PP-R-QPA-10196472",
    });
    const fallback = await runAgent("PP-R-1", deps());
    expect(fallback.writer).toBe("template");
    expect(fallback.sentences.every((sentence) => !/\b[A-Z]+(?:_[A-Z]+)+\b/.test(sentence.text))).toBe(true);
  });

  it("normalizes a held shipping id written inline and removes its label", async () => {
    const text =
      "Our shipping record shows the package was delivered on 2026-11-05 at 00:51 UTC with UPS number 1Z999AA193839892, record id ship-dd-p067.";
    const r = await runAgent(
      "PP-R-1",
      deps({
        model: model('{"tools": ["get_order", "get_tracking"]}', JSON.stringify({ sentences: [text] })),
        getDispute: async () =>
          dispute({ disputed_transactions: [{ seller_transaction_id: "CAP1", custom: "dd-p067" }] }),
        getOrder: async () => order([]),
        shipment: async () => ({
          custom_id: "dd-p067",
          order_id: "ORD1",
          capture_id: "CAP1",
          carrier: "UPS",
          tracking_number: "1Z999AA193839892",
          delivered_at: "2026-11-05T00:51:00Z",
        }),
      }),
    );
    expect(r.writer).toBe("template");
    expect(r.dropped).toEqual([
      {
        text: "Our shipping record shows the package was delivered on 2026-11-05 at 00:51 UTC with UPS number 1Z999AA193839892.",
        record_id: "ship-dd-p067",
      },
    ]);
    expect(r.sentences).toEqual([
      paymentSentence,
      ...trackingSentences("ship-dd-p067", true, "2026-11-05 00:51", "1Z999AA193839892"),
    ]);
    expect(r.sentences[0].text).not.toContain("record id");
  });

  it("replaces a legacy payment string with the code payment and strikes false delivery", async () => {
    const r = await runAgent(
      "PP-R-2",
      deps({
        model: model(
          '{"tools": ["get_order"]}',
          JSON.stringify({
            sentences: [
              "The payment for the Glaze recipe PDF was $6.00, as recorded in Payment 64M148429R6599218.",
              "Our shipping record shows that no delivery was made, as recorded in Order 5FD84138SS177091H.",
            ],
          }),
        ),
        getDispute: async () =>
          dispute({
            dispute_id: "PP-R-2",
            dispute_amount: { currency_code: "USD", value: "6.00" },
            disputed_transactions: [{ seller_transaction_id: "64M148429R6599218" }],
          }),
        getCapture: async () =>
          capture({
            id: "64M148429R6599218",
            amount: { currency_code: "USD", value: "6.00" },
            supplementary_data: { related_ids: { order_id: "5FD84138SS177091H" } },
          }),
        getOrder: async () =>
          order([]) && {
            ...order([]),
            id: "5FD84138SS177091H",
            purchase_units: [{ description: "Glaze recipe PDF", shipping: { trackers: [] } }],
          },
      }),
    );
    expect(r.writer).toBe("template");
    expect(r.sentences).toEqual([
      { text: "The buyer paid $6.00 on 2026-10-20.", record_id: "64M148429R6599218" },
      { text: "We accept the claim and refund in full.", record_id: "PP-R-2" },
    ]);
    expect(r.dropped).toContainEqual({
      text: "Our shipping record shows that no delivery was made.",
      record_id: "5FD84138SS177091H",
    });
  });

  it.each(["object", "string"])(
    "cleans source labels and strikes false shipping attribution in %s form",
    async (form) => {
      const r = await runAgent(
        "PP-R-2",
        deps({
          model: model(
            '{"tools": ["get_order"]}',
            JSON.stringify({
              sentences: [
                { text: "The total amount paid was $7.50, as shown in Payment.", record_id: "64M148429R6599218" },
                {
                  text: "Our shipping record shows that no shipping address was provided for the order, as stated in Order.",
                  record_id: "5FD84138SS177091H",
                },
              ].map((sentence) =>
                form === "object" ? sentence : `${sentence.text.slice(0, -1)} [${sentence.record_id}].`,
              ),
            }),
          ),
          getDispute: async () =>
            dispute({
              dispute_id: "PP-R-2",
              dispute_amount: { currency_code: "USD", value: "7.50" },
              disputed_transactions: [{ seller_transaction_id: "64M148429R6599218" }],
            }),
          getCapture: async () =>
            capture({
              id: "64M148429R6599218",
              amount: { currency_code: "USD", value: "7.50" },
              supplementary_data: { related_ids: { order_id: "5FD84138SS177091H" } },
            }),
          getOrder: async () =>
            order([]) && {
              ...order([]),
              id: "5FD84138SS177091H",
              purchase_units: [{ description: "Glaze recipe PDF", shipping: { trackers: [] } }],
            },
        }),
      );
      expect(r.writer).toBe("template");
      expect(r.sentences).toEqual([
        { text: "The buyer paid $7.50 on 2026-10-20.", record_id: "64M148429R6599218" },
        { text: "We accept the claim and refund in full.", record_id: "PP-R-2" },
      ]);
      expect(r.dropped).toContainEqual({
        text: "Our shipping record shows that no shipping address was provided for the order.",
        record_id: "5FD84138SS177091H",
      });
    },
  );

  it.each(["Our shipping record", "The seller's shipping record", "Our own shipping record"])(
    "strikes %s when it cites an order",
    async (subject) => {
      const r = await runAgent(
        "PP-R-1",
        deps({
          model: model(
            '{"tools": ["get_order"]}',
            JSON.stringify({
              sentences: [
                { text: "The buyer paid $48.00.", record_id: "CAP1" },
                { text: `${subject} shows that no shipping address was provided for the order.`, record_id: "ORD1" },
              ],
            }),
          ),
          getOrder: async () => order([]),
        }),
      );
      expect(r.writer).toBe("template");
      expect(r.sentences).toEqual([paymentSentence]);
      expect(r.dropped).toEqual([
        { text: "The buyer paid $48.00.", record_id: "CAP1" },
        {
          text: `${subject} shows that no shipping address was provided for the order.`,
          record_id: "ORD1",
        },
      ]);
    },
  );

  it("cleans a shipping citation then replaces model delivery with code facts", async () => {
    const r = await runAgent(
      "PP-R-1",
      deps({
        model: model(
          '{"tools": ["get_order", "get_tracking"]}',
          JSON.stringify({
            sentences: [
              {
                text: "Our shipping record shows the package was delivered, as noted in Shipping ship-dd-p067.",
                record_id: "ship-dd-p067",
              },
            ],
          }),
        ),
        getDispute: async () =>
          dispute({ disputed_transactions: [{ seller_transaction_id: "CAP1", custom: "dd-p067" }] }),
        getOrder: async () => order([]),
        shipment: async () => ({
          custom_id: "dd-p067",
          order_id: "ORD1",
          capture_id: "CAP1",
          carrier: "UPS",
          tracking_number: "1Z9",
          delivered_at: "2026-11-05T00:51:00Z",
        }),
      }),
    );
    expect(r.writer).toBe("template");
    expect(r.sentences).toEqual([paymentSentence, ...trackingSentences("ship-dd-p067", true, "2026-11-05 00:51")]);
    expect(r.dropped).toEqual([
      {
        text: "Our shipping record shows the package was delivered.",
        record_id: "ship-dd-p067",
      },
    ]);
  });

  it.each(["as shown in", "as stated in", "as recorded in", "as seen in", "as noted in", "according to", "per"])(
    "cuts only a complete source label introduced by %s",
    (phrase) => {
      const heldIds = new Set(["CAP1", "ship-dd-p067", "CAP.2"]);
      for (const source of [
        "Payment",
        "Order",
        "Shipping",
        "Dispute",
        "Capture",
        "Tracking",
        "the record",
        "Payment CAP1",
        "Order OTHER1",
        "CAP1",
        "CAP.2",
      ]) {
        const sentence = { text: `The buyer paid $48.00, ${phrase} ${source}!?`, record_id: "CAP1" };
        expect(normalizeSentences([sentence], heldIds)).toEqual([{ ...sentence, text: "The buyer paid $48.00." }]);
        expect(normalizeSentences([`${sentence.text} [CAP1]`], heldIds)).toEqual([
          { ...sentence, text: "The buyer paid $48.00." },
        ]);
      }
      expect(normalizeSentences([`The buyer paid $48.00, ${phrase} CAP1!`], heldIds)).toEqual([
        { text: "The buyer paid $48.00.", record_id: "CAP1" },
      ]);
    },
  );

  it.each([
    "We refund in full.",
    "Was it paid?",
    "It was paid!",
    "It was paid",
    "  It was paid?!  ",
    "It was paid, according to policy.",
    "It was paid, per UNKNOWN1.",
    "It was paid, as shown in Payment records today.",
    "It was paid, per CAPx2.",
  ])("preserves text without a source label: %s", (text) => {
    const sentence = { text, record_id: "CAP1" };
    expect(normalizeSentences([sentence], new Set(["CAP1", "CAP.2"]))).toEqual([sentence]);
  });

  it("leaves strings without one held id unreadable", async () => {
    const r = await runAgent(
      "PP-R-1",
      deps({
        model: model('{"tools": ["get_order", "get_tracking"]}', '{"sentences": ["A sentence with no held id."]}'),
      }),
    );
    expect(r.writer).toBe("template");
  });

  it("a reply with no readable sentence keeps the verdict and uses the template", async () => {
    const m = model('{"tools": ["get_order", "get_tracking"]}', '{"sentences": ["no id here", 42]}');
    const r = await runAgent("PP-R-1", deps({ model: m }));
    expect(r.decision.verdict).toBe("FIGHT");
    expect(r.writer).toBe("template");
  });

  it("reads Reply A's complete strings without closing brackets and with ids inside sentences", () => {
    const strings = sentenceStrings(replyA);
    expect(strings).toHaveLength(3);
    expect(normalizeSentences(strings!)).toEqual([
      {
        text: "The payment was made on 2026-11-03 for $10.00, as shown in the payment record.",
        record_id: "06T4262533119530V",
      },
      {
        text: "The shipping record shows that the package was delivered on 2026-11-03 00:48 UTC with UPS number 1Z999AA193666881, which is marked as DELIVERED.",
        record_id: "ship-dd-p060",
      },
      {
        text: "The order was shipped to Toronto, ON, CA, and the delivery was confirmed by UPS on the same day, 2026-11-03.",
        record_id: "4RR35355RL5596630",
      },
    ]);
  });

  it("reads Reply B's complete strings and removes the trailing record label", () => {
    const strings = sentenceStrings(replyB);
    expect(strings).toHaveLength(4);
    expect(normalizeSentences(strings!)).toEqual([
      {
        text: "The order was shipped with UPS number 1Z999AA193666576, which is recorded as DELIVERED on 2026-11-03 00:42 UTC.",
        record_id: "ship-dd-p059",
      },
      { text: "The payment for the order was made on 2026-11-03.", record_id: "5WC72421N7153143J" },
      { text: "The total amount of the order is $7.25.", record_id: "PP-R-DQF-10196051" },
      { text: "The order was shipped to San Jose, CA, US.", record_id: "2YW93255P1961943M" },
    ]);
  });

  it("removes a trailing comma-prefixed record label in any case", () => {
    expect(normalizeSentences(["Paid on 2026-11-03, id: [CAP1]."])).toEqual([
      { text: "Paid on 2026-11-03.", record_id: "CAP1" },
    ]);
  });

  it("leaves out a string cut off before its closing quote", () => {
    expect(sentenceStrings('{"sentences": ["One [a].", "Two [b')).toEqual(["One [a]."]);
  });

  it("decodes JSON string escapes and returns undefined without complete sentence strings", () => {
    const sentence = 'UPS says "delivered" at C:\\desk [a].';
    expect(sentenceStrings(`{"sentences": [${JSON.stringify(sentence)}, "unfinished`)).toEqual([sentence]);
    expect(sentenceStrings('{"sentences": ["unfinished')).toBeUndefined();
    expect(sentenceStrings('{"other": ["One [a]."]}')).toBeUndefined();
    expect(sentenceStrings('{"sentences": []}')).toBeUndefined();
  });

  it("keeps multiple citations unreadable and cleans spacing around a single citation", () => {
    const multiple = "Records [a] and [b] show delivery.";
    expect(normalizeSentences([multiple, "UPS [a] , delivered", "Delivered [a]!", "Delivered [a]?"])).toEqual([
      multiple,
      { text: "UPS, delivered.", record_id: "a" },
      { text: "Delivered!", record_id: "a" },
      { text: "Delivered?", record_id: "a" },
    ]);
  });

  it("rejects a truncated legacy Reply B and renders only code facts", async () => {
    const written = replyB
      .replaceAll("1Z999AA193666576", "1Z9")
      .replaceAll("2026-11-03", "2026-10-20")
      .replaceAll("00:42", "12:00")
      .replaceAll("ship-dd-p059", "CAP1-1Z9")
      .replaceAll("5WC72421N7153143J", "CAP1")
      .replaceAll("$7.25", "$48.00")
      .replaceAll("PP-R-DQF-10196051", "PP-R-1")
      .replaceAll("San Jose, CA, US", "Toronto, ON, CA")
      .replaceAll("2YW93255P1961943M", "ORD1");
    const r = await runAgent("PP-R-1", deps({ model: model('{"tools": ["get_order", "get_tracking"]}', written) }));
    expect(r.writer).toBe("template");
    expect(r.sentences).toEqual(fightTemplate);
    expect(dropUnsupportedNumbers(r.sentences, r.records).bad).toEqual([]);
    expect(r.dropped).toEqual(
      expect.arrayContaining([
        { text: "The payment for the order was made on 2026-10-20.", record_id: "CAP1" },
        {
          text: "The order was shipped with UPS number 1Z9, which is recorded as DELIVERED on 2026-10-20 12:00 UTC.",
          record_id: "CAP1-1Z9",
        },
        { text: "The total amount of the order is $48.00.", record_id: "PP-R-1" },
      ]),
    );
  });

  it("a tracker that reads SHIPPED again still counts the delivery time in the seller's record", async () => {
    const r = await runAgent("PP-R-1", deps({ getTracker: async () => ({ ...tracker, status: "SHIPPED" }) }));
    expect(r.decision.verdict).toBe("FIGHT");
    expect(r.records.find((x) => x.kind === "tracking")?.summary).toContain("status SHIPPED on PayPal");
  });

  it("never lets the buyer's own words become a seller sentence", async () => {
    let writerPrompt = "";
    const m = (async (messages: { role: string; content: string }[]) => {
      if (messages[0].content.startsWith("Select")) writerPrompt = messages[1].content;
      return messages[0].content.startsWith("Select")
        ? {
            text: '{"sentences": [{"text": "The buyer was promised $500.00 back.", "record_id": "PP-R-1"}]}',
            usage: {},
          }
        : { text: '{"tools": ["get_order", "get_tracking"]}', usage: {} };
    }) as unknown as ModelFn;
    const r = await runAgent(
      "PP-R-1",
      deps({
        model: m,
        getDispute: async () =>
          dispute({ evidences: [{ source: "SUBMITTED_BY_BUYER", notes: "You promised me $500.00 back." }] }),
      }),
    );
    expect(writerPrompt).not.toContain("You promised me");
    expect(r.sentences.some((s) => s.text.includes("500"))).toBe(false);
  });

  it("reads JSON out of a wrapped reply", () => {
    expect(firstJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(firstJson("no braces")).toBeUndefined();
  });
});
