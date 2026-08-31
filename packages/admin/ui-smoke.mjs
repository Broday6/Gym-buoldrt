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

// ---- history and undo -------------------------------------------------------
await page.click('[data-nav="history"]');
// Waiting on `tbody tr` would match the table the previous screen left behind.
await page.waitForSelector('tbody tr[data-row]', { timeout: 10000 });
const historyRows = await page.locator('tbody tr[data-row]').count();
check('history lists recorded changes', historyRows > 0, `${historyRows} entries`);
await page.locator('[data-diff]').first().click();
await page.waitForTimeout(500);
const diffRows = await page.locator('.diff__table tbody tr').count();
check('a change shows which fields moved', diffRows > 0, `${diffRows} fields`);
check('the diff shows both sides',
  (await page.locator('.diff__before').count()) > 0 && (await page.locator('.diff__after').count()) > 0);
check('an undo is offered for changes that have a prior state',
  (await page.locator('[data-revert]').count()) > 0);

// The round trip, not just the button: undoing has to write a new entry rather
// than erase the one it undid.
const topBefore = (await page.locator('tbody tr[data-row]').first().getAttribute('data-row'));
await page.locator('[data-revert]').first().click();
await page.waitForTimeout(1200);
const topAfter = (await page.locator('tbody tr[data-row]').first().getAttribute('data-row'));
check('undoing records a new entry rather than deleting the old one',
  Number(topAfter) > Number(topBefore), `${topBefore} -> ${topAfter}`);
// The console shows the action in a merchandiser's words, not the column's.
check('the undo is labelled as one',
  /undone/i.test((await page.locator('tbody tr[data-row]').first().textContent()) ?? ''));
check('history is append-only: the original change is still there',
  (await page.locator(`tbody tr[data-row="${topBefore}"]`).count()) === 1);

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

// ---- roles ------------------------------------------------------------------
//
// A control the key cannot use is worse than a missing one: it 403s and reads
// as a bug. So the check is that lower roles genuinely see less.
async function openAs(role) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
  page.on('pageerror', (e) => errors.push(`[${role}] pageerror: ${e.message}`));
  await page.addInitScript(([stored, r]) => {
    localStorage.setItem('compass.adminKeys', JSON.stringify(
      Object.fromEntries(Object.entries(stored).map(([site, k]) => [site, k[r]]))));
  }, [keys, role]);
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  return page;
}

const analyst = await openAs('analyst');
check('the console reports the role it is using',
  (await analyst.locator('#role').textContent())?.trim() === 'analyst');
const analystNav = (await analyst.locator('[data-nav]').allTextContents()).map((t) => t.trim());
check('an analyst gets the reports', analystNav.includes('Dashboard'), analystNav.join(', '));
check('an analyst is not offered merchandising screens',
  !analystNav.some((t) => ['Collections', 'Badges', 'Vocabulary'].includes(t)), analystNav.join(', '));
check('an analyst is not offered the one-click synonym fix',
  (await analyst.locator('[data-fix="synonym"]').count()) === 0);
await analyst.click('[data-nav="catalog"]');
await analyst.waitForSelector('.stat__value', { timeout: 10000 });
check('an analyst can read catalogue health but cannot rebuild the index',
  (await analyst.locator('#reindex').count()) === 0);

await analyst.click('[data-nav="history"]');
// `tbody tr` would match the table the previous screen left behind.
await analyst.waitForSelector('tbody tr[data-row]', { timeout: 10000 });
check('an analyst can read the history but cannot undo anything',
  (await analyst.locator('tbody tr[data-row]').count()) > 0
  && (await analyst.locator('[data-revert]').count()) === 0);

const merch = await openAs('merchandiser');
const merchNav = (await merch.locator('[data-nav]').allTextContents()).map((t) => t.trim());
check('a merchandiser gets the merchandising screens',
  ['Collections', 'Badges', 'Vocabulary'].every((t) => merchNav.includes(t)), merchNav.join(', '));
check('a merchandiser gets the one-click synonym fix',
  (await merch.locator('[data-fix="synonym"]').count()) > 0);
await merch.click('[data-nav="catalog"]');
await merch.waitForSelector('.stat__value', { timeout: 10000 });
check('a merchandiser still cannot rebuild the index',
  (await merch.locator('#reindex').count()) === 0);

// ---- phone ------------------------------------------------------------------
//
// The console is a desktop tool, but a merchandiser checking a number from
// their phone should not get a 668px-wide page in a 390px viewport — which is
// what the fixed sidebar column used to produce.
const small = await browser.newPage({
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
});
small.on('pageerror', (e) => errors.push(`[phone] pageerror: ${e.message}`));
await small.addInitScript((stored) => {
  localStorage.setItem('compass.adminKeys', JSON.stringify(stored));
}, Object.fromEntries(Object.entries(keys).map(([site, k]) => [site, k.admin])));
await small.goto(BASE, { waitUntil: 'networkidle' });
await small.waitForSelector('.stat__value', { timeout: 20000 });

const fits = () => small.evaluate(
  () => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
check('the dashboard fits a phone', await fits());
check('the screen name is readable, not crushed by the actions',
  ((await small.locator('#view-title').boundingBox())?.width ?? 0) > 120);
check('the sidebar is a drawer, closed by default',
  ((await small.locator('#side').boundingBox())?.x ?? 0) < 0);
check('a menu button opens it', await small.locator('#menu').isVisible());

await small.tap('#menu');
await small.waitForTimeout(400);
check('the drawer opens', ((await small.locator('#side').boundingBox())?.x ?? -1) === 0);
// To the right of the drawer: the scrim spans the viewport, but its centre is
// underneath the panel, which is where a thumb would never aim.
await small.tap('#scrim', { position: { x: 370, y: 500 } });
await small.waitForTimeout(400);
check('tapping outside closes it', await small.locator('#scrim').isHidden());

// Every screen, because one wide table sets the width of the whole page.
/** The drawer slides; tapping mid-animation lands on whatever is under the point. */
async function openDrawer() {
  await small.tap('#menu');
  await small.waitForFunction(
    () => document.querySelector('#side')?.getBoundingClientRect().x === 0,
    null, { timeout: 5000 },
  );
}

for (const [nav, ready] of [['tester', '#q'], ['collections', 'table'],
  ['badges', '.badge'], ['history', 'tbody tr[data-row]'], ['catalog', '.stat__value']]) {
  await openDrawer();
  await small.tap(`[data-nav="${nav}"]`);
  await small.waitForSelector(ready, { timeout: 10000 });
  await small.waitForTimeout(400);
  check(`${nav} fits a phone`, await fits());
}
check('choosing a destination closes the drawer', await small.locator('#scrim').isHidden());
await small.screenshot({ path: 'admin-mobile.png' });

await browser.close();

if (errors.length) {
  console.error(`\nconsole errors:\n${errors.join('\n')}`);
  failures.push('console errors');
}
console.log(`\n${failures.length ? `${failures.length} FAILED: ${failures.join(', ')}` : 'all checks passed'}`);
process.exit(failures.length ? 1 : 0);
