# Dispute Desk

Answer a PayPal dispute with your own records, in one tap.

A small seller gets a PayPal dispute: the money goes on hold and a deadline starts. Dispute Desk sees the dispute
when PayPal's webhook lands, reads the payment, fetches the order and tracking it needs, decides to fight, accept or offer half,
and drafts the reply with a record id behind every sentence. Nothing is filed until the seller taps Approve.

Try it: https://dispute-desk.midknight-labs.workers.dev (the dashboard view is at `/studio`, the measured proof at
`/proof`). Everything runs on the PayPal sandbox. Built for the PayPal AI Hackathon.

## Judge in 60 seconds

Open https://dispute-desk.midknight-labs.workers.dev. No login: you are handed live sandbox disputes of your own,
marked Yours.

1. Tap your fight case, then Analyse. Each sentence of the draft shows the PayPal record behind it. Tap Approve: it is
   filed with PayPal, with the tracking and the evidence pack.
2. Open `/studio`. Under Tracking on PayPal, tap Add tracking on your late sale: the tracking goes onto PayPal before
   any dispute.
3. Open `/proof`: the rules run on labelled cases, with no model call.

All of it was built from 22 Oct 2026 (the first commit of this repo).

## How a dispute is answered

1. PayPal's webhook arrives. The desk checks its signature on the raw body before it stores anything, and stores each
   event once.
2. Analyse: the desk reads the dispute and the payment, the model picks whether the order and the tracking are
   needed for the buyer's reason, and the desk fetches them from PayPal.
3. Code decides the verdict (`src/rules.ts`), not the model. Not received, and delivered before the claim: fight.
   No delivery record and under $10.00: accept and refund. Anything else: offer half.
4. The model writes the sentences. A sentence that names a record the desk did not fetch is dropped, and so is one
   with a number that is not in its record (`src/agent.ts`). If none is left, fixed wording is written from the records.
5. Approve: the desk files with PayPal by the actions the case allows at that moment: evidence with the tracking and
   the evidence pack, accept the claim with a refund, or make an offer. PayPal's next webhooks move the case on the page.

## Before a dispute

The desk also watches each sale through PayPal's `PAYMENT.CAPTURE.COMPLETED` webhook. A sale the seller has shipped
but whose tracking is still not on PayPal two days later turns amber in the Studio view (Tracking on PayPal), and one
tap puts the seller's tracking on the PayPal order (`POST /v2/checkout/orders/{id}/track`, `src/ship.ts`). The proof
is then on PayPal's side before any buyer asks.

## The proof page

`/proof` runs 24 labelled cases through the verdict rule and shows 24 of 24 right, then runs altered sentences through
the checker (a wrong record id, a changed number, the buyer's own words as fact) and shows every one struck. A box lets
you type your own sentence and watch the checker keep or strike it. It is plain code: no model call, no cost.

Every analysed case also has an evidence pack: a PDF with each sentence numbered and tagged with its exhibit, one
section per record, and a check value on every page (`/api/disputes/{id}/pack.pdf`).

## What it is built with

| Part | Used for |
| --- | --- |
| PayPal Orders, Payments, Shipment tracking | The sale, the payment, and the tracking put on the order when the desk answers |
| PayPal Disputes | Reading the case and filing: `provide-evidence`, `accept-claim`, `make-offer` |
| PayPal Webhooks | Dispute and capture events, verified before anything is stored |
| Cloudflare Workers, D1 | The page, the API, disputes, events, the feed and the caps |
| Workers AI (`@cf/ibm-granite/granite-4.0-h-micro`) | Choosing records and writing sentences |
| AG Grid, AG Charts | The disputes grid, the evidence column, and charts asked for in words |
| AG Studio 3.0 | The `/studio` dashboard: KPIs, the grid, charts, custom widgets (evidence readiness, a deadline ring, tracking on PayPal, and a checked draft) and its AI Assistant panel |

The AI Assistant panel in AG Studio runs one agent of ours: it sends the question to `/api/ask`, gets a checked
chart spec back, and adds the chart with one tool, `add_dispute_chart`. Until a licence key is added, Studio shows its
trial watermark.

## For judges

Each visitor gets their own real sandbox disputes, one to fight and one to accept, opened beforehand by sandbox buyers
(`tools/pool.py`). A visitor can file only on the cases handed to them. When the pool runs out, the desk shows a recorded run and says
so. If a webhook is lost, the next load of the list (at most every 15 minutes) syncs with PayPal (`src/sync.ts`).

## What it costs

Nothing. One analysis uses at most 3 model calls: a tool choice, a fact pick, and one retry of the pick. Before the calls, the desk reserves the worst case, 15.68 neurons at Cloudflare's published rates for `@cf/ibm-granite/granite-4.0-h-micro` (1,542 neurons per million input tokens, 10,158 per million output tokens), then keeps only what was really used. The caps in `src/caps.ts` are 20 runs per visitor a day, 100 runs a day, 700 neurons a day for this
app (7 percent of the free 10,000), and a stop at 9,000 for the whole account. Past a cap, fixed wording is written
from the same records and the page says so. The account is on the Free plan, which has no paid overage.

## Run it yourself

You need Node 20 or later, Python 3.10 or later, a Cloudflare account and a PayPal sandbox app.

```bash
npm install
npm test
npm run web:build
npx wrangler dev
```

Put your sandbox keys in `.dev.vars` (git ignores it). Add `SESSION_SECRET`, a random secret used to sign visitor cookies, as a Worker secret too. Without it every request starts a new session:

```
PAYPAL_CLIENT_ID=...
PAYPAL_CLIENT_SECRET=...
PAYPAL_WEBHOOK_ID=...
SESSION_SECRET=...
```

For a local run, apply every desk migration in name order. This loop also picks up new migration files:

```bash
for file in migrations/*.sql; do
  npx wrangler d1 execute dispute-desk --local --file="$file"
done
```

`wrangler dev` uses a local `DB`. Its `LEDGER` binding is remote on purpose, so a dev run spends the shared real neuron balance. The ledger migration below is only for a fully local test: make a local copy of `wrangler.jsonc`, remove `"remote": true` from `LEDGER` in that copy, then run:

```bash
npx wrangler d1 execute hackathon-ledger --local --file=migrations-ledger/0001_ai_calls.sql
```

To create the first cases, run `python tools/pool.py --fight 2 --accept 2 --ship 2`. It creates sandbox sales and disputes with the sandbox buyer accounts. It needs the Cloudflare account token file used by the script, PayPal sandbox credentials, and the browser tools and buyer accounts set up by `tools/day_one.py`.

After a deploy, `npm run smoke` checks the live desk with no browser and no model call: the pages, the security
headers, the caps, the judge pool, and that a forged webhook and an approve without the owner key are refused.

The sales routes list shipped sales that have no dispute:

| Route | Result |
| --- | --- |
| GET /api/sales | Sales with shipping records, tracking state, time left and visitor ownership |
| POST /api/sales/{capture_id}/track | Put tracking on PayPal for a sale handed to this visitor or the owner |

## Receipts

Every PayPal call this app depends on, run against the sandbox, with the HTTP code PayPal gave. Run by
`tools/day_one.py`, `tools/buyer.mjs` and the deployed Worker. Ids are sandbox ids.

| Date | Check | Call | HTTP | Result |
| --- | --- | --- | --- | --- |
| 2026-10-28 | Ship | POST /v2/checkout/orders/{id}/track on a sale with no dispute | 201 | tracker added, status SHIPPED |
| 2026-10-22 | 1 Token | POST /v1/oauth2/token | 200 | expires_in 32,214 s |
| 2026-10-22 | 2 Order | POST /v2/checkout/orders ($48.00, custom_id dd-0001) | 200 | status PAYER_ACTION_REQUIRED |
| 2026-10-22 | 2 Approve | the sandbox buyer approves in a headless browser | | order status APPROVED |
| 2026-10-22 | 2 Capture | POST /v2/checkout/orders/{id}/capture | 201 | capture COMPLETED |
| 2026-10-22 | 3 Tracking | POST /v2/shipping/trackers | 404 | no such route |
| 2026-10-22 | 3 Tracking | POST /v2/checkout/orders/{id}/track | 201 | tracker added, status SHIPPED |
| 2026-10-22 | 3 Delivered | PUT /v1/shipping/trackers/{id} with status DELIVERED | 204 | GET reads DELIVERED |
| 2026-10-22 | 4 Dispute | buyer opens Item Not Received in the sandbox resolution centre | | |
| 2026-10-22 | 4 Delay | GET /v1/customer/disputes, polled | 200 | seen 220 s after filing ($48.00), 217 s (second $48.00) |
| 2026-10-22 | 4 Stage | GET /v1/customer/disputes/{id} | 200 | $48.00: UNDER_REVIEW, CHARGEBACK. $6.00: WAITING_FOR_SELLER_RESPONSE, INQUIRY |
| 2026-10-22 | 4 Create by API | POST /v1/customer/disputes (sandbox only) with PayPal-Auth-Assertion | 400 | invalid_request: "No permissions to set target_client_id" |
| 2026-10-22 | 5 Webhook | POST /v1/notifications/webhooks (5 event types) | 201 | CUSTOMER.DISPUTE.UPDATED accepted |
| 2026-10-22 | 5 Delivery | CUSTOMER.DISPUTE.CREATED, UPDATED, RESOLVED, PAYMENT.CAPTURE.COMPLETED, REFUNDED | | verified SUCCESS, stored once each |
| 2026-10-22 | 5 Forged | POST /webhooks/paypal with a made up signature | 400 | not stored |
| 2026-10-22 | 5 Duplicate | POST /v1/notifications/webhooks-events/{id}/resend | 202 | delivered again (Worker 200), stored once |
| 2026-10-22 | 6 Evidence | POST .../provide-evidence on the CHARGEBACK stage dispute | 422 | ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE |
| 2026-10-22 | 6 Require evidence | POST .../require-evidence SELLER_EVIDENCE (sandbox only) | 400 | ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE |
| 2026-10-22 | 6 Supporting info | POST .../provide-supporting-info (multipart) | 200 | CUSTOMER.DISPUTE.UPDATED followed |
| 2026-10-22 | 7 Adjudicate | POST .../adjudicate SELLER_FAVOR on the CHARGEBACK stage dispute | 400 | ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE |
| 2026-10-22 | 8 Accept | POST .../accept-claim ($6.00, accept_claim_type REFUND) | 200 | capture REFUNDED; RESOLVED_BUYER_FAVOUR, SELLER_ISSUED_REFUND, about 2 min later |
| 2026-10-23 | Agent | POST /api/disputes/{id}/analyse on the $48.00 dispute | 200 | verdict FIGHT, 3 sentences kept, 0 dropped |
| 2026-10-23 | Neurons | one analysis: 2 model calls, 512 input and 132 output tokens | | 6.4 neurons (512 x 4,625 / 1M + 132 x 30,475 / 1M) |
| 2026-10-23 | Stage | a sale with no tracker on PayPal before the dispute ($8.50) | 200 | INQUIRY, WAITING_FOR_SELLER_RESPONSE, PROOF_OF_FULFILLMENT requested |
| 2026-10-23 | 6 Evidence | POST .../provide-evidence on the INQUIRY dispute, tracking as PROOF_OF_FULFILLMENT | 200 | UNDER_REVIEW, then WAITING_FOR_BUYER_RESPONSE |
| 2026-10-23 | 7 Escalate | POST .../escalate by the seller, then provide-evidence in the claim stage | 200, 200 | UNDER_REVIEW, CHARGEBACK; no adjudicate link offered |
| 2026-10-23 | Judge loop | the hosted page in a headless browser: the pooled fight case, Analyse, Approve | | Filed by provide-evidence; WAITING_FOR_BUYER_RESPONSE |
| 2026-10-23 | Judge loop | the pooled $6.00 accept case, Analyse, Approve | | Filed by accept-claim |
| 2026-10-23 | Guard | POST /api/disputes/{id}/approve from a visitor the case was not handed to | 403 | not filed |
| 2026-10-23 | Tracker | PUT /v1/shipping/trackers/{id} DELIVERED, then provide-evidence with the tracking | 204, 200 | GET on the tracker later read SHIPPED again; the desk keeps the delivery time in its own shipping record |
| 2026-10-23 | 7 Watch | GET /v1/customer/disputes/{id} every 2 minutes for 2 hours on 7 disputes | 200 | 31 link changes, no adjudicate link ever; claim stage cases gained only accept_claim, about 20 minutes after filing |
| 2026-10-23 | Sync | GET /api/disputes starts the timed sync at most every 15 minutes | 200 | the desk went from 18 to 22 disputes, picking up the ones whose webhook had not arrived |
| 2026-10-23 | Offer | POST .../make-offer on an $8.00 case with weak evidence (shipped, no delivery time) | 200 | offered 4.00 |
| 2026-10-23 | Full loop | tools/e2e_loop.py: analyse, approve (accept-claim), poll PayPal | 200, 200 | RESOLVED_BUYER_FAVOUR at 124.7 s; making the case took 551 s more |
| 2026-10-23 | Buyers | sandbox buyers 1, 2 and 3 approve orders and open disputes in a headless browser | | each one's dispute joined the judge pool |
| 2026-10-23 | Studio | the AI Assistant panel on /studio: "Money on hold by stage" | | our runner called add_dispute_chart; a new chart widget on the page |
| 2026-10-23 | Headers | GET / on the hosted page | 200 | content-security-policy, x-content-type-options nosniff, x-frame-options DENY |
| 2026-10-23 | Usage | GET /api/usage | 200 | 27 runs today, 122.78 of this app's 700 neurons |
| 2026-10-23 | Ask | tools/ask_check.mjs: "amount on hold by status" on the desk | 200 | the chart file loads only after the question; chart drawn, no page errors |
| 2026-10-23 | Move | the workers.dev subdomain renamed; POST /v1/notifications/webhooks for the new address, DELETE the old one | 201, 204 | new webhook 72232045JR550043U; the Worker's PAYPAL_WEBHOOK_ID set to it |
| 2026-10-23 | Chargeback | a card sale, then POST /v2/customer-support/process-chargeback (sandbox only) | 201, 201 | a dispute at once; WAITING_FOR_SELLER_RESPONSE with accept_claim and provide_evidence about 3 minutes later; its webhooks arrived |
| 2026-10-23 | Adjudicate | POST .../adjudicate SELLER_FAVOR on a fought chargeback (offered after the evidence) | 200 | accepted; still UNDER_REVIEW 6 minutes later |
| 2026-10-23 | End to end | tools/e2e_full.py on the hosted desk: buyer pays, opens the dispute, the browser files, PayPal settles | 200 | RESOLVED_BUYER_FAVOUR 106 s after filing; capture REFUNDED |
| 2026-10-23 | Bad paths | approve again; a visitor who does not hold the case; a made up webhook; an unknown case; an offer PayPal does not take | 409, 403, 400, 404, 422 | nothing filed |
| 2026-10-23 | Webhook | provide-evidence on PP-R-VWC-10194182, then PayPal's event to the new address | 200 | CUSTOMER.DISPUTE.UPDATED 32 s later, signature verified, stored once |
| 2026-10-28 | Pack | POST /v1/customer/disputes/{id}/provide-evidence with the evidence pack PDF as a file | 200 | GET lists the document by name |

## Licence

MIT. See [LICENSE](LICENSE).
