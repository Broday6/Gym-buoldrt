/**
 * Merchandiser console smoke test.
 *
 * Drives the console in a real browser and asserts that every screen loads real
 * data from the API — a console that renders but shows zeros is worse than one
 * that fails, because it looks like it works.
 *
 *   npm run dev              # in one shell, seeded
 *   npm run ui-smoke:admin   # in another
 */
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';

const BASE = process.env.COMPASS_ADMIN_URL ?? 'http://localhost:3100/admin/';
const failures = [];
const errors = [];

function check(label, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

const executablePath = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
const browser = await chromium.launch(existsSync(executablePath) ? { executablePath } : {});
const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
page.on('console', (m) => {
  if (m.type() === 'error' && !/ERR_(TUNNEL|CERT|NAME)/.test(m.text())) errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

// The console asks for an admin key on first use and keeps it in the browser.
// Seed it here so the test drives the console the way a returning merchandiser
// does, rather than sitting on the connect screen.
const keys = JSON.parse(readFileSync('./data/demo/keys.json', 'utf8'));
await page.addInitScript((stored) => {
  localStorage.setItem('compass.adminKeys', JSON.stringify(stored));
}, Object.fromEntries(Object.entries(keys).map(([site, k]) => [site, k.admin])));

await page.goto(BASE, { waitUntil: 'networkidle' });
check('a stored key gets straight past the connect screen',
  (await page.locator('.connect').count()) === 0);

// ---- dashboard -------------------------------------------------------------
await page.waitForSelector('.stat__value', { timeout: 20000 });
const stats = await page.locator('.stat__value').allTextContents();
check('dashboard renders four headline metrics', stats.length >= 4, stats.join(' | '));
check('metrics are computed, not placeholders',
  stats.every((s) => s.trim() !== '' && s.trim() !== '0'), stats.join(' | '));
check('the sparkline has a real series', (await page.locator('.spark__line').count()) === 1);
const fixes = await page.locator('[data-fix="synonym"]').count();
check('failing queries offer an inline fix', fixes > 0, `${fixes} rows`);

// ---- query tester ----------------------------------------------------------
await page.click('[data-nav="tester"]');
await page.waitForSelector('#q', { timeout: 10000 });
await page.fill('#q', 'chandaleer');
await page.waitForTimeout(1500);
check('the tester returns results', (await page.locator('.pv').count()) > 0);
check('ranking explainability is shown',
  await page.locator('.pv__why').first().isVisible().catch(() => false));
const why = (await page.locator('.pv__why').first().textContent()) ?? '';
check('the explanation names the cascade criteria',
  /typos/.test(why) && /words/.test(why) && /field/.test(why), why.split('\n')[0]);
check('the tester reports the query type and timing',
  (await page.locator('.pill').allTextContents()).some((t) => /ms$/.test(t.trim())));

// ---- collections and the visual rule builder --------------------------------
await page.click('[data-nav="collections"]');
await page.waitForSelector('table', { timeout: 10000 });
check('collections are listed', (await page.locator('tbody tr').count()) > 0);
await page.click('#new-collection');
await page.waitForSelector('.rule', { timeout: 10000 });
await page.selectOption('.clause select[data-part="field"]', 'margin');
await page.waitForTimeout(400);
await page.fill('.clause input[data-part="value"]', '55');
await page.waitForTimeout(1600);
const preview = (await page.locator('[data-preview]').textContent())?.trim().replace(/\s+/g, ' ') ?? '';
check('the rule builder counts matches live', /Matches \d+ of \d+/.test(preview), preview);
check('the builder previews matching products', (await page.locator('#matches .pv').count()) > 0);
check('no raw JSON is required to write a rule',
  (await page.locator('.clause select').count()) >= 2);

// ---- vocabulary, badges, catalog -------------------------------------------
await page.click('[data-nav="vocabulary"]');
await page.waitForSelector('#add-syn', { timeout: 10000 });
check('vocabulary screen loads', (await page.locator('#add-red').count()) === 1);

await page.click('[data-nav="badges"]');
await page.waitForTimeout(1000);
const badgeLabels = await page.locator('.badge').allTextContents();
check('badges are listed', badgeLabels.length > 0, badgeLabels.join(' | '));

await page.click('[data-nav="catalog"]');
await page.waitForSelector('.stat__value', { timeout: 10000 });
const catalogStats = await page.locator('.stat__value').allTextContents();
check('catalog health reports document counts',
  Number(catalogStats[0]?.replace(/[^0-9]/g, '')) > 0, catalogStats.join(' | '));

// ---- multi-tenancy ---------------------------------------------------------
const sites = await page.locator('#site option').count();
check('the site switcher offers every tenant', sites >= 2, `${sites} sites`);

await page.screenshot({ path: 'admin.png' });

// ---- the key gate ----------------------------------------------------------
//
// A console that silently shows empty screens when its key is wrong is worse
// than one that says so, so both directions are checked: no key asks, and a
// pasted key gets in.
const fresh = await browser.newPage({ viewport: { width: 1440, height: 980 } });
fresh.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await fresh.goto(BASE, { waitUntil: 'networkidle' });
await fresh.waitForSelector('.connect', { timeout: 10000 }).catch(() => {});
check('without a key the console asks for one instead of showing empty screens',
  (await fresh.locator('.connect').count()) === 1);
check('the site switcher still works before authenticating',
  (await fresh.locator('#site option').count()) >= 2);

const firstSite = await fresh.locator('#site').inputValue();
await fresh.fill('#adminkey', keys[firstSite].admin);
await fresh.click('[data-connect]');
await fresh.waitForSelector('.stat__value', { timeout: 15000 });
check('pasting the admin key opens the console',
  (await fresh.locator('.stat__value').count()) >= 4);

await fresh.reload({ waitUntil: 'networkidle' });
await fresh.waitForSelector('.stat__value', { timeout: 15000 }).catch(() => {});
check('the key is remembered across a reload', (await fresh.locator('.connect').count()) === 0);

await browser.close();

if (errors.length) {
  console.error(`\nconsole errors:\n${errors.join('\n')}`);
  failures.push('console errors');
}
console.log(`\n${failures.length ? `${failures.length} FAILED: ${failures.join(', ')}` : 'all checks passed'}`);
process.exit(failures.length ? 1 : 0);
