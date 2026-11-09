// Screenshots of the case screen in four states at desktop and phone size, from the local preview
// (node tools/ui_states.mjs). Headless, no window. Writes tools/out/screens/*.png and a measures file.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8791';
const OUT = 'tools/out/screens';
const states = [
  ['fight-case', 'PP-D-SHOT-0001', '.case-action .approve'],
  ['refund-case', 'PP-D-SHOT-0002', '.case-action .approve'],
  ['review-case', 'PP-D-SHOT-0003', '.decision-card button.primary'],
  ['filing-pending', 'PP-D-SHOT-0004', '[role="status"] button'],
];
const sizes = [
  [1280, 720],
  [390, 844],
];
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const measures = [];
try {
  for (const [w, h] of sizes) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    for (const [name, id, action] of states) {
      await page.goto(`${BASE}/?case=${id}`);
      await page.locator('#case-heading', { hasText: id }).waitFor();
      await page.waitForTimeout(300);
      if (w < 1024) await page.locator('.case-panel').evaluate((el) => el.scrollIntoView({ block: 'start' }));
      await page.waitForTimeout(200);
      const inView = async (selector) => {
        const box = await page.locator(selector).first().boundingBox().catch(() => null);
        return Boolean(box && box.y >= 0 && box.y + box.height <= h && box.x >= 0 && box.x + box.width <= w);
      };
      const m = {
        name,
        size: `${w}x${h}`,
        verdictVisible: await inView('.decision-card .verdict'),
        actionVisible: await inView(action),
        approveButtons: await page.locator('.case-panel .approve').count(),
        overflowX: await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      };
      if (name === 'fight-case' && w === 1280) {
        await page.locator('.record-chip').first().focus();
        m.keyboardSource = (await page.locator('.record-chip').first().getAttribute('aria-expanded')) === 'true';
        await page.keyboard.press('Escape');
        await page.locator('body').click({ position: { x: 5, y: 5 } });
      }
      measures.push(m);
      await page.screenshot({ path: `${OUT}/${name}-${w}x${h}.png` });
    }
    await page.close();
  }
} finally {
  await browser.close();
}
await writeFile(`${OUT}/measures.json`, JSON.stringify(measures, null, 2));
console.log(JSON.stringify(measures));
