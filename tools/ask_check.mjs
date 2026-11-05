// Checks the desk's first load and the Ask card, headless: the AG Charts file must not load with the page, and must
// load and draw a chart once a question is answered.
//   node tools/ask_check.mjs [url]
// Writes tools/out/shots/ask-check.png. Exits 0 only when every check passes.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { DESK } from "./desk_url.mjs";

const url = process.argv[2] || DESK + "/";
const OUT = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "out", "shots");
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const loaded = [];
page.on("response", (r) => loaded.push(r.url()));
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

let failed = 0;
const check = (ok, what) => {
  console.log(ok ? "ok  " : "FAIL", what);
  if (!ok) failed++;
};

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(1000);
check(!loaded.some((u) => /ag-charts/.test(u)), "AG Charts not loaded with the page");
check(loaded.some((u) => /ag-grid/.test(u)), "AG Grid loaded with the page");
check((await page.locator("dl.tiles dt").count()) === 4, "four tile terms");
check((await page.locator("ul.feed-rows[aria-live=polite]").count()) === 1, "feed is a live list");

await page.getByLabel("Ask about your disputes").fill("amount on hold by status");
await page.getByRole("button", { name: "Ask", exact: true }).click();
await page.locator(".ask-chart canvas").first().waitFor({ timeout: 20000 }).catch(() => {});
check(loaded.some((u) => /ag-charts/.test(u)), "AG Charts loaded after the question");
check((await page.locator(".ask-chart canvas").count()) > 0, "chart drawn");
await page.screenshot({ path: path.join(OUT, "ask-check.png"), fullPage: true });

check(errors.length === 0, `no page errors${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
await browser.close();
process.exit(failed ? 1 : 0);
