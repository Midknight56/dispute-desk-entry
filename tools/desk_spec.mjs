import { chromium } from 'playwright';
import { DESK } from './desk_url.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const cases = [
  { id: option('--case-fight', 'PP-R-AYP-10194173'), verdict: 'FIGHT', filed: 'provide-evidence' },
  { id: option('--case-accept', 'PP-R-ERC-10194174'), verdict: 'ACCEPT', filed: 'accept-claim' },
];

let failed = 0;
async function check(name, run) {
  try {
    const reason = await run();
    if (reason) throw new Error(reason);
    console.log(`ok ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}: ${String(error?.message || error).split('\n')[0]}`);
  }
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message || String(error)));
page.on('console', (message) => {
  const text = message.text();
  // AG Studio prints its missing key notice as a box: each line starts and ends with "*".
  const studioLicense =
    (/licen[cs]e/i.test(text) && /ag[- ]?(studio|grid)/i.test(text)) || /^\*.*\*$/.test(text.trim());
  if (message.type() === 'error' && !studioLicense) pageErrors.push(text);
});

await check('desk loads without errors, with four tiles and grid rows', async () => {
  await page.goto(`${DESK}/`, { waitUntil: 'networkidle' });
  await page.locator('dl.tiles dt').first().waitFor();
  await page.locator('.ag-row .ag-cell').first().waitFor();
  if (pageErrors.length) return `page errors: ${pageErrors.slice(0, 3).join(' | ')}`;
  if ((await page.locator('dl.tiles dt').count()) !== 4) return 'expected four tiles';
  if ((await page.locator('.ag-row .ag-cell').count()) === 0) return 'grid has no rows';
});

await check('Proof shows its counts and checks made up and true sentences', async () => {
  await page.goto(`${DESK}/proof`, { waitUntil: 'networkidle' });
  const counts = page.locator('.proof-count');
  await counts.first().waitFor();
  if (!(await counts.nth(0).innerText()).startsWith('24 of 24')) return 'verdict count does not read 24 of 24';
  if (!/^\d+ of \d+/.test(await counts.nth(1).innerText())) return 'sentence check count does not read N of N';

  const sentence = page.locator('#proof-text');
  await sentence.fill('The buyer paid $999.00.');
  await page.locator('#proof-record').selectOption('CAP1');
  await page.getByRole('button', { name: 'Check' }).click();
  const result = page.locator('.proof-result strong');
  await result.waitFor();
  if ((await result.innerText()) !== 'Struck') return 'made up sentence was not struck';

  await sentence.fill('The buyer paid $48.00.');
  await page.getByRole('button', { name: 'Check' }).click();
  await page.waitForFunction(
    (previous) => document.querySelector('.proof-result strong')?.textContent?.trim() !== previous,
    'Struck',
  );
  if ((await result.innerText()) !== 'Kept') return 'true sentence was not kept';
  await page.goto(`${DESK}/`, { waitUntil: 'networkidle' });
});

async function openCase(disputeId) {
  await page.goto(`${DESK}/?case=${encodeURIComponent(disputeId)}`, { waitUntil: 'networkidle' });
  await page.locator('.case-heading h2', { hasText: disputeId }).waitFor();
  await page.locator('.verdict').waitFor();
}

await check(`${cases[0].id} shows evidence, verdict, citations, and filing`, async () => {
  await openCase(cases[0].id);
  if ((await page.locator('.steps li').count()) === 0) return 'steps list is empty';
  if (!(await page.locator('.verdict').innerText()).includes(cases[0].verdict)) return 'expected FIGHT verdict';
  const sentences = page.locator('.draft .sentence');
  if ((await sentences.count()) === 0) return 'draft has no sentences';
  for (let i = 0; i < (await sentences.count()); i++) {
    if ((await sentences.nth(i).locator('.record-chip').count()) === 0)
      return `draft sentence ${i + 1} has no record chip`;
  }
  const filed = page.locator('.filed');
  if ((await filed.count()) === 0 || !(await filed.innerText()).includes(cases[0].filed))
    return 'Filed line does not name provide-evidence';
  const packLink = page.getByRole('link', { name: 'Evidence pack' });
  if ((await packLink.count()) !== 1) return 'Evidence pack link is missing';
  const download = await packLink.getAttribute('download');
  if (download === null) return 'Evidence pack link does not download';
  if (download !== `${cases[0].id}-evidence.pdf`) return 'Evidence pack filename is incorrect';
  const pack = await page.request.get(new URL(await packLink.getAttribute('href'), DESK).toString());
  if (pack.status() !== 200) return `Evidence pack returned ${pack.status()}`;
  if (!(await pack.body()).toString('latin1').startsWith('%PDF')) return 'Evidence pack body does not start with PDF';
});

await check('Tab opens the first record popover and Escape closes it', async () => {
  const firstChip = page.locator('.draft .record-chip').first();
  await firstChip.waitFor();
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  let focused = false;
  for (let i = 0; i < 150; i++) {
    await page.keyboard.press('Tab');
    focused = await firstChip.evaluate((element) => element === document.activeElement);
    if (focused) break;
  }
  if (!focused) return 'Tab did not focus the first record chip';
  if ((await firstChip.getAttribute('aria-expanded')) !== 'true') return 'focus did not open the popover';
  await page.keyboard.press('Escape');
  if ((await firstChip.getAttribute('aria-expanded')) !== 'false') return 'Escape did not close the popover';
});

await check(`${cases[1].id} shows ACCEPT, filing, and a Settled grid row`, async () => {
  await openCase(cases[1].id);
  if (!(await page.locator('.verdict').innerText()).includes(cases[1].verdict)) return 'expected ACCEPT verdict';
  const filed = page.locator('.filed');
  if ((await filed.count()) === 0 || !(await filed.innerText()).includes(cases[1].filed))
    return 'Filed line does not name accept-claim';
  const row = page.locator('.ag-row').filter({ hasText: cases[1].id }).first();
  if (!(await row.innerText()).includes('Settled')) return 'case row does not read Settled';
});

await check('Studio loads with evidence readiness, a populated deadline ring, and the AI panel', async () => {
  pageErrors.length = 0;
  await page.goto(`${DESK}/studio`, { waitUntil: 'networkidle' });
  // The two custom widgets have no title on the page: wait for their own rows and ring instead.
  await page.locator('.studio-evidence .studio-evidence-row').first().waitFor();
  await page.locator('.studio-deadline svg[role="img"][aria-label$="days left"]').waitFor();
  await page
    .getByText(/AI Assistant/i)
    .first()
    .waitFor();
  const deadlineId = (await page.locator('.studio-deadline > span').innerText()).trim();
  if (!deadlineId) return 'deadline ring has no case data';
  if (pageErrors.length) return `page errors: ${pageErrors.slice(0, 3).join(' | ')}`;
});

await context.close();
await browser.close();
process.exit(failed ? 1 : 0);
