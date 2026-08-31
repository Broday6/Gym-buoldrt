/**
 * Server-rendered fallback for a category or collection page.
 *
 * §4.11 asks for a crawlable page. This takes the storefront's own HTML and
 * injects three things a crawler needs and a JavaScript application cannot
 * provide before it runs:
 *
 *   - the head directives — canonical, robots, title, description — so the URL
 *     is classified correctly whether or not the script executes;
 *   - schema.org ItemList as JSON-LD, so the products are machine-readable;
 *   - the products themselves, as ordinary anchors and paginated links, inside
 *     the container the client app renders into.
 *
 * The client app replaces that container on load, so this is what is true for
 * the first paint and for anything that never runs the script. It is
 * deliberately the same URL as the interactive page rather than a separate
 * crawler-only view: a page served only to crawlers is cloaking, and a page
 * served only to browsers is invisible.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SearchRequest, SearchResponse } from '@compass/shared';
import type { SiteConfig } from '@compass/shared';

const esc = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const money = (n: number, currency: string) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n);

let template: string | null = null;

export function renderCrawlablePage(
  site: SiteConfig,
  request: SearchRequest,
  response: SearchResponse,
  demoDir: string,
): string {
  template ??= readFileSync(join(demoDir, 'index.html'), 'utf8');
  const seo = response.seo;
  const page = request.page ?? 1;
  const path = request.collection
    ? `/demo/collections/${encodeURIComponent(request.collection)}`
    : `/demo/c/${encodeURIComponent(request.categoryId ?? '')}`;
  const pageUrl = (n: number) => `${path}?site=${encodeURIComponent(site.id)}${n > 1 ? `&page=${n}` : ''}`;

  const head = [
    seo ? `<link rel="canonical" href="${esc(seo.canonical)}">` : '',
    seo ? `<meta name="robots" content="${esc(seo.robots)}">` : '',
    seo ? `<meta name="description" content="${esc(seo.description)}">` : '',
    // Prev/next are advisory to crawlers now rather than directives, but they
    // are still how a reader-mode or a non-JS client walks the set.
    page > 1 ? `<link rel="prev" href="${esc(pageUrl(page - 1))}">` : '',
    page < response.totalPages ? `<link rel="next" href="${esc(pageUrl(page + 1))}">` : '',
    seo ? `<script type="application/ld+json">${JSON.stringify(seo.jsonLd)
      // A closing tag inside JSON would end the script element early.
      .replace(/</g, '\\u003c')}</script>` : '',
  ].filter(Boolean).join('\n  ');

  const heading = request.collection ?? request.categoryId ?? '';
  const products = response.hits.map((hit) => `
      <li class="ssr-hit">
        <a href="/demo/#product/${esc(hit.parentId)}">
          ${hit.image ? `<img src="${esc(hit.image)}" alt="" width="120" height="120" loading="lazy">` : ''}
          <span class="ssr-hit__title">${esc(hit.title)}</span>
        </a>
        ${hit.variantTitle ? `<span class="ssr-hit__variant">${esc(hit.variantTitle)}</span>` : ''}
        <span class="ssr-hit__price">${esc(money(hit.effectivePrice, site.currency))}</span>
      </li>`).join('');

  const pagination = response.totalPages > 1 ? `
      <nav class="ssr-pages" aria-label="Pagination">
        ${page > 1 ? `<a rel="prev" href="${esc(pageUrl(page - 1))}">Previous</a>` : ''}
        <span>Page ${page} of ${response.totalPages}</span>
        ${page < response.totalPages ? `<a rel="next" href="${esc(pageUrl(page + 1))}">Next</a>` : ''}
      </nav>` : '';

  // Every page link is a real anchor, so a crawler reaches every product in the
  // set without executing anything.
  const fallback = `
    <div id="ssr">
      <h1 class="ssr-title">${esc(seo?.title ?? heading)}</h1>
      <p class="ssr-count">${response.totalHits.toLocaleString()} products</p>
      <ul class="ssr-grid">${products}</ul>
      ${pagination}
    </div>`;

  return template
    .replace('</head>', `  ${head}\n</head>`)
    .replace(seo ? /<title>[^<]*<\/title>/ : /$^/, `<title>${esc(seo?.title ?? '')}</title>`)
    .replace('<div id="results"></div>', `<div id="results">${fallback}</div>`);
}
