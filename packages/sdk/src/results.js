/**
 * Results-grid widget.
 *
 * Renders search or category results into a container element. Every template
 * is overridable, all styling comes from CSS variables, and analytics events
 * (impressions, clicks with position, add-to-cart) are instrumented for free.
 */
import { CompassClient } from './client.js';

const DEFAULT_TEMPLATES = {
  hit: (hit, index, ctx) => `
    <article class="compass-hit" data-sku="${esc(hit.sku)}" data-position="${index + 1}">
      <a class="compass-hit__link" href="${ctx.productUrl(hit)}">
        <div class="compass-hit__media">
          ${hit.image
            ? `<img src="${esc(hit.image)}" alt="${esc(hit.title)}" loading="lazy">`
            : '<div class="compass-hit__placeholder" aria-hidden="true"></div>'}
          ${hit.effectivePrice < hit.price && hit.price > 0
            ? `<span class="compass-hit__badge">${Math.round(((hit.price - hit.effectivePrice) / hit.price) * 100)}% off</span>`
            : ''}
        </div>
        <h3 class="compass-hit__title">${hit.highlights?.title ?? esc(hit.title)}</h3>
        ${hit.variantTitle ? `<p class="compass-hit__variant">${esc(hit.variantTitle)}</p>` : ''}
        <p class="compass-hit__price">
          ${hit.effectivePrice < hit.price && hit.price > 0
            ? `<s>${ctx.money(hit.price)}</s> <strong>${ctx.money(hit.effectivePrice)}</strong>`
            : `<strong>${ctx.money(hit.effectivePrice)}</strong>`}
        </p>
        ${hit.variantCount > 1 ? `<p class="compass-hit__options">${hit.variantCount} options</p>` : ''}
        ${hit.inStock ? '' : '<p class="compass-hit__stock">Out of stock</p>'}
      </a>
      <button class="compass-hit__cart" data-sku="${esc(hit.sku)}" type="button">Add to cart</button>
    </article>`,

  empty: (query) => `
    <div class="compass-empty">
      <p>No results for <strong>${esc(query)}</strong>.</p>
      <p class="compass-empty__hint">Try fewer words, or check the spelling.</p>
    </div>`,

  header: (response, ctx) => `
    <div class="compass-header">
      <p class="compass-header__count">
        ${response.totalHits.toLocaleString()} ${response.totalHits === 1 ? 'product' : 'products'}
        ${response.query ? ` for <strong>${esc(response.query)}</strong>` : ''}
      </p>
      <label class="compass-sort">
        Sort
        <select class="compass-sort__select">
          ${ctx.sortOptions
            .map((o) => `<option value="${o.id}"${o.id === response.sort ? ' selected' : ''}>${esc(o.label)}</option>`)
            .join('')}
        </select>
      </label>
    </div>`,

  pagination: (response) => {
    if (response.totalPages <= 1) return '';
    const prev = response.page > 1;
    const next = response.page < response.totalPages;
    return `
      <nav class="compass-pagination" aria-label="Pagination">
        <button type="button" data-page="${response.page - 1}"${prev ? '' : ' disabled'}>Previous</button>
        <span>Page ${response.page} of ${response.totalPages}</span>
        <button type="button" data-page="${response.page + 1}"${next ? '' : ' disabled'}>Next</button>
      </nav>`;
  },
};

const SORT_OPTIONS = [
  { id: 'relevance', label: 'Relevance' },
  { id: 'best_selling', label: 'Best Selling' },
  { id: 'newest', label: 'Newest' },
  { id: 'price_asc', label: 'Price: Low to High' },
  { id: 'price_desc', label: 'Price: High to Low' },
  { id: 'top_rated', label: 'Top Rated' },
  { id: 'discount', label: '% Off' },
];

export class ResultsWidget {
  constructor(options) {
    this.client = options.client ?? new CompassClient(options);
    this.container = resolve(options.container);
    if (!this.container) throw new Error('ResultsWidget requires a container element');

    this.templates = { ...DEFAULT_TEMPLATES, ...(options.templates ?? {}) };
    this.sortOptions = options.sortOptions ?? SORT_OPTIONS;
    this.productUrl = options.productUrl ?? ((hit) => `/product/${encodeURIComponent(hit.parentId)}`);
    this.currency = options.currency ?? 'USD';
    this.onAddToCart = options.onAddToCart ?? null;
    this.onStateChange = options.onStateChange ?? null;
    this.syncUrl = options.syncUrl !== false;

    this.state = {
      q: options.query ?? '',
      categoryId: options.categoryId ?? null,
      filters: {},
      ranges: [],
      sort: options.sort ?? 'relevance',
      page: 1,
    };
    this.formatter = new Intl.NumberFormat(undefined, { style: 'currency', currency: this.currency });
    this.container.addEventListener('click', (e) => this.handleClick(e));
    this.container.addEventListener('change', (e) => this.handleChange(e));
  }

  money(value) {
    return this.formatter.format(value ?? 0);
  }

  setQuery(q) {
    this.state.q = q;
    this.state.page = 1;
    return this.render();
  }

  setCategory(categoryId) {
    this.state.categoryId = categoryId;
    this.state.page = 1;
    return this.render();
  }

  setFilters(filters) {
    this.state.filters = filters;
    this.state.page = 1;
    return this.render();
  }

  async render() {
    this.container.setAttribute('aria-busy', 'true');
    try {
      const params = {
        q: this.state.q,
        filters: this.state.filters,
        ranges: this.state.ranges,
        sort: this.state.sort,
        page: this.state.page,
      };
      const response = this.state.categoryId
        ? await this.client.browse(this.state.categoryId, params)
        : await this.client.search(params);

      this.response = response;
      if (response.redirect) {
        location.href = response.redirect.url;
        return response;
      }

      const ctx = { productUrl: (h) => this.productUrl(h), money: (v) => this.money(v), sortOptions: this.sortOptions };
      this.container.innerHTML =
        this.templates.header(response, ctx) +
        (response.hits.length
          ? `<div class="compass-grid">${response.hits.map((h, i) => this.templates.hit(h, i, ctx)).join('')}</div>`
          : this.templates.empty(response.query, ctx)) +
        this.templates.pagination(response, ctx);

      if (this.state.q) this.client.rememberSearch(this.state.q);
      if (this.syncUrl) this.writeUrl();
      this.onStateChange?.(response, this.state);
      return response;
    } catch (err) {
      this.client.onError(err);
      throw err;
    } finally {
      this.container.setAttribute('aria-busy', 'false');
    }
  }

  handleClick(event) {
    const cart = event.target.closest('.compass-hit__cart');
    if (cart) {
      const sku = cart.dataset.sku;
      this.client.trackAddToCart(sku, 1, this.state.q);
      this.onAddToCart?.(sku, this.response?.hits.find((h) => h.sku === sku));
      return;
    }
    const pager = event.target.closest('[data-page]');
    if (pager && !pager.disabled) {
      this.state.page = Number(pager.dataset.page);
      void this.render();
      return;
    }
    // Click position is what makes CTR-by-position analysis possible.
    const hit = event.target.closest('.compass-hit');
    if (hit) {
      const position = Number(hit.dataset.position);
      const record = this.response?.hits[position - 1];
      if (record) this.client.trackClick(record, position, this.state.q);
    }
  }

  handleChange(event) {
    const sort = event.target.closest('.compass-sort__select');
    if (!sort) return;
    this.state.sort = sort.value;
    this.state.page = 1;
    void this.render();
  }

  /** Filter state lives in the URL so a filtered grid is shareable. */
  writeUrl() {
    const url = new URL(location.href);
    const params = url.searchParams;
    for (const key of [...params.keys()]) if (key.startsWith('c_')) params.delete(key);
    if (this.state.q) params.set('q', this.state.q); else params.delete('q');
    if (this.state.page > 1) params.set('page', String(this.state.page)); else params.delete('page');
    if (this.state.sort !== 'relevance') params.set('sort', this.state.sort); else params.delete('sort');
    for (const [field, values] of Object.entries(this.state.filters)) {
      if (values?.length) params.set(`c_${field}`, values.join('~'));
    }
    history.replaceState(null, '', url);
  }

  readUrl() {
    const params = new URL(location.href).searchParams;
    this.state.q = params.get('q') ?? this.state.q;
    this.state.page = Number(params.get('page') ?? 1);
    this.state.sort = params.get('sort') ?? this.state.sort;
    this.state.filters = {};
    for (const [key, value] of params) {
      if (key.startsWith('c_')) this.state.filters[key.slice(2)] = value.split('~');
    }
    return this.state;
  }
}

function resolve(target) {
  if (!target) return null;
  return typeof target === 'string' ? document.querySelector(target) : target;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export { esc, SORT_OPTIONS };
