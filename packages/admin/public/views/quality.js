import { api, esc, num, pct, state, table, toast } from '../lib.js';

/**
 * Search quality.
 *
 * A search that returns products and gets no click is a failure nobody
 * reports. It is also the one that hides: zero results are obvious and get
 * fixed, while "we showed twenty things and none of them were it" looks like
 * healthy traffic on every chart.
 *
 * So each finding arrives with its diagnosis and one thing to do about it,
 * because the fixes differ. Nothing found is a vocabulary gap. Plenty found,
 * nothing clicked, and no brand or category in the catalogue matching the
 * words, is a categorisation gap. Plenty found, understood, still nothing
 * clicked, is a merchandising problem — right products, wrong order.
 */

const PROBLEM = {
  no_results: { label: 'Finds nothing', tone: 'pill--warn' },
  uncategorised: { label: 'No category for it', tone: 'pill--warn' },
  wrong_products: { label: 'Wrong products', tone: '' },
  rescue_dependent: { label: 'Only works when relaxed', tone: '' },
};

export const quality = {
  title: 'Search quality',
  subtitle: 'Searches that are wasting traffic, and what to do about each one',

  async render(root) {
    const days = state.days;
    const [{ findings }, { terms }] = await Promise.all([
      api(`/analytics/diagnose?days=${days}&limit=25`),
      api(`/analytics/terms?days=${days}&limit=20`),
    ]);

    root.innerHTML = `
      <div class="card">
        <div class="card__head">
          <h2 class="card__title">Needs attention</h2>
          <p class="card__hint">${findings.length} finding${findings.length === 1 ? '' : 's'} · last ${days} days</p>
        </div>
        ${findings.length ? `<div class="findings">${findings.map(finding).join('')}</div>`
          : '<p class="empty">Nothing is wasting traffic right now.</p>'}
      </div>

      <div class="card">
        <div class="card__head">
          <h2 class="card__title">What each word means to shoppers</h2>
          <p class="card__hint">Defined by what people click after typing it, not by the catalogue</p>
        </div>
        ${table(
          [{ label: 'Term' }, { label: 'Searches', numeric: true }, { label: 'Clicks', numeric: true },
           { label: 'Click-through', numeric: true }, { label: 'Focus', numeric: true }, { label: '' }],
          terms,
          (t) => `
            <tr>
              <td class="mono">${esc(t.term)}</td>
              <td class="num">${num(t.searches)}</td>
              <td class="num">${num(t.clicks)}</td>
              <td class="num">${t.clicks === 0 && t.searches > 5
                ? `<span class="pill pill--warn">${pct(t.clickRate)}</span>` : pct(t.clickRate)}</td>
              <td class="num" title="How much of this term's clicks land on one product">
                ${t.clicks ? pct(t.concentration * 100) : '—'}</td>
              <td class="num">${t.clicks
                ? `<button class="btn btn--sm" data-merch="${esc(t.term)}">Merchandise</button>` : ''}</td>
            </tr>`,
          'No search traffic recorded yet.',
        )}
      </div>`;
  },

  async onClick(event, navigate) {
    // Every suggestion lands on the screen that can act on it, with the query
    // already filled in. A finding you have to go and re-find is a report.
    const merch = event.target.closest('[data-merch]');
    if (merch) return navigate('merchandiser', { query: merch.dataset.merch });

    const fix = event.target.closest('[data-fix]');
    if (!fix) return;
    const { fix: action, query } = fix.dataset;
    if (action === 'merchandise_query') return navigate('merchandiser', { query });
    if (action === 'add_synonym' || action === 'map_category') {
      return navigate('vocabulary', { term: query });
    }
    toast('No action wired for that yet', true);
  },
};

function finding(f) {
  const meta = PROBLEM[f.problem] ?? { label: f.problem, tone: '' };
  const understood = [f.understood?.brand, f.understood?.category].filter(Boolean).join(' + ');
  return `
    <article class="finding">
      <div class="finding__head">
        <span class="pill ${meta.tone}">${esc(meta.label)}</span>
        <strong class="finding__query">${esc(f.query)}</strong>
        <span class="finding__vol">${num(f.searches)} searches · ${num(f.clicks)} clicks</span>
      </div>
      <p class="finding__evidence">${esc(f.evidence)}</p>
      ${understood ? `<p class="finding__understood">Understood as <code>${esc(understood)}</code></p>` : ''}
      <div class="finding__act">
        <button class="btn btn--sm btn--primary" data-needs="merchandiser"
          data-fix="${esc(f.suggestion.action)}" data-query="${esc(f.query)}">
          ${esc(f.suggestion.label)}
        </button>
        <span class="finding__detail">${esc(f.suggestion.detail)}</span>
      </div>
    </article>`;
}
