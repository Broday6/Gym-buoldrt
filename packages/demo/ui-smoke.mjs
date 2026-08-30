/**
 * Storefront UI smoke test.
 *
 * Drives the demo storefront in a real browser at desktop and mobile widths and
 * asserts the behaviours unit tests cannot see: that the ARIA combobox wiring is
 * live, that a desktop facet click updates the grid immediately while a mobile
 * one stages behind "Show N Results", that an explicit sort survives the ranking
 * pipeline, and that nothing overflows horizontally.
 *
 *   npm run dev        # in one shell, with the demo catalogue seeded
 *   npm run ui-smoke   # in another
 */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const BASE = process.env.COMPASS_DEMO_URL ?? 'http://localhost:3100/demo/';
const failures = [];
const errors = [];

function check(label, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

// Prefer a preinstalled Chromium when the environment provides one.
const executablePath = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
const browser = await chromium.launch(existsSync(executablePath) ? { executablePath } : {});

async function open(label, width, height) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('console', (m) => {
    // The seeded catalogue points at a local placeholder image route; network
    // failures beyond that are real problems worth reporting.
    if (m.type() === 'error' && !/ERR_(TUNNEL|CERT|NAME)/.test(m.text())) {
      errors.push(`[${label}] ${m.text()}`);
    }
  });
  page.on('pageerror', (e) => errors.push(`[${label}] pageerror: ${e.message}`));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.compass-hit', { timeout: 20000 });
  return page;
}

// ---------------------------------------------------------------- desktop --
const desktop = await open('desktop', 1280, 900);

check('results grid renders', (await desktop.locator('.compass-grid .compass-hit').count()) > 0);
check('facet groups render', (await desktop.locator('.compass-facet').count()) >= 4);
check('category nav renders', (await desktop.locator('#catnav button').count()) > 1);

await desktop.fill('#q', 'shut');
await desktop.waitForSelector('.compass-ac[data-state="open"] .compass-ac__item', { timeout: 10000 });
const sections = await desktop.locator('.compass-ac__section-title').allTextContents();
check('autocomplete has multiple sections', sections.length >= 2, sections.join(', '));
check('autocomplete has product thumbnails', (await desktop.locator('.compass-ac__thumb').count()) > 0);

await desktop.keyboard.press('ArrowDown');
check('combobox is expanded', (await desktop.getAttribute('#q', 'aria-expanded')) === 'true');
check('arrow key sets aria-activedescendant', Boolean(await desktop.getAttribute('#q', 'aria-activedescendant')));
check('exactly one option is selected', (await desktop.locator('.compass-ac__item[aria-selected="true"]').count()) === 1);
await desktop.keyboard.press('Escape');
check('escape closes the listbox', (await desktop.getAttribute('#q', 'aria-expanded')) === 'false');

await desktop.fill('#q', '');
await desktop.click('#catnav button[data-cat="exterior/shutters"]');
await desktop.waitForTimeout(1200);
const before = (await desktop.locator('.compass-header__count').textContent())?.trim();
await desktop.locator('.compass-facet[data-field="material"] input[type=checkbox]').first().check();
await desktop.waitForTimeout(1000);
const after = (await desktop.locator('.compass-header__count').textContent())?.trim();
check('desktop facet click updates the grid live', before !== after, `${before} -> ${after}`);
check('applying a facet adds a chip', (await desktop.locator('.compass-chip').count()) === 1);

await desktop.locator('.compass-chip').first().click();
await desktop.waitForTimeout(900);
check('removing a chip restores the count',
  (await desktop.locator('.compass-header__count').textContent())?.trim() === before);

await desktop.fill('#q', 'beam');
await desktop.press('#q', 'Enter');
await desktop.waitForTimeout(1200);
await desktop.selectOption('.compass-sort__select', 'price_asc');
await desktop.waitForTimeout(1000);
// Scoped to the grid: the recommendation rails also carry price elements, and
// a rail is ordered by its own logic, not by the shopper's chosen sort.
const priced = (await desktop.locator('.compass-grid .compass-hit__price strong').allTextContents())
  .map((p) => Number(p.replace(/[^0-9.]/g, '')));
check('explicit sort survives the ranking pipeline',
  priced.every((n, i) => i === 0 || priced[i - 1] <= n), priced.slice(0, 5).join(', '));

await desktop.fill('#q', 'qqzzxnothing');
await desktop.press('#q', 'Enter');
await desktop.waitForTimeout(1400);
const notice = await desktop.locator('.compass-rescue__notice').textContent().catch(() => null);
check('a hopeless query is rescued, not dead-ended', Boolean(notice), notice?.trim() ?? 'no banner');
check('the rescue leaves products on the page',
  (await desktop.locator('.compass-grid .compass-hit').count()) > 0);

// ---- merchandising surfaces ----
check('merchandiser badges render on cards',
  (await desktop.locator('.compass-grid .compass-badge').count()) > 0,
  (await desktop.locator('.compass-grid .compass-badge').first().textContent().catch(() => '')) ?? '');
const rails = await desktop.locator('.compass-recs').count();
check('recommendation rails render', rails > 0, `${rails} rails`);
check('a rail always has products, never an empty shell',
  (await desktop.locator('.compass-recs__rail .compass-hit').count()) > 0);
check('a rail says what actually served it', Boolean(
  await desktop.locator('.compass-recs').first().getAttribute('data-served-by')));

// ---- instant search ----
await desktop.fill('#q', 'shutt');
await desktop.waitForTimeout(1100);
const instant = (await desktop.locator('.compass-header__count').textContent())?.trim() ?? '';
check('the grid updates while typing, before submit', /shutt/.test(instant), instant.replace(/\s+/g, ' '));
await desktop.keyboard.press('Escape');

await desktop.click('h1.brand, .brand');
await desktop.keyboard.press('/');
check('slash focuses the search box',
  (await desktop.evaluate(() => document.activeElement?.id)) === 'q');

check('no horizontal overflow (desktop)', !(await desktop.evaluate(
  () => document.documentElement.scrollWidth > document.documentElement.clientWidth)));
await desktop.screenshot({ path: 'ui-desktop.png' });

// ----------------------------------------------------------------- mobile --
const mobile = await open('mobile', 390, 800);

check('mobile shows a filter trigger', await mobile.locator('.compass-facets__trigger').isVisible());
check('badges survive at mobile width',
  (await mobile.locator('.compass-grid .compass-badge').count()) > 0);
check('mobile hides the desktop facet rail',
  (await mobile.locator('.compass-facets__groups').isVisible().catch(() => false)) === false);

await mobile.click('.compass-facets__trigger');
await mobile.waitForSelector('.compass-facets__modal:not([hidden])', { timeout: 6000 });
const applyBefore = (await mobile.locator('.compass-facets__apply').textContent())?.trim();
await mobile.locator('.compass-facets__modal input[type=checkbox]').first().check();
await mobile.waitForTimeout(1200);
const applyAfter = (await mobile.locator('.compass-facets__apply').textContent())?.trim();
check('apply button previews the staged count', applyBefore !== applyAfter, `${applyBefore} -> ${applyAfter}`);
check('a staged selection is not applied yet', (await mobile.locator('.compass-chip').count()) === 0);

await mobile.click('.compass-facets__apply');
await mobile.waitForTimeout(1100);
check('apply commits the selection', (await mobile.locator('.compass-chip').count()) === 1);
check('apply closes the modal', await mobile.locator('.compass-facets__modal').isHidden());

await mobile.fill('#q', 'beam');
await mobile.waitForSelector('.compass-ac[data-state="open"]', { timeout: 10000 });
const box = await mobile.boundingBox?.() ?? null;
const panel = await mobile.locator('.compass-ac').boundingBox();
check('autocomplete becomes a full-screen takeover',
  Math.round(panel?.width ?? 0) === 390 && Math.round(panel?.height ?? 0) >= 700,
  `${panel?.width}x${Math.round(panel?.height ?? 0)}`);
void box;

check('no horizontal overflow (mobile)', !(await mobile.evaluate(
  () => document.documentElement.scrollWidth > document.documentElement.clientWidth)));
await mobile.screenshot({ path: 'ui-mobile.png' });

await browser.close();

if (errors.length) {
  console.error(`\nconsole errors:\n${errors.join('\n')}`);
  failures.push('console errors');
}
console.log(`\n${failures.length ? `${failures.length} FAILED: ${failures.join(', ')}` : 'all checks passed'}`);
console.log('screenshots: ui-desktop.png, ui-mobile.png');
process.exit(failures.length ? 1 : 0);
