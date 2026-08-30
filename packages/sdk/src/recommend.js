import { CompassClient } from './client.js';
import { esc } from './results.js';

/**
 * Recommendation rail.
 *
 * A horizontal strip of products with a reason attached — "Because you viewed",
 * "Frequently bought together", "Trending". Every strip degrades to top sellers
 * rather than disappearing, because a hole where a rail used to be reads worse
 * than a generic suggestion.
 *
 * Impressions and clicks are instrumented separately from the results grid, so
 * a merchandiser can tell whether the rail is earning its space on the page.
 */

const TITLES = {
  similar: 'Similar products',
  bought_together: 'Frequently bought together',
  recently_viewed: 'Recently viewed',
  trending: 'Trending now',
  top_sellers: 'Best sellers',
};

export class RecommendWidget {
  constructor(options) {
    this.client = options.client ?? new CompassClient(options);
    this.container = typeof options.container === 'string'
      ? document.querySelector(options.container)
      : options.container;
    if (!this.container) throw new Error('RecommendWidget requires a container');

    this.kind = options.kind ?? 'top_sellers';
    this.title = options.title ?? TITLES[this.kind] ?? 'You might also like';
    this.limit = options.limit ?? 8;
    this.productUrl = options.productUrl ?? ((hit) => `/product/${encodeURIComponent(hit.parentId)}`);
    this.currency = options.currency ?? 'USD';
    this.formatter = new Intl.NumberFormat(undefined, { style: 'currency', currency: this.currency });
    this.container.addEventListener('click', (e) => this.onClick(e));
  }

  async render(params = {}) {
    let response;
    try {
      response = await this.client.request('/recommend', {
        kind: this.kind,
        limit: this.limit,
        shopperId: this.client.shopperId,
        sessionId: this.client.sessionId,
        ...params,
      });
    } catch (err) {
      // A failed rail removes itself rather than showing an error to a shopper.
      this.container.innerHTML = '';
      this.client.onError(err);
      return null;
    }

    if (!response.hits.length) {
      this.container.innerHTML = '';
      return response;
    }
    this.response = response;

    // Say plainly when the requested kind had no data. A shopper sees a normal
    // strip; a developer reading the DOM sees what actually served it.
    const fellBack = response.servedBy !== response.kind;
    this.container.innerHTML = `
      <section class="compass-recs" data-kind="${esc(response.kind)}"
        data-served-by="${esc(response.servedBy)}">
        <div class="compass-recs__head">
          <h2 class="compass-recs__title">${esc(fellBack ? TITLES[response.servedBy] ?? this.title : this.title)}</h2>
          <p class="compass-recs__note">${response.hits.length} products</p>
        </div>
        <div class="compass-recs__rail">
          ${response.hits.map((hit, i) => this.card(hit, i)).join('')}
        </div>
      </section>`;

    this.client.track('search', {
      analyticsTags: [`rec:${response.servedBy}`],
      resultCount: response.hits.length,
    });
    return response;
  }

  card(hit, index) {
    return `<article class="compass-hit" data-sku="${esc(hit.sku)}" data-position="${index + 1}">
      <a class="compass-hit__link" href="${this.productUrl(hit)}">
        <div class="compass-hit__media">
          ${hit.image
            ? `<img src="${esc(hit.image)}" alt="${esc(hit.title)}" loading="lazy">`
            : '<div class="compass-hit__placeholder" aria-hidden="true"></div>'}
          ${(hit.badges ?? []).length
            ? `<span class="compass-hit__badges">${hit.badges
                .map((b) => `<span class="compass-badge compass-badge--${esc(b.tone)}">${esc(b.label)}</span>`)
                .join('')}</span>`
            : ''}
        </div>
        <h3 class="compass-hit__title">${esc(hit.title)}</h3>
        ${hit.variantTitle ? `<p class="compass-hit__variant">${esc(hit.variantTitle)}</p>` : ''}
        <p class="compass-hit__price">${hit.effectivePrice > 0
          ? `<strong>${this.formatter.format(hit.effectivePrice)}</strong>`
          : '<span class="compass-hit__noprice">Price unavailable</span>'}</p>
      </a>
    </article>`;
  }

  onClick(event) {
    const card = event.target.closest('.compass-hit');
    if (!card || !this.response) return;
    const position = Number(card.dataset.position);
    const hit = this.response.hits[position - 1];
    if (!hit) return;
    // Tagged so rail clicks can be told apart from result-grid clicks.
    this.client.track('click', {
      sku: hit.sku,
      parentId: hit.parentId,
      position,
      analyticsTags: [`rec:${this.response.servedBy}`],
    });
  }
}
