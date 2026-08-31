/**
 * Accessibility audit.
 *
 * GAPS.md listed "no accessibility audit" as an open item: the autocomplete
 * implements the ARIA combobox pattern and the mobile filter modal manages
 * focus, but neither had been through an automated pass. This runs axe-core
 * against both surfaces, in the states that matter — not just the page as it
 * first loads, because the interesting components (the combobox, the filter
 * modal, the console's key gate) only exist once something is open.
 *
 * Automated rules catch roughly a third of real accessibility problems. This is
 * a floor, not a certificate.
 *
 *   npm run dev       # in one shell, seeded
 *   npm run a11y      # in another
 */
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const STORE = process.env.COMPASS_DEMO_URL ?? 'http://localhost:3100/demo/';
const ADMIN = process.env.COMPASS_ADMIN_URL ?? 'http://localhost:3100/admin/';

const executablePath = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
const browser = await chromium.launch(existsSync(executablePath) ? { executablePath } : {});
const violations = [];

/**
 * Both themes. Every surface here defines a dark palette, and a contrast token
 * that passes in light says nothing about its dark counterpart — the first run
 * of this audit found exactly that, in the console's warning colour.
 */
// An argument, not an environment variable: `VAR=value npm run …` is not a
// thing on Windows, and this suite runs twice from one npm script.
const themeArg = process.argv.indexOf('--theme');
const THEME = (themeArg >= 0 ? process.argv[themeArg + 1] : process.env.COMPASS_A11Y_THEME)
  ?? 'light';

/** WCAG 2.1 A and AA. Best-practice rules are advisory and not failed on. */
const OPTIONS = { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } };

async function audit(page, rawLabel, selector) {
  const label = `${rawLabel} [${THEME}]`;
  await page.addScriptTag({ path: AXE });
  const result = await page.evaluate(
    ([opts, within]) => window.axe.run(within ? document.querySelector(within) : document, opts),
    [OPTIONS, selector ?? null],
  );
  const failed = result.violations.filter((v) => v.nodes.length > 0);
  const count = failed.reduce((n, v) => n + v.nodes.length, 0);
  console.log(`${failed.length ? 'FAIL' : 'ok  '}  ${label}${failed.length ? ` — ${count} node(s)` : ''}`);
  for (const v of failed) {
    console.log(`        ${v.id} (${v.impact}): ${v.help}`);
    for (const node of v.nodes.slice(0, 3)) {
      console.log(`          ${node.html.slice(0, 140).replace(/\s+/g, ' ')}`);
    }
    violations.push(`${label}: ${v.id}`);
  }
}

// ---------------------------------------------------------------- storefront --
const store = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: THEME });
await store.goto(STORE, { waitUntil: 'networkidle' });
await store.waitForSelector('.compass-hit', { timeout: 20000 });
await audit(store, 'storefront: results, facets, rails');

await store.fill('#q', 'shut');
await store.waitForSelector('.compass-ac[data-state="open"] .compass-ac__item', { timeout: 10000 });
await audit(store, 'storefront: autocomplete open');
await store.keyboard.press('Escape');

await store.fill('#q', 'qqzzxnothing');
await store.press('#q', 'Enter');
await store.waitForTimeout(1400);
await audit(store, 'storefront: rescued zero-result page');

const mobile = await browser.newPage({ viewport: { width: 390, height: 800 }, colorScheme: THEME });
await mobile.goto(STORE, { waitUntil: 'networkidle' });
await mobile.waitForSelector('.compass-hit', { timeout: 20000 });
await mobile.click('.compass-facets__trigger');
await mobile.waitForSelector('.compass-facets__modal:not([hidden])', { timeout: 6000 });
await audit(mobile, 'storefront: mobile filter modal');

// ------------------------------------------------------------------- console --
const keys = JSON.parse(readFileSync('./data/demo/keys.json', 'utf8'));
const gate = await browser.newPage({ viewport: { width: 1440, height: 980 }, colorScheme: THEME });
await gate.goto(ADMIN, { waitUntil: 'networkidle' });
await gate.waitForSelector('.connect', { timeout: 10000 });
await audit(gate, 'console: key gate');

const admin = await browser.newPage({ viewport: { width: 1440, height: 980 }, colorScheme: THEME });
await admin.addInitScript((stored) => {
  localStorage.setItem('compass.adminKeys', JSON.stringify(stored));
}, Object.fromEntries(Object.entries(keys).map(([site, k]) => [site, k.admin])));
await admin.goto(ADMIN, { waitUntil: 'networkidle' });
await admin.waitForSelector('.stat__value', { timeout: 20000 });
await audit(admin, 'console: dashboard');

// The rail lists areas; a screen with siblings is a tab inside one.
const AREA_OF = {
  quality: 'reporting', autopilot: 'merchandising', merchandiser: 'merchandising',
  collections: 'merchandising', badges: 'merchandising', history: 'merchandising',
  tester: 'preview', vocabulary: 'vocabulary', data: 'data', guide: 'guide',
};
for (const [screen, ready] of [['quality', '.finding'], ['autopilot', '.proposal'],
  ['merchandiser', '#merch-q'],
  ['tester', '#q'], ['collections', 'table'], ['badges', '.badge'], ['data', '.stat__value'],
  ['guide', '.guide__job']]) {
  await admin.click(`[data-area="${AREA_OF[screen]}"]`);
  await admin.waitForTimeout(300);
  const tab = admin.locator(`.tab[data-nav="${screen}"]`);
  if (await tab.count()) await tab.click();
  await admin.waitForSelector(ready, { timeout: 15000 });
  await admin.waitForTimeout(500);
  await audit(admin, `console: ${screen}`);
}

await browser.close();
console.log(`\n${violations.length
  ? `${violations.length} VIOLATION(S)`
  : `no WCAG 2.1 A/AA violations (${THEME} theme)`}`);
process.exit(violations.length ? 1 : 0);
