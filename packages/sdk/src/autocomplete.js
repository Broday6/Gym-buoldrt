import { CompassClient } from './client.js';
import { esc } from './results.js';

/**
 * Autocomplete widget.
 *
 * Implements the ARIA combobox pattern properly, because a search box that
 * traps a keyboard user is worse than no autocomplete at all: the input keeps
 * focus at all times, the listbox is referenced by aria-controls, and the
 * active option is pointed at by aria-activedescendant rather than being
 * focused.
 *
 * On narrow screens it becomes a full-screen takeover — the pattern shoppers
 * expect on mobile, and the only way to show product thumbnails without the
 * on-screen keyboard covering them.
 */

const DEFAULTS = {
  minChars: 2,
  debounceMs: 120,
  limit: 6,
  mobileBreakpoint: 640,
  sections: ['suggestions', 'products', 'categories', 'brands'],
  /**
   * Instant search: update the results grid as the shopper types, not only on
   * submit. The dropdown still shows suggestions and categories — the two
   * answer different questions, and a shopper scanning a full grid while
   * refining a query is the behaviour that separates a modern search from a
   * form field.
   */
  instant: true,
};

export class AutocompleteWidget {
  constructor(options) {
    this.client = options.client ?? new CompassClient(options);
    this.input = resolve(options.input);
    if (!this.input) throw new Error('AutocompleteWidget requires an input element');

    this.config = { ...DEFAULTS, ...options };
    this.productUrl = options.productUrl ?? ((p) => `/product/${encodeURIComponent(p.parentId)}`);
    this.categoryUrl = options.categoryUrl ?? ((c) => `/category/${encodeURIComponent(c.id)}`);
    this.searchUrl = options.searchUrl ?? ((q) => `?q=${encodeURIComponent(q)}`);
    this.onSelect = options.onSelect ?? null;
    this.onSubmit = options.onSubmit ?? null;
    this.currency = options.currency ?? 'USD';
    this.formatter = new Intl.NumberFormat(undefined, { style: 'currency', currency: this.currency });

    this.id = `compass-ac-${Math.random().toString(36).slice(2, 8)}`;
    this.open = false;
    this.activeIndex = -1;
    this.items = [];
    this.response = null;
    this.requestSeq = 0;
    this.debounceTimer = null;
    this.controller = null;

    this.buildDom();
    this.bind();
  }

  buildDom() {
    const input = this.input;
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', `${this.id}-listbox`);
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');

    this.root = document.createElement('div');
    this.root.className = 'compass-ac';
    this.root.dataset.state = 'closed';

    this.panel = document.createElement('div');
    this.panel.className = 'compass-ac__panel';
    this.panel.id = `${this.id}-listbox`;
    this.panel.setAttribute('role', 'listbox');
    this.panel.setAttribute('aria-label', 'Search suggestions');

    // On mobile the panel is a takeover, so it needs its own header with a way
    // back out that is not the browser's back button.
    this.header = document.createElement('div');
    this.header.className = 'compass-ac__mobile-header';
    this.header.innerHTML = `
      <button type="button" class="compass-ac__close" aria-label="Close search">&#8592;</button>
      <span class="compass-ac__mobile-title">Search</span>`;

    this.root.append(this.header, this.panel);

    this.live = document.createElement('div');
    this.live.className = 'compass-sr-only';
    this.live.setAttribute('role', 'status');
    this.live.setAttribute('aria-live', 'polite');

    const host = this.config.container ? resolve(this.config.container) : input.parentElement;
    (host ?? document.body).append(this.root, this.live);
  }

  bind() {
    this.input.addEventListener('input', () => this.onInput());
    this.input.addEventListener('focus', () => this.onInput());
    this.input.addEventListener('keydown', (e) => this.onKeyDown(e));
    this.panel.addEventListener('mousedown', (e) => this.onPanelMouseDown(e));
    this.panel.addEventListener('mousemove', (e) => this.onPanelHover(e));
    this.header.querySelector('.compass-ac__close')?.addEventListener('click', () => this.close());

    // A click anywhere else dismisses; blur alone would fire before a click on
    // an option could register.
    this.onDocumentDown = (e) => {
      if (!this.root.contains(e.target) && e.target !== this.input) this.close();
    };
    document.addEventListener('mousedown', this.onDocumentDown);
  }

  destroy() {
    document.removeEventListener('mousedown', this.onDocumentDown);
    this.root.remove();
    this.live.remove();
  }

  get isMobile() {
    return window.innerWidth <= this.config.mobileBreakpoint;
  }

  onInput() {
    const value = this.input.value.trim();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);

    // Below the threshold the box shows recent and trending searches instead of
    // nothing, which is the difference between a dead dropdown and a useful one.
    if (value.length < this.config.minChars) {
      this.debounceTimer = setTimeout(() => this.showEmptyState(), 60);
      return;
    }
    this.debounceTimer = setTimeout(() => this.fetch(value), this.config.debounceMs);
    if (this.config.instant) this.config.onInstant?.(value);
  }

  async showEmptyState() {
    const seq = ++this.requestSeq;
    const recent = this.client.recentSearches(5);
    let trending = [];
    try {
      const response = await this.request('');
      trending = response?.trending ?? [];
      this.response = response;
    } catch {
      // Trending is a nicety; recent searches alone are still worth showing.
    }
    // Dismissed while this was in flight: showing it now would reopen a panel
    // the shopper has already closed.
    if (seq !== this.requestSeq) return;
    if (recent.length === 0 && trending.length === 0) return this.close();
    this.renderEmptyState(recent, trending);
  }

  async fetch(query) {
    const seq = ++this.requestSeq;
    try {
      const response = await this.request(query);
      // A slower earlier request must never overwrite a newer one — and a
      // request that outlived a dismissal must not reopen the panel.
      if (seq !== this.requestSeq) return;
      this.response = response;
      this.render(response);
    } catch (err) {
      if (err?.name !== 'AbortError') this.client.onError(err);
    }
  }

  request(query) {
    this.controller?.abort();
    this.controller = new AbortController();
    return this.client.request(
      '/autocomplete',
      {
        q: query,
        limit: this.config.limit,
        shopperId: this.client.shopperId,
        sessionId: this.client.sessionId,
      },
      this.controller.signal,
    );
  }

  // ---- rendering ---------------------------------------------------------

  renderEmptyState(recent, trending) {
    this.items = [];
    const sections = [];
    if (recent.length) {
      sections.push(this.sectionHtml('Recent searches', recent.map((q) => this.queryItem(q, 'recent'))));
    }
    if (trending.length) {
      sections.push(
        this.sectionHtml('Trending', trending.map((t) => this.queryItem(t.query, 'trending'))),
      );
    }
    this.paint(sections.join(''));
  }

  render(response) {
    this.items = [];
    const sections = [];

    if (response.redirect) {
      sections.push(this.sectionHtml('Go to', [
        this.item(
          { kind: 'redirect', url: response.redirect.url },
          `<span class="compass-ac__go">${esc(response.redirect.label || response.redirect.url)}</span>`,
        ),
      ]));
    }

    if (this.config.sections.includes('suggestions') && response.suggestions?.length) {
      sections.push(this.sectionHtml(
        'Suggestions',
        response.suggestions.map((s) => this.queryItem(s.query, 'suggestion', response.query)),
      ));
    }

    if (this.config.sections.includes('products') && response.products?.length) {
      sections.push(this.sectionHtml('Products', response.products.map((p) => this.productItem(p))));
    }

    // Selecting a category goes to the category page, not a search results page.
    if (this.config.sections.includes('categories') && response.categories?.length) {
      sections.push(this.sectionHtml('Categories', response.categories.map((c) => this.item(
        { kind: 'category', category: c, url: this.categoryUrl(c) },
        `<span class="compass-ac__label">${highlightMatch(c.label, response.query)}</span>
         <span class="compass-ac__count">${c.products}</span>`,
      ))));
    }

    if (this.config.sections.includes('brands') && response.brands?.length) {
      sections.push(this.sectionHtml('Brands', response.brands.map((b) => this.item(
        { kind: 'brand', brand: b, url: this.searchUrl(b.name) },
        `<span class="compass-ac__label">${highlightMatch(b.name, response.query)}</span>
         <span class="compass-ac__count">${b.products}</span>`,
      ))));
    }

    if (sections.length === 0) {
      this.paint(`<p class="compass-ac__none">No suggestions for <strong>${esc(response.query)}</strong></p>`);
      this.announce('No suggestions');
      return;
    }

    this.paint(sections.join(''));
    this.announce(`${this.items.length} suggestions available`);
  }

  paint(html) {
    this.panel.innerHTML = html;
    this.activeIndex = -1;
    this.input.removeAttribute('aria-activedescendant');
    this.show();
  }

  sectionHtml(title, items) {
    return `<div class="compass-ac__section" role="group" aria-label="${esc(title)}">
      <p class="compass-ac__section-title">${esc(title)}</p>
      ${items.join('')}
    </div>`;
  }

  queryItem(query, kind, highlightOf) {
    return this.item(
      { kind: 'query', query, url: this.searchUrl(query) },
      `<svg class="compass-ac__icon" viewBox="0 0 16 16" aria-hidden="true">
         <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.6"/>
         <path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
       </svg>
       <span class="compass-ac__label">${highlightOf ? highlightMatch(query, highlightOf) : esc(query)}</span>
       ${kind === 'recent' ? '<span class="compass-ac__meta">recent</span>' : ''}`,
    );
  }

  productItem(product) {
    return this.item(
      { kind: 'product', product, url: this.productUrl(product) },
      `<span class="compass-ac__thumb">${
        product.image
          ? `<img src="${esc(product.image)}" alt="" loading="lazy">`
          : '<span class="compass-ac__thumb-empty" aria-hidden="true"></span>'
      }</span>
       <span class="compass-ac__product">
         <span class="compass-ac__label">${product.highlighted ?? esc(product.title)}</span>
         ${product.variantTitle ? `<span class="compass-ac__meta">${esc(product.variantTitle)}</span>` : ''}
       </span>
       <span class="compass-ac__price">${
         product.price > 0 ? this.formatter.format(product.price) : '—'
       }</span>`,
    );
  }

  item(payload, inner) {
    const index = this.items.length;
    this.items.push(payload);
    return `<div class="compass-ac__item" role="option" id="${this.id}-opt-${index}"
      data-index="${index}" aria-selected="false">${inner}</div>`;
  }

  // ---- interaction -------------------------------------------------------

  onKeyDown(event) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.move(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.move(-1);
        break;
      case 'Home':
        if (!this.open) return;
        event.preventDefault();
        this.setActive(0);
        break;
      case 'End':
        if (!this.open) return;
        event.preventDefault();
        this.setActive(this.items.length - 1);
        break;
      case 'Enter':
        if (this.open && this.activeIndex >= 0) {
          event.preventDefault();
          this.select(this.items[this.activeIndex]);
        } else {
          this.submit();
        }
        break;
      case 'Escape':
        if (this.open) {
          event.preventDefault();
          this.close();
        }
        break;
      case 'Tab':
        this.close();
        break;
      default:
        break;
    }
  }

  move(delta) {
    if (!this.open) {
      this.onInput();
      return;
    }
    if (this.items.length === 0) return;
    // Wrap around, and treat -1 as "back in the input" at the top edge.
    const next = this.activeIndex + delta;
    if (next < 0) this.setActive(this.items.length - 1);
    else if (next >= this.items.length) this.setActive(0);
    else this.setActive(next);
  }

  setActive(index) {
    const previous = this.panel.querySelector('[aria-selected="true"]');
    if (previous) previous.setAttribute('aria-selected', 'false');
    this.activeIndex = index;
    const element = this.panel.querySelector(`[data-index="${index}"]`);
    if (!element) return;
    element.setAttribute('aria-selected', 'true');
    this.input.setAttribute('aria-activedescendant', element.id);
    element.scrollIntoView({ block: 'nearest' });
  }

  onPanelMouseDown(event) {
    const element = event.target.closest('[data-index]');
    if (!element) return;
    // Prevent the input losing focus before the selection is handled.
    event.preventDefault();
    this.select(this.items[Number(element.dataset.index)]);
  }

  onPanelHover(event) {
    const element = event.target.closest('[data-index]');
    if (element) this.setActive(Number(element.dataset.index));
  }

  select(payload) {
    if (!payload) return;
    this.close();
    if (payload.kind === 'query') {
      this.input.value = payload.query;
      this.client.rememberSearch(payload.query);
    }
    if (payload.kind === 'product') {
      this.client.track('click', {
        sku: payload.product.sku,
        parentId: payload.product.parentId,
        query: this.input.value,
        analyticsTags: ['autocomplete'],
      });
    }
    if (this.onSelect?.(payload) === false) return;
    if (payload.kind === 'query') this.submit();
    else if (payload.url) window.location.href = payload.url;
  }

  submit() {
    const query = this.input.value.trim();
    this.close();
    if (!query) return;
    this.client.rememberSearch(query);
    if (this.onSubmit?.(query) === false) return;
    window.location.href = this.searchUrl(query);
  }

  show() {
    if (this.open) return;
    this.open = true;
    this.root.dataset.state = 'open';
    this.input.setAttribute('aria-expanded', 'true');
    if (this.isMobile) document.body.classList.add('compass-ac-locked');
  }

  close() {
    // Cancelled unconditionally, even when the panel is already shut: work
    // scheduled by the last keystroke would otherwise land afterwards and
    // reopen it. On mobile that is not a cosmetic flicker — the panel is a
    // full-screen takeover that re-locks the page behind it, so a shopper who
    // cleared the box and tapped back ended up trapped in it.
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    // In-flight requests resolve after close too. Bumping the sequence is what
    // tells them to discard their result rather than render it.
    this.requestSeq++;
    this.controller?.abort();

    if (!this.open) return;
    this.open = false;
    this.root.dataset.state = 'closed';
    this.activeIndex = -1;
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
    document.body.classList.remove('compass-ac-locked');
  }

  announce(message) {
    this.live.textContent = message;
  }
}

/** Bold the typed portion of a suggestion so the difference is visible. */
function highlightMatch(text, query) {
  const safe = esc(text);
  if (!query) return safe;
  const index = safe.toLowerCase().indexOf(esc(query).toLowerCase());
  if (index < 0) return safe;
  const end = index + query.length;
  return `${safe.slice(0, index)}<mark>${safe.slice(index, end)}</mark>${safe.slice(end)}`;
}

function resolve(target) {
  if (!target) return null;
  return typeof target === 'string' ? document.querySelector(target) : target;
}
