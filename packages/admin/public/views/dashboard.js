import { api, esc, money, num, pct, sparkline, state, table, toast } from '../lib.js';

/**
 * Dashboard.
 *
 * Every table here ends in an action. A zero-result query is only interesting
 * if a merchandiser can fix it from the row it appears in — so the problem
 * queries table carries "add synonym" and "add redirect" inline, pre-filled with
 * the query, which is the loop the whole product exists to close.
 */
/**
 * The state of the index, and whether anything is wrong with it.
 *
 * A failed run is shown as a banner rather than a field, because it invalidates
 * every other figure on the page: the numbers below describe whatever was last
 * indexed successfully, not the catalogue as it stands.
 */
/**
 * A tick a person can tell apart.
 *
 * Several runs commonly land on one day, and eight bars all labelled with the
 * same date is a chart that cannot be read. When the window is inside a day the
 * tick shows the time instead.
 */
function tick(when, runs) {
  const day = (d) => new Date(d).toDateString();
  const sameDay = new Set(runs.map((r) => day(r.started_at))).size <= 1;
  const d = new Date(when);
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
}

function indexing(status) {
  if (!status) return '';
  const runs = status.runs ?? [];
  const failed = runs.find((r) => r.status === 'error');
  const last = runs.find((r) => r.status !== 'error');
  const history = runs.filter((r) => r.status !== 'error').slice(0, 8).reverse();
  const peak = Math.max(1, ...history.map((r) => r.variants ?? 0));

  // With one run there is no history to draw, and an empty column beside the
  // facts reads as something that failed to load rather than something that
  // does not exist yet.
  const hasHistory = history.length > 1;

  return `
    ${failed ? `
      <div class="banner banner--error" role="status">
        <strong>Indexing failed — ${esc(new Date(failed.started_at).toLocaleDateString())}</strong>
        <p>${esc(failed.error || 'An unknown error occurred.')} Everything below describes the last
        index that succeeded.</p>
      </div>` : ''}
    <div class="card index${hasHistory ? '' : ' index--solo'}">
      <div class="index__facts">
        <div class="card__head">
          <h2 class="card__title">Product data</h2>
        </div>
        <p class="index__label">Last updated</p>
        <p class="index__value">${last
          ? esc(new Date(last.started_at).toLocaleString(undefined,
              { dateStyle: 'medium', timeStyle: 'short' }))
          : 'Never'}</p>
        <p class="index__label">Searchable now</p>
        <p class="index__value">${num(status.documents)}
          <span class="index__unit">product options</span></p>
        <button class="btn btn--primary" id="reindex-now" data-needs="admin">Update now</button>
      </div>
      ${hasHistory ? `
      <div class="index__history">
        <p class="index__label">Recent size</p>
        ${`
          <div class="bars">
            ${history.map((r) => `
              <div class="bars__col" title="${esc(new Date(r.started_at).toLocaleString())} — ${num(r.variants)} variants">
                <div class="bars__bar" style="height:${Math.round(((r.variants ?? 0) / peak) * 100)}%"></div>
                <span class="bars__tick">${esc(tick(r.started_at, history))}</span>
              </div>`).join('')}
          </div>`}
      </div>` : ''}
    </div>`;
}

export const dashboard = {
  title: 'Dashboard',
  subtitle: 'What shoppers searched for, and what search did about it.',

  actions: () => '<button class="btn" id="rollup" data-needs="merchandiser">Refresh numbers</button>',

  async render(root) {
    root.innerHTML = '<p class="empty">Loading…</p>';
    const days = state.days;

    // Indexing sits above everything: a stale or failed index makes every other
    // number on this page a report about yesterday's catalogue.
    const [status, overview, series, problems, top, trends, facets] = await Promise.all([
      api('/catalog/status').catch(() => null),
      api(`/analytics/overview?days=${days}`),
      api(`/analytics/timeseries?days=${days}`),
      api(`/analytics/problems?days=${days}&limit=12`),
      api(`/analytics/queries?days=${days}&limit=12`),
      api('/analytics/trending?days=7'),
      api(`/analytics/facets?days=${days}`),
    ]);

    // A number on its own does not tell anyone whether to act. Every headline
    // gets a plain reading of what it counts and, where there is a defensible
    // target, whether this one is good.
    const zero = overview.quality.zeroResultRate;
    const zeroTone = zero > 12 ? 'stat--warn' : zero > 5 ? '' : 'stat--ok';
    const zeroRead = zero > 12
      ? 'Higher than most stores — worth fixing'
      : zero > 5 ? 'About normal for a store this size' : 'Better than most stores';
    const failed = Math.round(overview.volume.searches * zero / 100);
    const ctr = overview.engagement.clickThroughRate;

    root.innerHTML = `
      ${indexing(status)}
      <div class="stats">
        <div class="stat">
          <p class="stat__label">Searches</p>
          <p class="stat__value">${num(overview.volume.searches)}</p>
          <p class="stat__note">${num(overview.volume.uniqueQueries)} different searches ·
            ${overview.volume.searchesPerSession} per visit</p>
        </div>
        <div class="stat ${zeroTone}">
          <p class="stat__label">Searches that found nothing</p>
          <p class="stat__value">${pct(zero)}</p>
          <p class="stat__note">${num(failed)} of ${num(overview.volume.searches)} ·
            ${pct(overview.quality.rescueRate)} of those were rescued</p>
          <p class="stat__read">${zeroRead}</p>
        </div>
        <div class="stat ${ctr >= 30 ? 'stat--ok' : ''}">
          <p class="stat__label">Searches that led to a click</p>
          <p class="stat__value">${pct(ctr)}</p>
          <p class="stat__note">Usually the ${overview.engagement.avgClickPosition}th result ·
            ${pct(overview.engagement.searchToCartRate)} reached the cart</p>
          <p class="stat__read">${ctr >= 30
            ? 'Shoppers are finding what they came for'
            : 'Shoppers are looking and not choosing'}</p>
        </div>
        <div class="stat stat--ok">
          <p class="stat__label">Revenue from search</p>
          <p class="stat__value">${money(overview.revenue.searchAttributedRevenue)}</p>
          <p class="stat__note">${money(overview.revenue.revenuePerSearch)} per search ·
            ${pct(overview.revenue.conversionRate)} of searching visits buy</p>
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
           { label: 'Results shown', numeric: true }, { label: 'Found nothing', numeric: true },
           { label: 'Led to a click', numeric: true }, { label: 'Fix' }],
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
             { label: 'Led to a click', numeric: true }, { label: 'Revenue', numeric: true }],
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
    if (event.target.id === 'reindex-now') {
      navigate('data');
      return true;
    }
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
