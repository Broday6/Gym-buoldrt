import { api, esc, html, raw, state, table, toast } from '../lib.js';

/**
 * Change history.
 *
 * Two questions a merchandiser asks after something goes wrong, in this order:
 * "what changed?" and "can I put it back?". So the row is the answer to the
 * first — actor, time, entity, and the fields that moved — and the button is
 * the answer to the second.
 *
 * Where a change cannot be undone the row says why instead of hiding the
 * button. A greyed control with no explanation sends someone to ask an engineer.
 */

const ACTION_TONE = {
  upsert: '', create: 'pill--ok', delete: 'pill--warn', revert: 'pill--off',
};

/** What a merchandiser calls it, rather than what the column stores. */
const ACTION_LABEL = { upsert: 'edited', create: 'created', delete: 'deleted', revert: 'undone' };

const when = (iso) => {
  const then = new Date(iso);
  const mins = Math.round((Date.now() - then.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return then.toISOString().slice(0, 16).replace('T', ' ');
};

/** A value a person can read at a glance, not a JSON blob. */
function short(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') {
    const json = JSON.stringify(value);
    return json.length > 90 ? `${json.slice(0, 88)}…` : json;
  }
  return String(value);
}

export const history = {
  title: 'History',
  subtitle: 'Every merchandising change, and how to undo one',
  state: { expanded: null },

  async render(root) {
    const { entries } = await api('/history?limit=100');

    root.innerHTML = html`
      <div class="card">
        <div class="card__head">
          <h2 class="card__title">Recent changes</h2>
          <p class="card__hint">${String(entries.length)} entries · newest first</p>
        </div>
        ${raw(table(
          [{ label: 'When' }, { label: 'Who' }, { label: 'Change' }, { label: 'What' }, { label: '' }],
          entries,
          (e) => `
            <tr data-row="${e.id}">
              <td>${esc(when(e.occurredAt))}</td>
              <td>${esc(e.actor)}</td>
              <td><span class="pill ${ACTION_TONE[e.action] ?? ''}">${esc(ACTION_LABEL[e.action] ?? e.action)}</span></td>
              <td>
                <span class="mono">${esc(e.entityType)}</span>
                <strong>${esc(e.entityId ?? '')}</strong>
                <button class="btn btn--sm" data-diff="${e.id}">
                  ${this.state.expanded === e.id ? 'Hide' : 'What changed'}
                </button>
              </td>
              <td class="num">${e.revertible
                ? `<button class="btn btn--sm" data-needs="merchandiser" data-revert="${e.id}">Undo</button>`
                : `<span class="pill pill--off" title="${esc(e.reason ?? '')}">can't undo</span>`}</td>
            </tr>
            ${this.state.expanded === e.id ? diffRow(e) : ''}`,
          'No changes recorded yet. Every collection, badge, attribute, synonym and redirect edit lands here.',
        ))}
      </div>`;
  },

  async onClick(event, _navigate, rerender) {
    const toggle = event.target.closest('[data-diff]');
    if (toggle) {
      const id = Number(toggle.dataset.diff);
      this.state.expanded = this.state.expanded === id ? null : id;
      return rerender();
    }

    const undo = event.target.closest('[data-revert]');
    if (!undo) return;
    const id = Number(undo.dataset.revert);
    const result = await api(`/history/${id}/revert`, { method: 'POST' });
    this.state.expanded = null;
    toast(result.action === 'restored'
      ? `Restored the previous ${result.reverted.entityType}${
        result.reindexRequired ? ' — rebuild the index to apply it to results' : ''}`
      : `Removed the ${result.reverted.entityType} that change created`);
    await rerender();
  },
};

/**
 * Field-by-field, because "the rule changed" is not actionable.
 *
 * The server computes the change set — the same one the undo acts on — so the
 * console cannot show a diff that disagrees with what reverting would do.
 */
function diffRow(entry) {
  const changed = entry.changes ?? [];
  if (!changed.length) {
    return `<tr class="diff"><td colspan="5"><p class="empty">No field-level detail recorded for this change.</p></td></tr>`;
  }
  return `<tr class="diff"><td colspan="5">
    <table class="diff__table">
      <thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead>
      <tbody>${changed.map((c) => `
        <tr>
          <td class="diff__field mono">${esc(c.field)}</td>
          <td class="mono diff__before">${esc(short(c.before))}</td>
          <td class="mono diff__after">${esc(short(c.after))}</td>
        </tr>`).join('')}</tbody>
    </table>
  </td></tr>`;
}
