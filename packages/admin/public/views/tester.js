import { api, badgeChips, debounce, esc, money, num, pct, table, toast } from '../lib.js';

/**
 * Query tester.
 *
 * The persistent "what would a shopper see" panel, with the explainability
 * toggle. A merchandiser's most common question is "why is that product third?"
 * and the honest answer is a cascade, not a score — so this shows the criteria
 * in the order they were applied and marks the one that actually decided.
 */
export const tester = {
  title: 'Query tester',
  subtitle: 'See exactly what a shopper sees, and why each product ranks where it does.',

  actions: () => `
    <label class="pill"><input type="checkbox" id="explain" checked> Explain ranking</label>
    <a class="btn" id="open-storefront" target="_blank" rel="noopener">Open in storefront</a>`,

  state: { q: '', response: null },

  async render(root, params = {}) {
    if (params.q !== undefined) tester.state.q = params.q;
    root.innerHTML = `
      <div class="card">
        <div class="row">
          <label class="field grow">
            <span>Query</span>
            <input id="q" value="${esc(tester.state.q)}" placeholder="try: chandaleer, black shutter, 4x6 beam 12ft, returns">
          </label>
          <label class="field">
            <span>Sort</span>
            <select id="sort">
              <option value="relevance">Relevance</option>
              <option value="best_selling">Best Selling</option>
              <option value="newest">Newest</option>
              <option value="price_asc">Price ↑</option>
              <option value="price_desc">Price ↓</option>
            </select>
          </label>
          <label class="field">
            <span>Collection</span>
            <select id="collection"><option value="">— none —</option></select>
          </label>
        </div>
      </div>
      <div id="out"></div>`;

    const collections = await api('/collections').catch(() => ({ collections: [] }));
    const select = root.querySelector('#collection');
    for (const c of collections.collections ?? []) {
      select.insertAdjacentHTML('beforeend', `<option value="${esc(c.slug)}">${esc(c.name)}</option>`);
    }

    const run = debounce(() => tester.run(root), 200);
    root.querySelector('#q').addEventListener('input', run);
    root.querySelector('#sort').addEventListener('change', () => tester.run(root));
    select.addEventListener('change', () => tester.run(root));
    document.querySelector('#explain')?.addEventListener('change', () => tester.run(root));

    await tester.run(root);
    root.querySelector('#q').focus();
  },

  async run(root) {
    const q = root.querySelector('#q').value;
    tester.state.q = q;
    const explain = document.querySelector('#explain')?.checked ?? true;
    const out = root.querySelector('#out');

    const storefront = document.querySelector('#open-storefront');
    if (storefront) storefront.href = `/demo/?q=${encodeURIComponent(q)}`;

    let response;
    try {
      response = await api('/search', {
        body: {
          q,
          sort: root.querySelector('#sort').value,
          collection: root.querySelector('#collection').value || undefined,
          hitsPerPage: 24,
          explain,
        },
      });
    } catch (err) {
      out.innerHTML = `<p class="empty">${esc(err.message)}</p>`;
      return;
    }
    tester.state.response = response;

    if (response.redirect) {
      out.innerHTML = `<div class="card"><p><span class="pill pill--ok">redirect</span>
        This query never reaches search — a rule sends the shopper to
        <span class="mono">${esc(response.redirect.url)}</span>.</p></div>`;
      return;
    }

    const notes = [
      `<span class="pill">${esc(response.queryType)} query</span>`,
      `<span class="pill">searched <span class="mono">${esc(response.effectiveQuery || '—')}</span></span>`,
      `<span class="pill">${num(response.totalHits)} products</span>`,
      `<span class="pill pill--ok">${response.processingTimeMs}ms</span>`,
    ];
    if (response.rescue) {
      notes.push(`<span class="pill pill--warn">rescued: ${esc(response.rescue.strategy)}</span>`);
    }
    if (response.rulesApplied?.length) {
      notes.push(`<span class="pill pill--ok">${esc(response.rulesApplied.join(', '))}</span>`);
    }
    if (response.parsedFilters?.length) {
      notes.push(`<span class="pill">parsed ${esc(
        response.parsedFilters.map((f) => `${f.field}=${f.value}`).join(' '))}</span>`);
    }
    if (response.reachableHits) {
      notes.push(`<span class="pill">paging capped at ${num(response.reachableHits)}</span>`);
    }

    out.innerHTML = `
      <div class="card">
        <div class="row" style="gap:6px">${notes.join('')}</div>
      </div>
      <div class="split">
        <div class="card">
          <div class="card__head">
            <h2 class="card__title">Results</h2>
            <p class="card__hint">${explain ? 'Hover a card for the full cascade.' : ''}</p>
          </div>
          <div class="preview">
            ${response.hits.map((hit, i) => tester.card(hit, i, explain)).join('') ||
              '<p class="empty">Nothing matched, and nothing rescued it.</p>'}
          </div>
        </div>
        <div class="card">
          <div class="card__head"><h2 class="card__title">Facets returned</h2></div>
          ${table(
            [{ label: 'Facet' }, { label: 'Values', numeric: true }],
            response.facets,
            (f) => `<tr>
              <td>${esc(f.label)}${f.custom ? ' <span class="pill pill--ok">custom</span>' : ''}</td>
              <td class="num">${f.stats
                ? `${money(f.stats.min)}–${money(f.stats.max)}`
                : num(f.values.length)}</td>
            </tr>`,
            'No facets on this query.',
          )}
        </div>
      </div>`;
  },

  card(hit, index, explain) {
    const e = hit.explanation;
    return `<article class="pv">
      <span class="pv__pos">${index + 1}</span>
      ${hit.image ? `<img src="${esc(hit.image)}" alt="" loading="lazy">` : '<div style="aspect-ratio:1;background:var(--surface)"></div>'}
      <div class="pv__body">
        <span class="pv__title">${esc(hit.title)}</span>
        <span class="pv__meta">${esc(hit.variantTitle || '')}</span>
        <span class="pv__meta">${hit.effectivePrice > 0 ? money(hit.effectivePrice) : 'no price'} ·
          ${esc(hit.sku)}</span>
        ${badgeChips(hit.badges)}
        ${explain && e ? `<div class="pv__why">${tester.why(e)}</div>` : ''}
      </div>
    </article>`;
  },

  /**
   * The cascade, in the order it was applied.
   *
   * Ranking is a tie-breaking cascade, not a blended score, so this reports
   * each criterion rather than one number — "it won on words matched" is a
   * checkable statement in a way that "0.87" never is.
   */
  why(e) {
    const rows = [
      ['typos', e.typos],
      ['words', e.wordsMatched],
      ['field', `${e.bestField || '—'} (w${e.bestFieldWeight})`],
      ['proximity', e.proximity],
      ['exactness', e.exactness],
      ['business', e.businessScore],
    ];
    const breakdown = Object.entries(e.businessBreakdown ?? {})
      .map(([k, v]) => `${k} ${v}`).join(' · ');
    return rows.map(([k, v]) => `${k}: ${esc(String(v))}`).join('<br>') +
      (breakdown ? `<br><span class="pv__breakdown">${esc(breakdown)}</span>` : '');
  },
};
