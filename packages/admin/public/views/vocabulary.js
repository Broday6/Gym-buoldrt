import { api, esc, num, table, toast } from '../lib.js';

/**
 * Synonyms and redirects.
 *
 * Both take effect on the next query — they are query-time rewrites, not index
 * changes — which is what makes them the fastest lever a merchandiser has.
 */
export const vocabulary = {
  title: 'Vocabulary',
  subtitle: 'Synonyms and redirects. Both go live on the next search, no reindex.',
  actions: () => '',

  async render(root) {
    const [{ synonyms }, { redirects }, failing] = await Promise.all([
      api('/synonyms'),
      api('/redirects'),
      // The searches that found nothing are exactly what a synonym is for, and
      // the console already has them. Listing them here saves a trip to the
      // dashboard and a retyped search term.
      api('/analytics/problems?days=30&limit=6').catch(() => ({ queries: [] })),
    ]);
    const unmet = (failing.queries ?? []).filter((q) => q.zeroResults > 0).slice(0, 6);

    root.innerHTML = `
      <div class="card">
        <div class="card__head">
          <h2 class="card__title">Synonyms</h2>
          <p class="card__hint">Two-way terms are interchangeable; one-way expands in one direction only.</p>
        </div>
        <div class="row">
          <label class="field"><span>Kind</span>
            <select id="syn-kind">
              <option value="two_way">Two-way (sofa ↔ couch)</option>
              <option value="one_way">One-way (crown → crown moulding)</option>
            </select></label>
          <label class="field grow" id="syn-from-wrap" hidden><span>When a shopper types</span>
            <input id="syn-from" placeholder="crown"></label>
          <label class="field grow"><span>Terms</span>
            <input id="syn-terms" placeholder="sofa, couch, settee"></label>
          <button class="btn btn--primary" id="add-syn">Add</button>
        </div>
        <div style="margin-top:14px">
          ${table(
            [{ label: 'Kind' }, { label: 'Rule' }, { label: '' }],
            synonyms,
            (s) => `<tr>
              <td><span class="pill">${s.kind === 'two_way' ? 'two-way' : 'one-way'}</span></td>
              <td class="mono">${s.kind === 'two_way'
                ? esc(s.terms.join('  ↔  '))
                : `${esc(s.fromTerms.join(', '))}  →  ${esc(s.terms.join(', '))}`}</td>
              <td><button class="btn btn--sm btn--danger" data-del-syn="${s.id}">Delete</button></td>
            </tr>`,
            'No synonyms yet.',
          )}
        </div>
        ${unmet.length ? `
          <p class="start__label">Searches that found nothing — start with one of these</p>
          <div class="start">
            ${unmet.map((q) => `
              <button type="button" class="start__item" data-syn-from="${esc(q.query)}">
                <span class="start__q">${esc(q.query)}</span>
                <span class="start__n">${num(q.searches)} searches, no results</span>
              </button>`).join('')}
          </div>` : ''}
      </div>

      <div class="card">
        <div class="card__head">
          <h2 class="card__title">Redirects</h2>
          <p class="card__hint">Queries that are navigation, not product search: "returns", "shipping".</p>
        </div>
        <div class="row">
          <label class="field grow"><span>Query</span><input id="red-pattern" placeholder="returns"></label>
          <label class="field"><span>Match</span>
            <select id="red-type">
              <option value="exact">is exactly</option>
              <option value="starts_with">starts with</option>
              <option value="contains">contains</option>
              <option value="regex">matches regex</option>
            </select></label>
          <label class="field grow"><span>Send to</span><input id="red-url" placeholder="/pages/returns"></label>
          <button class="btn btn--primary" id="add-red">Add</button>
        </div>
        <div style="margin-top:14px">
          ${table(
            [{ label: 'Query' }, { label: 'Match' }, { label: 'Destination' },
             { label: 'Priority', numeric: true }, { label: '' }],
            redirects,
            (r) => `<tr>
              <td class="mono">${esc(r.pattern)}</td>
              <td class="pv__meta">${esc(r.matchType.replace('_', ' '))}</td>
              <td class="mono">${esc(r.url)}</td>
              <td class="num">${num(r.priority)}</td>
              <td><button class="btn btn--sm btn--danger" data-del-red="${r.id}">Delete</button></td>
            </tr>`,
            'No redirects yet.',
          )}
        </div>
      </div>`;

    const kind = root.querySelector('#syn-kind');
    const toggleFrom = () => {
      root.querySelector('#syn-from-wrap').hidden = kind.value !== 'one_way';
    };
    kind.addEventListener('change', toggleFrom);
    toggleFrom();
  },

  async onClick(event, navigate, rerender) {
    const from = event.target.closest('[data-syn-from]');
    if (from) {
      // A one-way rule: the words that fail get rewritten to words that work,
      // and not the reverse.
      const kind = document.querySelector('#syn-kind');
      kind.value = 'one_way';
      kind.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#syn-from').value = from.dataset.synFrom;
      const terms = document.querySelector('#syn-terms');
      terms.value = '';
      terms.focus();
      return true;
    }

    const delSyn = event.target.closest('[data-del-syn]');
    if (delSyn) {
      await api(`/synonyms/${delSyn.dataset.delSyn}`, { method: 'DELETE' });
      toast('Synonym removed. Live immediately.');
      await rerender();
      return true;
    }
    const delRed = event.target.closest('[data-del-red]');
    if (delRed) {
      await api(`/redirects/${delRed.dataset.delRed}`, { method: 'DELETE' });
      toast('Redirect removed. Live immediately.');
      await rerender();
      return true;
    }
    if (event.target.id === 'add-syn') {
      const terms = document.querySelector('#syn-terms').value
        .split(',').map((t) => t.trim()).filter(Boolean);
      const kind = document.querySelector('#syn-kind').value;
      const fromTerms = document.querySelector('#syn-from').value
        .split(',').map((t) => t.trim()).filter(Boolean);
      try {
        await api('/synonyms', { body: { kind, terms, fromTerms } });
        toast('Synonym added. Live on the next search.');
        await rerender();
      } catch (err) {
        toast(err.message, true);
      }
      return true;
    }
    if (event.target.id === 'add-red') {
      try {
        await api('/redirects', {
          body: {
            pattern: document.querySelector('#red-pattern').value.trim(),
            matchType: document.querySelector('#red-type').value,
            url: document.querySelector('#red-url').value.trim(),
          },
        });
        toast('Redirect added. Live on the next search.');
        await rerender();
      } catch (err) {
        toast(err.message, true);
      }
      return true;
    }
    return false;
  },
};
