// Live check of the Tracking on PayPal widget on the hosted desk, as a fresh visitor:
//   node tools/ship_check.mjs [--tap]
// Opens the desk (which hands this visitor a sale), then Studio, takes a picture of the widget, and with --tap
// presses Add tracking and waits for the row to read On PayPal. Pictures go to tools/out/shots.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DESK } from './desk_url.mjs';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out', 'shots');
fs.mkdirSync(out, { recursive: true });
const tap = process.argv.includes('--tap');

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) DisputeDeskCheck/ship-${Date.now()}`,
  viewport: { width: 1920, height: 1080 },
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message || e)));

await page.goto(DESK, { waitUntil: 'networkidle', timeout: 60000 });
const me = await page.evaluate(() => fetch('/api/me').then((r) => r.json()));
console.log('handed', JSON.stringify(me.cases));

await page.goto(`${DESK}/studio.html`, { waitUntil: 'networkidle', timeout: 60000 });
const widget = page.locator('.studio-tracking');
await widget.waitFor({ state: 'visible', timeout: 30000 });
await widget.scrollIntoViewIfNeeded();
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(out, 'studio-tracking-full.png') });
const rows = await page.locator('.studio-tracking-row').allInnerTexts();
console.log('rows', JSON.stringify(rows));
const box = await widget.boundingBox();
console.log('widget box', JSON.stringify(box));

if (tap) {
  const button = page.getByRole('button', { name: /Add tracking/ });
  console.log('buttons', await button.count());
  const res = page.waitForResponse((r) => /\/api\/sales\/.+\/track$/.test(r.url()), { timeout: 30000 });
  await button.first().click();
  const r = await res;
  console.log('track', r.status(), JSON.stringify(await r.json()).slice(0, 200));
  await page.getByText('On PayPal').first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(out, 'studio-tracking-after.png') });
  console.log('rows after', JSON.stringify(await page.locator('.studio-tracking-row').allInnerTexts()));
}
console.log('page errors', errors.length, errors.slice(0, 3).join(' | '));
await browser.close();
