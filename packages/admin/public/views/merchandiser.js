import { api, esc, money, state, toast } from '../lib.js';

/**
 * The visual merchandiser.
 *
 * Everything else in this console edits a rule and then tells you how many
 * products it caught. This screen does the opposite: it shows the products, and
 * the rule is whatever you did to them. You type a search term or pick a
 * category, see exactly what a shopper sees, and drag a product to where it
 * should be — the arrangement *is* the rule.
 *
 * The preview runs the real search with the unsaved changes applied, so what is
 * on screen and what ships cannot disagree. Nothing is saved until you say so,
 * and until then the header keeps count of what you have changed.
 */

const ACTION_LABEL = { pin: 'Pinned', bury: 'Pushed down', hide: 'Hidden' };

export const merchandiser = {
  title: 'Merchandiser',
  subtitle: 'Arrange the results a shopper sees for a search or a category',
  state: {
    mode: 'query',
    query: '',
    categoryId: '',
    actions: [],
    hits: [],
    total: 0,
    understood: [],
    rules: [],
    categories: [],
    /** The busiest searches, offered as a way in from a blank screen. */
    busiest: [],
    loading: false,
    dirty: false,
  },

  actions: () => `
    <button class="btn" id="merch-discard" data-needs="merchandiser">Discard</button>
    <button class="btn btn--primary" id="merch-save" data-needs="merchandiser">Save rule</button>`,

  async render(root, params) {
    const s = this.state;
    if (!s.categories.length) {
      const [directory, rules, top] = await Promise.all([
        api('/directory'),
        api('/admin/query-rules').catch(() => ({ rules: [] })),
        // The console already knows which searches matter most. Making
        // somebody guess one to type is asking them to do work the system has
        // already done.
        api('/analytics/queries?days=30&limit=8').catch(() => ({ queries: [] })),
      ]);
      s.categories = directory.categories ?? [];
      s.rules = rules.rules ?? [];
      s.busiest = (top.queries ?? []).filter((q) => q.searches > 0).slice(0, 8);
    }
    if (params?.query && params.query !== s.query) {
      s.mode = 'query';
      s.query = params.query;
      s.actions = [];
      await this.preview();
    }

    root.innerHTML = `
      <div class="card merch__bar">
        <div class="seg" role="tablist">
          <button role="tab" class="seg__btn" data-mode="query"
            aria-selected="${s.mode === 'query'}">Search term</button>
          <button role="tab" class="seg__btn" data-mode="category"
            aria-selected="${s.mode === 'category'}">Category</button>
        </div>
        ${s.mode === 'query' ? `
          <label class="field grow">
            <span class="sr-only">Search term</span>
            <input id="merch-q" type="search" placeholder="Type a search term, e.g. beams"
              value="${esc(s.query)}" autocomplete="off">
          </label>`
        : `
          <label class="field grow">
            <span class="sr-only">Category</span>
            <select id="merch-cat">
              <option value="">Choose a category…</option>
              ${s.categories.map((c) => `<option value="${esc(c.id)}"${c.id === s.categoryId ? ' selected' : ''}>
                ${esc(c.path.join(' › '))} (${c.products})</option>`).join('')}
            </select>
          </label>`}
        ${this.summary()}
      </div>
      ${this.grid()}
      ${this.existing()}`;

    const input = root.querySelector('#merch-q');
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  },

  summary() {
    const s = this.state;
    if (!s.hits.length && !s.loading) return '<p class="card__hint">Nothing loaded yet.</p>';
    const counts = { pin: 0, bury: 0, hide: 0 };
    for (const a of s.actions) counts[a.action]++;
    const changed = s.actions.length;
    const understood = s.understood
      .map((c) => `<span class="pill">${esc(c.kind)}: ${esc(c.value)}</span>`).join(' ');
    return `
      <p class="merch__count">
        <strong>${s.total.toLocaleString()}</strong> products
        ${understood ? ` ${understood}` : ''}
        ${changed
          ? `<span class="pill pill--warn">${changed} unsaved change${changed === 1 ? '' : 's'}
              — ${counts.pin} pinned, ${counts.bury} down, ${counts.hide} hidden</span>`
          : ''}
      </p>`;
  },

  grid() {
    const s = this.state;
    if (s.loading) return '<div class="card"><p class="empty">Loading the grid…</p></div>';
    if (!s.hits.length) {
      if (s.query || s.categoryId) {
        return '<div class="card"><p class="empty">No products for that. Try another term.</p></div>';
      }
      return `<div class="card">
        <div class="card__head">
          <h2 class="card__title">Pick a search to work on</h2>
          <p class="card__hint">
            You will see exactly what a shopper sees, and can drag any product to
            where it should be. Nothing is saved until you press Save rule.
          </p>
        </div>
        ${s.busiest.length ? `
          <p class="start__label">Your busiest searches over the last 30 days</p>
          <div class="start">
            ${s.busiest.map((q) => `
              <button type="button" class="start__item" data-start="${esc(q.query)}">
                <span class="start__q">${esc(q.query)}</span>
                <span class="start__n">${q.searches.toLocaleString()} searches</span>
              </button>`).join('')}
          </div>`
          : '<p class="empty">Type a search term above to see what shoppers get.</p>'}
      </div>`;
    }
    const byParent = new Map(s.actions.map((a) => [a.parentId, a]));
    return `<div class="card">
      <p class="card__hint merch__help">
        Drag a card to move it. The position you drop it in is the position it pins to.
      </p>
      <div class="merch__grid" id="merch-grid">
        ${s.hits.map((hit, i) => {
          const action = byParent.get(hit.parentId);
          return `
          <article class="mtile${action ? ` mtile--${action.action}` : ''}"
            draggable="true" data-parent="${esc(hit.parentId)}" data-index="${i}">
            <span class="mtile__pos">${i + 1}</span>
            ${action ? `<span class="mtile__flag">${ACTION_LABEL[action.action]}</span>` : ''}
            <img src="${esc(hit.image || '')}" alt="" loading="lazy">
            <div class="mtile__body">
              <span class="mtile__title">${esc(hit.title)}</span>
              <span class="mtile__meta">${esc(hit.brand ?? '')} ·
                ${hit.effectivePrice > 0 ? money(hit.effectivePrice) : 'No price'}</span>
            </div>
            <div class="mtile__acts">
              <button class="btn btn--sm" data-act="pin" data-parent="${esc(hit.parentId)}"
                title="Pin to this position">Pin</button>
              <button class="btn btn--sm" data-act="bury" data-parent="${esc(hit.parentId)}"
                title="Push to the end">Down</button>
              <button class="btn btn--sm btn--danger" data-act="hide" data-parent="${esc(hit.parentId)}"
                title="Never show for this search">Hide</button>
              ${action ? `<button class="btn btn--sm" data-act="clear"
                data-parent="${esc(hit.parentId)}" title="Undo">Reset</button>` : ''}
            </div>
          </article>`;
        }).join('')}
      </div>
    </div>`;
  },

  existing() {
    const s = this.state;
    if (!s.rules.length) return '';
    return `<div class="card">
      <div class="card__head">
        <h2 class="card__title">Saved rules</h2>
        <p class="card__hint">${s.rules.length} in effect</p>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Search term</th><th>Match</th><th>Changes</th><th></th></tr></thead>
        <tbody>${s.rules.map((r) => `
          <tr>
            <td><button class="linky" data-open="${esc(r.query)}">${esc(r.query)}</button></td>
            <td><span class="pill">${esc(r.matchType)}</span></td>
            <td>${r.actions.length} product${r.actions.length === 1 ? '' : 's'}</td>
            <td class="num"><button class="btn btn--sm btn--danger" data-needs="merchandiser"
              data-delete="${r.id}">Delete</button></td>
          </tr>`).join('')}</tbody>
      </table></div>
    </div>`;
  },

  /** The real search, with the unsaved arrangement applied. */
  async preview() {
    const s = this.state;
    if (!s.query.trim() && !s.categoryId) {
      s.hits = []; s.total = 0; s.understood = [];
      return;
    }
    s.loading = true;
    try {
      const result = await api('/admin/query-rules/preview', {
        body: {
          ...(s.mode === 'query' ? { query: s.query } : { categoryId: s.categoryId }),
          actions: s.actions,
          hitsPerPage: 48,
        },
      });
      s.hits = result.hits ?? [];
      s.total = result.totalHits ?? 0;
      s.understood = result.understood ?? [];
    } catch (err) {
      s.hits = []; s.total = 0;
      toast(err.message, true);
    } finally {
      s.loading = false;
    }
  },

  setAction(parentId, action, position) {
    const s = this.state;
    s.actions = s.actions.filter((a) => a.parentId !== parentId);
    if (action) s.actions.push({ parentId, action, position: action === 'pin' ? position : null });
    s.dirty = s.actions.length > 0;
  },

  async onClick(event, navigate, rerender) {
    const s = this.state;

    const start = event.target.closest('[data-start]');
    if (start) {
      s.mode = 'query';
      s.query = start.dataset.start;
      s.actions = [];
      await this.preview();
      return rerender();
    }

    const mode = event.target.closest('[data-mode]');
    if (mode) {
      s.mode = mode.dataset.mode;
      s.actions = [];
      await this.preview();
      return rerender();
    }

    const act = event.target.closest('[data-act]');
    if (act) {
      const { act: action, parent } = act.dataset;
      const index = s.hits.findIndex((h) => h.parentId === parent);
      this.setAction(parent, action === 'clear' ? null : action, index + 1);
      await this.preview();
      return rerender();
    }

    const open = event.target.closest('[data-open]');
    if (open) {
      const rule = s.rules.find((r) => r.query === open.dataset.open);
      s.mode = 'query';
      s.query = open.dataset.open;
      s.actions = rule ? rule.actions.map((a) => ({ ...a })) : [];
      await this.preview();
      return rerender();
    }

    const del = event.target.closest('[data-delete]');
    if (del) {
      await api(`/admin/query-rules/${del.dataset.delete}`, { method: 'DELETE' });
      s.rules = (await api('/admin/query-rules')).rules;
      toast('Rule deleted');
      return rerender();
    }
  },

  async onAction(event, rerender) {
    const s = this.state;
    if (event.target.id === 'merch-discard') {
      s.actions = [];
      await this.preview();
      await rerender();
      toast('Changes discarded');
      return true;
    }
    if (event.target.id === 'merch-save') {
      const category = s.mode === 'category';
      const target = category ? s.categoryId : s.query.trim();
      if (!target) {
        return toast(category ? 'Pick a category first' : 'Type a search term first', true), true;
      }
      if (!s.actions.length) return toast('Nothing to save yet — move a product first', true), true;

      // The same rule either way — same pins, buries and hides, same history
      // and undo. Only what makes it fire differs.
      await api('/admin/query-rules', {
        body: category
          ? { categoryId: s.categoryId, actions: s.actions }
          : { query: s.query, matchType: 'exact', actions: s.actions },
      });
      s.rules = (await api('/admin/query-rules')).rules;
      s.dirty = false;
      const name = category
        ? (s.categories.find((c) => c.id === s.categoryId)?.path?.join(' / ') ?? s.categoryId)
        : s.query;
      toast(`Saved. ${name} is now merchandised.`);
      await rerender();
      return true;
    }
    return false;
  },
};
