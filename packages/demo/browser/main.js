/**
 * The storefront, running entirely in the page.
 *
 * A hosted demo has no server, so the retrieval index is a `MemoryEngine`
 * holding documents a real ingest already produced, and the SDK's single point
 * of contact with the API — `client.request(path, body)` — is redirected to the
 * services that would normally sit behind it.
 *
 * Nothing else is reimplemented. Query analysis, entity recognition, the
 * dimension parser, the tie-breaking cascade, grouping by parent, the business
 * composite, facets, collections, badges and the zero-result rescue are the
 * same modules the server runs, so what a shopper sees is what the product
 * does. The parts that genuinely need a server — ingest, merchandising writes,
 * analytics, recommendations — are absent rather than faked.
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

/**
 * Things a shopper in this catalogue would plausibly type — including the
 * misspelling and the brand-plus-product-type phrase, because those are the
 * two the search box has to get right and the two a shopper never thinks to
 * test. They are labelled as popular searches, not as test cases: what the
 * engine does with them should be visible in the results, not in a caption.
 */
// The page is rendered inside a host document whose language may be unset,
// and a screen reader needs one to pick a voice.
if (!document.documentElement.lang) document.documentElement.lang = 'en';

const data = JSON.parse(document.querySelector('#catalog').textContent);

/**
 * A page built from a real feed suggests searches from that feed, and names
 * the real shop. The list below is the demo's, and only the demo's.
 */
const POPULAR = data.popular?.length ? data.popular : [
  'black shutters',
  'volterra beams',
  '4x6 beam 12ft',
  'crownmoulding',
  'chandaleer',
  'oil rubbed bronze',
];

if (data.store) {
  document.title = data.store;
  const brand = document.querySelector('.brand__name');
  if (brand) brand.textContent = data.store;
  // The fictional-store disclaimer is about the demo catalogue, not this one.
  for (const el of document.querySelectorAll('.demo-note')) el.remove();
}

const engine = new MemoryEngine();
engine.load(data.site, data.docs);
const registry = new SiteRegistry();
// Attributes this catalogue carries that the built-in config never listed —
// a vent's frame and type live only in product prose, and without this they
// would be searchable text and nothing a shopper can filter on.
registry.adoptFacets(data.site, data.facetable ?? []);
const site = registry.require(data.site);

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
const title = document.querySelector('#title');
const subtitle = document.querySelector('#subtitle');

const directory = await engine.directory(data.site);
const byId = new Map(directory.categories.map((c) => [c.id, c]));
const departments = directory.categories.filter((c) => !c.id.includes('/'));
const collections = new Map(data.collections.map((c) => [c.slug, c]));

// What the shopper is looking at, which is what the page heading has to say.
// Held here rather than read back off the widget: a heading that lags the grid
// by one interaction is worse than no heading.
let place = { kind: 'all' };

let cartCount = 0;
const cart = document.querySelector('#cart');

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
  // A cart the page cannot check out of, but a button that does nothing at all
  // reads as a broken storefront rather than a demonstration of one.
  onAddToCart: () => { cart.textContent = String(++cartCount); },
  onStateChange: (response, state) => {
    if (state.q) place = { kind: 'search', q: response.query || state.q };
    heading(response);
  },
});

/** The page heading follows the shopper, not the query pipeline. */
function heading(response) {
  const total = response?.totalHits ?? 0;
  if (place.kind === 'search') {
    title.textContent = `“${place.q}”`;
    subtitle.textContent = total
      ? `${total.toLocaleString()} ${total === 1 ? 'product' : 'products'}`
      : 'No products matched.';
    return;
  }
  if (place.kind === 'collection') {
    const collection = collections.get(place.slug);
    title.textContent = collection?.name ?? 'Collection';
    subtitle.textContent = collection?.description ?? '';
    return;
  }
  if (place.kind === 'category') {
    const category = byId.get(place.id);
    title.textContent = category?.path.at(-1) ?? 'Products';
    subtitle.textContent = category ? category.path.join(' / ') : '';
    return;
  }
  title.textContent = 'All products';
  subtitle.textContent = 'Beams, shutters, corbels, moulding and hardware.';
}

// ---- the shop's own navigation --------------------------------------------

document.querySelector('#examples').innerHTML = POPULAR
  .map((q) => `<button type="button" data-q="${q}">${q}</button>`).join('');

document.querySelector('#collections').innerHTML = data.collections
  .map((c) => `<button type="button" data-col="${c.slug}">${c.name}</button>`).join('');

document.querySelector('#dept').innerHTML = [
  '<button type="button" data-cat="" aria-current="true">All products</button>',
  ...departments.map((c) =>
    `<button type="button" data-cat="${c.id}">${c.path.at(-1)}</button>`),
].join('');

const subcats = document.querySelector('#subcats');
const subcatItems = document.querySelector('#subcat-items');

/** A department's own aisles. Hidden entirely when there are none to show. */
function showSubcategories(departmentId) {
  const children = departmentId
    ? directory.categories.filter((c) =>
        c.id.startsWith(`${departmentId}/`) && c.id.split('/').length === 2)
    : [];
  subcats.hidden = children.length === 0;
  subcatItems.innerHTML = children
    .map((c) => `<button type="button" data-cat="${c.id}">${c.path.at(-1)}` +
      ` (${c.products.toLocaleString()})</button>`).join('');
}

function mark(active) {
  for (const b of document.querySelectorAll('#dept button, #collections button, #subcat-items button')) {
    b.setAttribute('aria-current', String(b === active));
  }
}

document.querySelector('#examples').addEventListener('click', (event) => {
  const button = event.target.closest('[data-q]');
  if (!button) return;
  input.value = button.dataset.q;
  place = { kind: 'search', q: button.dataset.q };
  void widgets.results.setQuery(button.dataset.q);
  input.focus();
});

function onNavClick(event) {
  const button = event.target.closest('[data-cat], [data-col]');
  if (!button) return;
  mark(button);
  input.value = '';

  if (button.dataset.col !== undefined) {
    place = { kind: 'collection', slug: button.dataset.col };
    subcats.hidden = true;
    heading();
    void widgets.results.setCollection(button.dataset.col);
    return;
  }

  const id = button.dataset.cat || null;
  place = id ? { kind: 'category', id } : { kind: 'all' };
  // Only a department resets the aisle strip; picking an aisle keeps it up,
  // with the chosen one marked.
  if (!id || !id.includes('/')) showSubcategories(id);
  heading();
  void widgets.results.setCollection(null);
  void widgets.results.setCategory(id);
}

for (const id of ['#dept', '#collections', '#subcat-items']) {
  document.querySelector(id).addEventListener('click', onNavClick);
}

// A query in the URL is a shared search; the widget has already read it.
if (widgets.results.state.q) place = { kind: 'search', q: widgets.results.state.q };
heading();
