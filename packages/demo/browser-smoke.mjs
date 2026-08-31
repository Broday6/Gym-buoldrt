/**
 * Hosted-demo smoke test.
 *
 * The file `npm run build:browser` produces is the one thing here that is
 * opened directly by people who will never run the server, so it is the one
 * thing that has to be checked as a file rather than as a running system. This
 * drives it over `file://` at desktop and phone widths.
 *
 * What it asserts is the shopper's side of the bargain: that the page reads as
 * a shop rather than a diagnostic harness, that a misspelling still lands on
 * products, that a brand-plus-product-type phrase is read as both,
 * and that the control offered for rejecting that reading actually changes the
 * results — a chip that comes straight back is worse than no chip.
 *
 *   npm run build:browser
 *   npm run browser-smoke
 */
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
/** WCAG 2.1 A and AA. Best-practice rules are advisory and not failed on. */
const AXE_OPTIONS = { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } };

const FILE = process.env.COMPASS_BROWSER_DEMO ?? resolve('./data/browser/index.html');
if (!existsSync(FILE)) {
  console.error(`no built demo at ${FILE} — run: npm run build:browser`);
  process.exit(1);
}
const URL_ = pathToFileURL(FILE).href;

const failures = [];
const errors = [];

function check(label, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

const executablePath = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
const browser = await chromium.launch(existsSync(executablePath) ? { executablePath } : {});

async function open(label, width, height) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('console', (m) => {
    // The page loads a webfont from a CDN; a sandbox without network is not a
    // defect in the page.
    if (m.type() === 'error' && !/ERR_(TUNNEL|CERT|NAME|INTERNET|CONNECTION)/.test(m.text())) {
      errors.push(`[${label}] ${m.text()}`);
    }
  });
  page.on('pageerror', (e) => errors.push(`[${label}] pageerror: ${e.message}`));
  await page.goto(URL_);
  await page.waitForSelector('.compass-hit', { timeout: 30000 });
  return page;
}

/** Type into the shop's search box the way a shopper does, and settle. */
async function searchFor(page, query) {
  await page.fill('#q', '');
  await page.fill('#q', query);
  await page.press('#q', 'Enter');
  await page.waitForFunction(
    (q) => document.querySelector('#title')?.textContent?.includes(q),
    query, { timeout: 15000 });
  await page.waitForTimeout(400);
}

// ---------------------------------------------------------------- desktop --
const desktop = await open('desktop', 1280, 900);

check('the grid renders', (await desktop.locator('.compass-grid .compass-hit').count()) === 24);
check('facets render', (await desktop.locator('.compass-facet').count()) >= 4);
check('departments render', (await desktop.locator('#dept button').count()) > 2);
check('collections render', (await desktop.locator('#collections button').count()) >= 3);
check('popular searches render', (await desktop.locator('#examples button').count()) >= 4);

// The developer telemetry this page used to carry, named so it cannot creep
// back: an index spec sheet, a query-type readout, and chips captioned with the
// name of the test case they exercised.
const body = await desktop.locator('body').innerText();
check('no engine readout', !/in-memory|Variants indexed|processingTime/i.test(body));
check('no millisecond timings on the page', !/\d+(\.\d+)?ms\b/.test(body));
check('the demo says what it is', /generated sample data/i.test(body));
const shelves = (await desktop.locator('.shelf').allInnerTexts()).join(' ');
check('nothing on the shelves is captioned with a test case',
  !/variant match|dimension|typo|compound|fraction|nothing here/i.test(shelves), shelves.slice(0, 90));

// ---- a misspelling still lands on products --------------------------------
await searchFor(desktop, 'chandaleer');
check('a misspelling returns products',
  (await desktop.locator('.compass-hit').count()) > 0);
// Typo tolerance may absorb it inside retrieval, in which case there is no
// rescue to announce. Either way the shopper must land on chandeliers.
const misspelled = await desktop.locator('.compass-hit__title').allTextContents();
check('a misspelling lands on the right products',
  misspelled.length > 0 && misspelled.every((t) => /chandelier/i.test(t)),
  misspelled.slice(0, 2).join(' | '));

// ---- brand + product type -------------------------------------------------
await searchFor(desktop, 'volterra beams');
const understood = await desktop.locator('.compass-understood__tag').allTextContents();
check('the brand is understood', understood.some((t) => /Brand: Volterra/i.test(t)), understood.join(' | '));
const withBrand = await desktop.locator('.compass-header__count').textContent();
const brandHits = Number((withBrand ?? '').replace(/,/g, '').match(/\d+/)?.[0] ?? 0);
check('brand-plus-type returns products', brandHits > 0, withBrand?.trim());
const titles = await desktop.locator('.compass-hit__title').allTextContents();
check('every result is a beam', titles.length > 0 && titles.every((t) => /beam/i.test(t)),
  titles.slice(0, 3).join(' | '));

// ---- and the shopper can reject that reading ------------------------------
await desktop.click('.compass-understood__undo');
await desktop.waitForTimeout(500);
const widened = await desktop.locator('.compass-header__count').textContent();
const widenedHits = Number((widened ?? '').replace(/,/g, '').match(/\d+/)?.[0] ?? 0);
// Dropping a constraint can only ever add products, never remove them. It
// often adds none: every Volterra beam says "Volterra" in its own text, so the
// literal search finds the same set. What has to change is the claim — the
// page must stop saying it filtered by a brand it no longer filters by.
check('dropping the reading never loses products', widenedHits >= brandHits,
  `${brandHits} -> ${widenedHits}`);
check('and the reading stays dropped',
  (await desktop.locator('.compass-understood__tag').count()) === 0);

// ---- a brand that does not make the thing -------------------------------
// The rescue drops the brand and shows the product type. The page must then
// stop naming the brand: an explanation the grid does not obey is a lie.
await searchFor(desktop, 'timberthane beams');
const notice = (await desktop.locator('.compass-rescue__notice').textContent().catch(() => '')) ?? '';
check('a brand with none of that product says so',
  /No Timberthane beams/i.test(notice), notice.trim());
const stillBeams = await desktop.locator('.compass-hit__title').allTextContents();
check('and shows the product type anyway',
  stillBeams.length > 0 && stillBeams.every((t) => /beam/i.test(t)));
const claimed = await desktop.locator('.compass-understood__tag').allTextContents();
check('and stops claiming the brand it dropped',
  !claimed.some((t) => /Timberthane/i.test(t)), claimed.join(' | '));

// ---- a shopper describing what they want ----------------------------------
// Features typed as words are lifted into filters rather than matched as text,
// so a white shutter whose description mentions black cannot answer.
await searchFor(desktop, 'black pvc shutter');
const described = await desktop.locator('.compass-understood__tag').allTextContents();
check('the finish and the material are both understood, as the catalogue spells them',
  described.includes('Black') && described.includes('PVC'), described.join(' | '));
const variants2 = await desktop.locator('.compass-hit__variant').allTextContents();
check('and every result really is one',
  variants2.length > 0 && variants2.every((v) => /Black/i.test(v) && /PVC/i.test(v)),
  variants2.slice(0, 2).join(' | '));

// ---- the variant question the whole index shape exists for ----------------
await searchFor(desktop, 'black shutters');
const shutters = await desktop.locator('.compass-hit__title').allTextContents();
check('"black shutters" returns shutters',
  shutters.length > 0 && shutters.filter((t) => /shutter/i.test(t)).length >= shutters.length - 1,
  shutters.slice(0, 3).join(' | '));
const variants = await desktop.locator('.compass-hit__variant').allTextContents();
check('the black variant is the one shown',
  variants.filter((v) => /black/i.test(v)).length >= Math.ceil(variants.length / 2),
  variants.slice(0, 3).join(' | '));

// ---- shop navigation ------------------------------------------------------
await desktop.locator('#dept button').nth(1).click();
await desktop.waitForTimeout(500);
const deptTitle = await desktop.locator('#title').textContent();
check('a department sets the page heading', Boolean(deptTitle?.trim()) && !deptTitle.includes('“'),
  deptTitle?.trim());
check('a department offers its aisles',
  (await desktop.locator('#subcat-items button').count()) > 0);

await desktop.locator('#collections button').first().click();
await desktop.waitForTimeout(500);
check('a collection sets the page heading and blurb',
  Boolean((await desktop.locator('#subtitle').textContent())?.trim()),
  (await desktop.locator('#title').textContent())?.trim());

// ---- the cart is not a dead button ---------------------------------------
await desktop.locator('.compass-hit__cart').first().click();
check('add to cart counts', (await desktop.locator('#cart').textContent()) === '1');

// ---- nothing overflows ----------------------------------------------------
const overflow = await desktop.evaluate(() =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('no horizontal overflow at 1280px', overflow <= 0, `${overflow}px`);

// ------------------------------------------------------------------ phone --
const phone = await open('phone', 390, 800);
check('phone: the grid renders', (await phone.locator('.compass-hit').count()) > 0);
check('phone: filters collapse behind a button',
  (await phone.locator('.compass-facets__trigger').count()) === 1);
const phoneOverflow = await phone.evaluate(() =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('phone: no horizontal overflow', phoneOverflow <= 1, `${phoneOverflow}px`);
await searchFor(phone, 'black shutters');
check('phone: search returns products', (await phone.locator('.compass-hit').count()) > 0);

// -------------------------------------------------------- accessibility --
// The page ships as one file to anyone with the link, so it carries its own
// audit rather than depending on the suite that needs a running server. Both
// themes: a contrast token that passes in light says nothing about its dark
// counterpart, which is how the last two contrast defects here were found.
for (const theme of ['light', 'dark']) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: theme });
  await page.goto(URL_);
  await page.waitForSelector('.compass-hit', { timeout: 30000 });
  await page.addScriptTag({ path: AXE });
  const result = await page.evaluate((opts) => window.axe.run(document, opts), AXE_OPTIONS);
  const failed = result.violations.filter((v) => v.nodes.length > 0);
  check(`accessible in the ${theme} theme`, failed.length === 0,
    failed.map((v) => `${v.id} x${v.nodes.length}`).join(', '));
  for (const v of failed) {
    for (const node of v.nodes.slice(0, 3)) {
      console.log(`        ${node.html.slice(0, 140).replace(/\s+/g, ' ')}`);
    }
  }
  await page.close();
}

await browser.close();

for (const e of errors) console.log(`ERR   ${e}`);
console.log(`\n${failures.length ? `${failures.length} failed` : 'all checks passed'}`
  + `${errors.length ? `, ${errors.length} console errors` : ''}`);
process.exit(failures.length || errors.length ? 1 : 0);
