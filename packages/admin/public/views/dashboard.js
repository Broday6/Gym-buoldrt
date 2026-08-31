import { api, esc, money, num, pct, sparkline, table, toast } from '../lib.js';

/**
 * Dashboard.
 *
 * Every table here ends in an action. A zero-result query is only interesting
 * if a merchandiser can fix it from the row it appears in — so the problem
 * queries table carries "add synonym" and "add redirect" inline, pre-filled with
 * the query, which is the loop the whole product exists to close.
 */
export const dashboard = {
  title: 'Dashboard',
  subtitle: 'What shoppers searched for, and what search did about it.',

  actions: () => `
    <select id="range" class="btn" aria-label="Date range">
      <option value="7">Last 7 days</option>
      <option value="30" selected>Last 30 days</option>
      <option value="90">Last 90 days</option>
    </select>
    <button class="btn" id="rollup">Refresh aggregates</button>`,

  async render(root) {
    root.innerHTML = '<p class="empty">Loading…</p>';
    const days = Number(document.querySelector('#range')?.value ?? 30);

    const [overview, series, problems, top, trends, facets] = await Promise.all([
      api(`/analytics/overview?days=${days}`),
      api(`/analytics/timeseries?days=${days}`),
      api(`/analytics/problems?days=${days}&limit=12`),
      api(`/analytics/queries?days=${days}&limit=12`),
      api('/analytics/trending?days=7'),
      api(`/analytics/facets?days=${days}`),
    ]);

    const zeroTone = overview.quality.zeroResultRate > 8 ? 'stat--warn' : 'stat--ok';

    root.innerHTML = `
      <div class="stats">
        <div class="stat">
          <p class="stat__label">Searches</p>
          <p class="stat__value">${num(overview.volume.searches)}</p>
          <p class="stat__note">${num(overview.volume.uniqueQueries)} unique ·
            ${overview.volume.searchesPerSession} per session</p>
        </div>
        <div class="stat ${zeroTone}">
          <p class="stat__label">Zero-result rate</p>
          <p class="stat__value">${pct(overview.quality.zeroResultRate)}</p>
          <p class="stat__note">${pct(overview.quality.rescueRate)} rescued ·
            ${overview.quality.avgResults} results avg</p>
        </div>
        <div class="stat">
          <p class="stat__label">Click-through</p>
          <p class="stat__value">${pct(overview.engagement.clickThroughRate)}</p>
          <p class="stat__note">avg position ${overview.engagement.avgClickPosition} ·
            ${pct(overview.engagement.searchToCartRate)} to cart</p>
        </div>
        <div class="stat stat--ok">
          <p class="stat__label">Search-attributed revenue</p>
          <p class="stat__value">${money(overview.revenue.searchAttributedRevenue)}</p>
          <p class="stat__note">${money(overview.revenue.revenuePerSearch)} per search ·
            ${pct(overview.revenue.conversionRate)} of searching sessions convert</p>
        </div>
      </div>

      <div class="card">
        <div class="card__head">
          <h2 class="card__title">Daily volume and failure rate</h2>
          <p class="card__hint">Failures rising faster than traffic is the signal worth watching.</p>
        </div>
        ${sparkline(series.points)}
      </div>

      <div class="card">
        <div class="card__head">
          <h2 class="card__title">Queries that need attention</h2>
          <p class="card__hint">Found nothing, or nearly nothing. Fix from the row.</p>
        </div>
        ${table(
          [{ label: 'Query' }, { label: 'Searches', numeric: true },
           { label: 'Avg results', numeric: true }, { label: 'Zero', numeric: true },
           { label: 'CTR', numeric: true }, { label: 'Fix' }],
          problems.queries,
          (q) => `<tr>
            <td class="mono">${esc(q.query)}</td>
            <td class="num">${num(q.searches)}</td>
            <td class="num">${q.avgResults}</td>
            <td class="num">${q.zeroResults ? `<span class="pill pill--warn">${num(q.zeroResults)}</span>` : '—'}</td>
            <td class="num">${pct(q.clickThroughRate)}</td>
            <td>
              <button class="btn btn--sm" data-needs="merchandiser" data-fix="synonym" data-q="${esc(q.query)}">Add synonym</button>
              <button class="btn btn--sm" data-fix="redirect" data-q="${esc(q.query)}">Redirect</button>
              <button class="btn btn--sm" data-fix="test" data-q="${esc(q.query)}">Test</button>
            </td>
          </tr>`,
          'No failing queries in this window. That is the goal.',
        )}
      </div>

      <div class="split">
        <div class="card">
          <div class="card__head">
            <h2 class="card__title">Top queries</h2>
            <a class="card__hint" href="/v1/${esc(location.pathname.includes('admin') ? '' : '')}"
               id="export-top">Export CSV</a>
          </div>
          ${table(
            [{ label: 'Query' }, { label: 'Searches', numeric: true },
             { label: 'CTR', numeric: true }, { label: 'Revenue', numeric: true }],
            top.queries,
            (q) => `<tr>
              <td class="mono">${esc(q.query)}</td>
              <td class="num">${num(q.searches)}</td>
              <td class="num">${pct(q.clickThroughRate)}</td>
              <td class="num">${money(q.revenue)}</td>
            </tr>`,
          )}
        </div>

        <div>
          <div class="card">
            <div class="card__head"><h2 class="card__title">Trending up</h2></div>
            ${table(
              [{ label: 'Query' }, { label: 'Change', numeric: true }],
              trends.rising.slice(0, 6),
              (t) => `<tr>
                <td class="mono">${esc(t.query)}</td>
                <td class="num up">+${t.changePct}%</td>
              </tr>`,
              'Not enough history yet.',
            )}
          </div>
          <div class="card">
            <div class="card__head">
              <h2 class="card__title">Filter usage</h2>
              <p class="card__hint">Retire what nobody touches.</p>
            </div>
            ${table(
              [{ label: 'Filter' }, { label: 'Uses', numeric: true }],
              facets.facets.slice(0, 8),
              (f) => `<tr>
                <td>${esc(f.field)}: <strong>${esc(f.value)}</strong></td>
                <td class="num">${num(f.applications)}</td>
              </tr>`,
              'No filters applied in this window.',
            )}
          </div>
        </div>
      </div>`;
  },

  /** Wired by the shell after render; returns true if it handled the event. */
  async onClick(event, navigate) {
    const fix = event.target.closest('[data-fix]');
    if (!fix) return false;
    const query = fix.dataset.q;

    if (fix.dataset.fix === 'test') {
      navigate('tester', { q: query });
      return true;
    }
    if (fix.dataset.fix === 'synonym') {
      // Pre-filled and one keystroke from done: the whole point of closing the
      // loop is that the fix happens where the problem was noticed.
      const terms = prompt(`"${query}" found nothing.\n\nWhat should it also search for? (comma separated)`);
      if (!terms) return true;
      await api('/synonyms', {
        body: {
          kind: 'two_way',
          terms: [query, ...terms.split(',').map((t) => t.trim()).filter(Boolean)],
          note: `created from the dashboard for "${query}"`,
        },
      });
      toast(`"${query}" now also searches for ${terms}. Live on the next query.`);
      return true;
    }
    if (fix.dataset.fix === 'redirect') {
      const url = prompt(`Send "${query}" to which URL?`, '/pages/');
      if (!url) return true;
      await api('/redirects', {
        body: { pattern: query, matchType: 'exact', url, label: query },
      });
      toast(`"${query}" now redirects to ${url}.`);
      return true;
    }
    return false;
  },

  async onAction(event, rerender) {
    if (event.target.id === 'rollup') {
      event.target.disabled = true;
      const result = await api('/analytics/rollup', { body: { days: 30 } });
      toast(`Aggregated ${num(result.events)} events.`);
      event.target.disabled = false;
      await rerender();
      return true;
    }
    if (event.target.id === 'range') {
      await rerender();
      return true;
    }
    return false;
  },
};
