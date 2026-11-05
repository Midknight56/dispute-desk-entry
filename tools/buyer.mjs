// The sandbox buyer's browser steps, headless (no window on any display).
//   node tools/buyer.mjs approve <custom>     approve the saved order as the sandbox buyer
//   node tools/buyer.mjs dispute <custom> [step ...]   walk the resolution centre form for that order, one step a click
// Reads the sandbox buyer's login from the secrets file in code. Never prints it. BUYER=2 or BUYER=3 in the environment
// picks the second or third sandbox buyer (PAYPAL_SANDBOX_BUYER2_EMAIL and so on).
// Takes a picture of each step into tools/out/shots/. Stops on any security challenge: those are for a person.
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const OUT = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "out");
const SHOTS = path.join(OUT, "shots");
fs.mkdirSync(SHOTS, { recursive: true });

function secrets() {
  const dir = process.env.MIDKNIGHT_SECRETS || path.join(os.homedir(), ".cloudflare");
  const kv = {};
  for (const line of fs.readFileSync(path.join(dir, "paypal-sandbox.local.txt"), "utf8").split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0 && !line.startsWith("#")) kv[line.slice(0, i)] = line.slice(i + 1);
  }
  return kv;
}

const state = JSON.parse(fs.readFileSync(path.join(OUT, "state.json"), "utf8"));
const [mode, custom = state.last, ...steps] = process.argv.slice(2);
const order = state.orders?.[custom];
if (!order) {
  console.log("no saved order for", custom);
  process.exit(2);
}

let step = 0;
async function shot(page, name) {
  step += 1;
  const file = path.join(SHOTS, `${mode}-${custom}-${String(step).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  console.log("  picture", path.basename(file));
}

async function challenged(page) {
  const t = (await page.content()).toLowerCase();
  return t.includes("captcha") && (t.includes("security challenge") || t.includes("i'm not a robot"));
}

const BUYER = process.env.BUYER && process.env.BUYER !== "1" ? `BUYER${process.env.BUYER}` : "BUYER";

async function login(page) {
  const kv = secrets();
  const email = page.locator("#email");
  if (await email.isVisible({ timeout: 15000 }).catch(() => false)) {
    await email.fill(kv[`PAYPAL_SANDBOX_${BUYER}_EMAIL`]);
    const next = page.locator("#btnNext");
    if (await next.isVisible().catch(() => false)) await next.click();
  }
  const pw = page.locator("#password");
  await pw.waitFor({ state: "visible", timeout: 20000 });
  await pw.fill(kv[`PAYPAL_SANDBOX_${BUYER}_PASSWORD`]);
  await page.locator("#btnLogin").click();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(4000);
  if (await challenged(page)) {
    await shot(page, "challenge");
    console.log("STOP: PayPal showed a security challenge. That is for a person to answer.");
    process.exit(3);
  }
}

async function approve(page) {
  await page.goto(order.approve, { waitUntil: "domcontentloaded" });
  await shot(page, "start");
  await login(page);
  await shot(page, "after-login");
  const pay = page.locator(
    '#payment-submit-btn, [data-testid="submit-button-initial"], button:has-text("Complete Purchase"), button:has-text("Pay Now"), button:has-text("Continue")',
  ).first();
  await pay.waitFor({ state: "visible", timeout: 30000 });
  await pay.click();
  // PayPal sends the buyer to the return URL once approved. That page does not matter (it may not even load);
  // leaving paypal.com is the sign. `python tools/day_one.py capture` then proves it with the order's status.
  await page.waitForURL((u) => !u.host.endsWith("paypal.com"), { timeout: 45000 }).catch(() => {});
  await shot(page, "done");
  const ok = !new URL(page.url()).host.endsWith("paypal.com");
  console.log(ok ? "approved: the buyer left PayPal for the return URL" : "not approved: still on PayPal");
  process.exit(ok ? 0 : 1);
}

async function visibleChoices(page) {
  return page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('button, a, label, [role="radio"], [role="button"], input, textarea, select')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const t = (el.innerText || el.getAttribute("aria-label") || el.getAttribute("name") || el.getAttribute("placeholder") || "").trim().replace(/\s+/g, " ");
      if (t) out.push(`${el.tagName.toLowerCase()}${el.type ? "[" + el.type + "]" : ""}: ${t.slice(0, 80)}`);
    }
    return [...new Set(out)];
  });
}

// One step of the walk: "text" clicks the first visible element with that text; "fill:<css>|<value>" types.
async function doStep(page, s) {
  if (s.startsWith("?")) {
    // optional: click only when it shows within 6 s (the form differs by item type)
    const rest = s.slice(1);
    const loc = rest.startsWith("css:")
      ? page.locator(rest.slice(4)).first()
      : rest.startsWith("btn:")
        ? page.locator("button[type=submit]", { hasText: rest.slice(4) }).first()
        : page.getByText(rest, { exact: false }).first();
    if (await loc.isVisible({ timeout: 6000 }).catch(() => false)) {
      await loc.click();
      await page.waitForTimeout(3500);
      // "Start over" resets a stale draft but leaves the page blank until it is loaded again
      if (rest === "Start over" && !(await page.getByText("received the item", { exact: false }).first().isVisible().catch(() => false))) {
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForTimeout(5000);
      }
    }
    return;
  }
  // Quote free steps: arguments pass through the browser lock's Windows command line, which drops inner quotes.
  if (s.startsWith("btn:")) {
    await page.locator("button[type=submit]", { hasText: s.slice(4) }).first().click();
    await page.waitForTimeout(3500);
    return;
  }
  if (s.startsWith("label:")) {
    await page.locator("label").filter({ hasText: new RegExp(`^${s.slice(6)}$`) }).first().click();
    await page.waitForTimeout(3500);
    return;
  }
  if (s.startsWith("row:")) {
    // row:<text>|<text>: the first button that holds both texts (a transaction row)
    const [a, b] = s.slice(4).split("|");
    // Draft cards ("steps completed") and the buyer's existing cases ("Open case", "Case closed", "Awaiting") hold
    // the same store and amount: skip them, take a row of the "Choose a transaction" list.
    const row = () =>
      page
        .locator("button")
        .filter({ hasText: a })
        .filter({ hasText: b })
        .filter({ hasNotText: /steps completed|open case|case closed|awaiting|refund|invoice/i })
        .first();
    // The short list shows three rows; other apps' payouts to the same sandbox buyer can push ours behind "View all".
    if (!(await row().isVisible({ timeout: 5000 }).catch(() => false))) {
      // the last "View all" belongs to the transaction list ("Your cases" has its own above it)
      await page.getByText("View all", { exact: false }).last().click({ timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(4000);
    }
    await row().click();
    await page.waitForTimeout(3500);
    return;
  }
  if (s.startsWith("fillname:")) {
    const [name, ...rest] = s.slice(9).split("|");
    await page.locator(`[name="${name}"]`).first().fill(rest.join("|"));
    await page.waitForTimeout(500);
    return;
  }
  if (s.startsWith("fill:")) {
    const [css, ...rest] = s.slice(5).split("|");
    await page.locator(css).first().fill(rest.join("|"));
  } else if (s.startsWith("css:")) {
    await page.locator(s.slice(4)).first().click();
  } else if (s.startsWith("goto:")) {
    await page.goto("https://www.sandbox.paypal.com" + s.slice(5), { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
  } else if (s.startsWith("select:")) {
    // select:<n>=<label>: the n-th visible list on the page, by its option's words
    const [n, ...rest] = s.slice(7).split("=");
    const label = rest.join("=");
    const box = page.locator("select").nth(Number(n));
    // A resumed draft may already hold the value, and PayPal then hides the list box behind its own button.
    const current = await box.evaluate((el) => el.options[el.selectedIndex]?.text ?? "").catch(() => "");
    if (current.trim() !== label) await box.selectOption({ label }, { force: true });
  } else {
    await page.getByText(s, { exact: false }).first().click();
  }
  await page.waitForTimeout(3500);
}

async function dispute(page, steps) {
  // The resolution centre lists the buyer's transactions; the order's payment is the one to report.
  await page.goto("https://www.sandbox.paypal.com/signin", { waitUntil: "domcontentloaded" });
  await login(page);
  await page.goto("https://www.sandbox.paypal.com/resolutioncenter", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);
  // decline the marketing cookies: the close button keeps only the needed ones
  await page.getByRole("button", { name: "Close", exact: true }).first().click({ timeout: 3000 }).catch(() => {});
  await shot(page, "resolution-centre");
  const value = Number(order.value).toFixed(2);
  const walk = steps[0]?.startsWith("goto:") ? steps : [`US$${value}`, ...steps];
  for (const s of walk) {
    await doStep(page, s);
    await shot(page, s.replace(/[^a-z0-9]+/gi, "_").slice(0, 30));
  }
  console.log("visible now:\n  " + (await visibleChoices(page)).join("\n  "));
  console.log("at", new URL(page.url()).pathname);
}

const browser = await chromium.launch({ headless: true });
// VIDEO=1 records the run at 1920 x 1080 into tools/out/video/ (the buyer's side for the film)
const context = await browser.newContext({
  viewport: process.env.VIDEO ? { width: 1920, height: 1080 } : { width: 1280, height: 900 },
  locale: "en-US",
  ...(process.env.VIDEO ? { recordVideo: { dir: path.join(OUT, "video"), size: { width: 1920, height: 1080 } } } : {}),
});
const page = await context.newPage();
try {
  if (mode === "approve") await approve(page);
  else if (mode === "dispute") await dispute(page, steps);
  else console.log("mode is approve or dispute");
} catch (e) {
  await shot(page, "error");
  console.log("error:", String(e.message || e).split("\n")[0]);
  process.exitCode = 1;
} finally {
  await context.close();
  if (process.env.VIDEO) console.log("video:", await page.video()?.path());
  await browser.close();
}
