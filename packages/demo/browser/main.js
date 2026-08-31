/**
 * The storefront, running entirely in the page.
 *
 * A hosted demo has no server, so the retrieval index is a `MemoryEngine`
 * holding documents a real ingest already produced, and the SDK's single point
 * of contact with the API — `client.request(path, body)` — is redirected to the
 * services that would normally sit behind it.
 *
 * Nothing else is reimplemented. Query analysis, the dimension parser, the
 * tie-breaking cascade, grouping by parent, the business composite, facets,
 * collections, badges and the zero-result rescue are the same modules the
 * server runs, so what a visitor sees is what the product does. The parts that
 * genuinely need a server — ingest, merchandising writes, analytics,
 * recommendations — are absent rather than faked.
 */
import { MemoryEngine } from '../../server/src/engine/memory.js';
import { SearchService } from '../../server/src/services/search.js';
import { AutocompleteService } from '../../server/src/services/autocomplete.js';
import { SiteRegistry } from '../../server/src/config/sites.js';
import { placeholderSvg } from '../../server/src/demo/placeholder.js';
import { CompassClient } from '../../sdk/src/client.js';
import { init } from '../../sdk/src/index.js';

/** Analytics needs a database. Here there is none, and the reports are absent. */
const noDatabase = {
  query: async () => ({ rows: [], rowCount: 0 }),
  connect: async () => { throw new Error('no database in the browser build'); },
  end: async () => {},
};

const EXAMPLES = [
  ['black shutter', 'variant match'],
  ['4x6 beam 12ft', 'dimensions'],
  ['chandaleer', 'typo'],
  ['crownmoulding', 'compound'],
  ['3-1/2 inch crown moulding', 'fraction'],
  ['sofa', 'nothing here'],
];

// The page is rendered inside a host document whose language may be unset,
// and a screen reader needs one to pick a voice.
if (!document.documentElement.lang) document.documentElement.lang = 'en';

const data = JSON.parse(document.querySelector('#catalog').textContent);

const engine = new MemoryEngine();
engine.load(data.site, data.docs);
const site = new SiteRegistry().require(data.site);

// Merchandiser-defined facets and badges are read structurally rather than from
// Postgres, which is exactly why the search pipeline types them that way.
const search = new SearchService(engine, {
  collections: {
    listAttributes: async () => data.attributes,
    listBadges: async () => data.badges,
  },
});
const autocomplete = new AutocompleteService(engine, search, noDatabase);

/**
 * The SDK reaches the API through one method. Replacing it is the whole of the
 * adaptation: every widget above it is the shipped code, unmodified.
 */
class LocalClient extends CompassClient {
  async request(path, body) {
    switch (path) {
      case '/search': return withImages(await search.search(site, body ?? {}));
      case '/browse': return withImages(await search.browse(site, body ?? {}));
      case '/autocomplete': return withImages(await autocomplete.complete(site, body ?? {}));
      default: throw new Error(`${path} needs a server`);
    }
  }

  // Events would go to a collector that is not here. Dropped explicitly, so
  // nothing queues waiting for a flush that never comes.
  track() {}
  flush() {}
}

/**
 * Product imagery.
 *
 * The seeded catalogue has no photography, and the server draws the same
 * placeholder from an endpoint. Drawn per result rather than baked into the
 * documents: 1,355 data URIs would be most of the page's weight, for pictures
 * only a couple of dozen of which are ever on screen.
 */
const drawn = new Map();
function placeholder(sku, finish) {
  let uri = drawn.get(sku);
  if (!uri) {
    uri = `data:image/svg+xml,${encodeURIComponent(placeholderSvg(sku, finish))}`;
    drawn.set(sku, uri);
  }
  return uri;
}

function withImages(response) {
  for (const hit of response.hits ?? []) {
    hit.image = placeholder(hit.sku, String(hit.attributes?.finish ?? hit.variantTitle ?? ''));
  }
  for (const product of response.products ?? []) {
    product.image = placeholder(product.sku, String(product.variantTitle ?? ''));
  }
  return response;
}

const client = new LocalClient({ site: data.site, baseUrl: '' });
const input = document.querySelector('#q');
const readout = document.querySelector('#readout');

const widgets = init({
  client,
  site: data.site,
  searchInput: input,
  results: '#results',
  facets: '#facets',
  hitsPerPage: 24,
  productUrl: () => '#',
  categoryUrl: () => '#',
  searchUrl: (q) => `?q=${encodeURIComponent(q)}`,
  onStateChange: (response) => {
    const parsed = (response.parsedFilters ?? [])
      .map((f) => `<code>${f.field}=${f.value}</code>`).join(' ');
    const rescue = response.rescue ? ` <code>rescued: ${response.rescue.strategy}</code>` : '';
    readout.innerHTML = [
      `<code>${response.queryType}</code>`,
      `searched <code>${response.effectiveQuery || '—'}</code>`,
      `${response.totalHits.toLocaleString()} products`,
      `<span class="readout__ms">${response.processingTimeMs}ms</span>`,
      parsed,
      rescue,
    ].filter(Boolean).join(' ');
  },
});

// ---- the frame ------------------------------------------------------------

document.querySelector('#examples').innerHTML = EXAMPLES
  .map(([q, why]) => `<button type="button" data-q="${q}">${q}<em>${why}</em></button>`)
  .join('');
document.querySelector('#examples').addEventListener('click', (event) => {
  const button = event.target.closest('[data-q]');
  if (!button) return;
  input.value = button.dataset.q;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  void widgets.results.setQuery(button.dataset.q);
});

const directory = await engine.directory(data.site);
const nav = document.querySelector('#nav');
const top = directory.categories.filter((c) => !c.id.includes('/'));
const second = directory.categories.filter((c) => c.id.split('/').length === 2).slice(0, 6);

// Collections and categories are deliberately separate rows: a collection cuts
// across the taxonomy, and putting the two in one strip would hide the very
// thing that makes them different.
document.querySelector('#collections').innerHTML = [
  '<span class="strip__label">Collections</span>',
  ...data.collections.map((c) =>
    `<button type="button" data-col="${c.slug}" title="${c.description ?? ''}">${c.name}</button>`),
].join('');

nav.innerHTML = [
  '<button type="button" data-cat="" aria-current="true">All products</button>',
  ...[...top, ...second].map((c) =>
    `<button type="button" data-cat="${c.id}">${c.path[c.path.length - 1]}` +
    `<span class="nav__count">${c.products}</span></button>`),
].join('');

function onNavClick(event) {
  const button = event.target.closest('[data-cat], [data-col]');
  if (!button) return;
  for (const b of document.querySelectorAll('#nav button, #collections button')) {
    b.setAttribute('aria-current', String(b === button));
  }
  input.value = '';
  if (button.dataset.col !== undefined) {
    void widgets.results.setCollection(button.dataset.col);
  } else {
    void widgets.results.setCollection(null);
    void widgets.results.setCategory(button.dataset.cat || null);
  }
}

nav.addEventListener('click', onNavClick);
document.querySelector('#collections').addEventListener('click', onNavClick);

// The spec strip describes the index this page actually loaded.
const products = new Set(data.docs.map((d) => d.parentId)).size;
document.querySelector('#spec').innerHTML = [
  ['Products', products.toLocaleString()],
  ['Variants indexed', data.docs.length.toLocaleString()],
  ['Engine', 'in-memory'],
  ['Collections', String(data.collections.length)],
  ['Custom filters', String(data.attributes.length)],
  ['Badges', String(data.badges.length)],
].map(([label, value]) =>
  `<span class="spec__item"><span class="spec__label">${label}</span>` +
  `<span class="spec__value">${value}</span></span>`).join('');
