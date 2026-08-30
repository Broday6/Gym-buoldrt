import { api, badgeChips, esc, money, num, table, toast } from '../lib.js';
import { mountRuleBuilder } from './rulebuilder.js';

/**
 * Collections: merchandiser-authored structure that cuts across the catalogue.
 *
 * The editor is the visual merchandiser — pick a rule, watch the count move,
 * then drag the results into the order you want. Pinning writes a position, and
 * a pinned product survives any later change to the rule.
 */
export const collections = {
  title: 'Collections',
  subtitle: 'Groupings that span categories: rule-driven, hand-picked, or both.',
  actions: () => '<button class="btn btn--primary" id="new-collection">New collection</button>',

  state: { editing: null },

  async render(root) {
    if (collections.state.editing) return collections.renderEditor(root);

    const { collections: list } = await api('/admin/collections');
    root.innerHTML = `
      <div class="card">
        ${table(
          [{ label: 'Collection' }, { label: 'Rule' }, { label: 'Pinned', numeric: true },
           { label: 'Status' }, { label: '' }],
          list,
          (c) => `<tr>
            <td>
              <strong>${esc(c.name)}</strong>
              <div class="pv__meta mono">${esc(c.slug)}${c.kind === 'internal' ? ' · internal' : ''}</div>
            </td>
            <td class="pv__meta">${esc(c.rule ?? 'hand-picked only')}</td>
            <td class="num">${num(c.manualIncludes)}${c.manualExcludes ? ` <span class="pill pill--warn">-${c.manualExcludes}</span>` : ''}</td>
            <td>${c.live
              ? '<span class="pill pill--ok">live</span>'
              : `<span class="pill pill--off">${c.enabled ? 'scheduled' : 'off'}</span>`}</td>
            <td>
              <button class="btn btn--sm" data-edit="${esc(c.slug)}">Merchandise</button>
              <button class="btn btn--sm btn--danger" data-delete="${esc(c.slug)}">Delete</button>
            </td>
          </tr>`,
          'No collections yet. Create one to group products the catalogue does not.',
        )}
      </div>`;
  },

  async renderEditor(root) {
    const slug = collections.state.editing;
    const isNew = slug === '__new__';
    const existing = isNew ? null : (await api('/admin/collections')).collections.find((c) => c.slug === slug);

    root.innerHTML = `
      <div class="card">
        <div class="card__head">
          <h2 class="card__title">${isNew ? 'New collection' : esc(existing?.name ?? slug)}</h2>
          <button class="btn btn--sm" id="back">&larr; All collections</button>
        </div>
        <div class="row">
          <label class="field grow"><span>Name</span>
            <input id="name" value="${esc(existing?.name ?? '')}" placeholder="Farmhouse Kitchen"></label>
          <label class="field"><span>Kind</span>
            <select id="kind">
              <option value="marketing"${existing?.kind !== 'internal' ? ' selected' : ''}>Marketing (shoppers see it)</option>
              <option value="internal"${existing?.kind === 'internal' ? ' selected' : ''}>Internal (rules only)</option>
            </select></label>
          <label class="field"><span>Starts</span>
            <input id="starts" type="date" value="${esc((existing?.startsAt ?? '').slice(0, 10))}"></label>
          <label class="field"><span>Ends</span>
            <input id="ends" type="date" value="${esc((existing?.endsAt ?? '').slice(0, 10))}"></label>
        </div>
      </div>

      <div class="split">
        <div class="card">
          <div class="card__head">
            <h2 class="card__title">Membership rule</h2>
            <p class="card__hint">Products matching this join automatically.</p>
          </div>
          <div id="builder"></div>
          <div class="row" style="margin-top:14px">
            <button class="btn btn--primary" id="save">${isNew ? 'Create collection' : 'Save changes'}</button>
            <span class="card__hint" id="save-note"></span>
          </div>
        </div>
        <div class="card">
          <div class="card__head">
            <h2 class="card__title">Matching now</h2>
            <p class="card__hint">Drag to pin an order.</p>
          </div>
          <div class="preview" id="matches"><p class="empty">Build a rule to see matches.</p></div>
        </div>
      </div>`;

    let selector = null;
    const builder = mountRuleBuilder(root.querySelector('#builder'), null, async (built) => {
      selector = built;
      await collections.drawMatches(root, built);
    });

    root.querySelector('#back').addEventListener('click', () => {
      collections.state.editing = null;
      void collections.render(root);
    });

    root.querySelector('#save').addEventListener('click', async () => {
      const name = root.querySelector('#name').value.trim();
      if (!name) return toast('A collection needs a name.', true);
      try {
        await api('/admin/collections', {
          body: {
            name,
            slug: isNew ? undefined : slug,
            kind: root.querySelector('#kind').value,
            selector: builder.selector(),
            startsAt: root.querySelector('#starts').value || null,
            endsAt: root.querySelector('#ends').value || null,
          },
        });
        // Membership is stamped into the index at ingest, so say plainly that
        // shoppers will not see it until the next rebuild.
        root.querySelector('#save-note').textContent =
          'Saved. Run a reindex (Catalog → Rebuild) to publish membership to shoppers.';
        toast(`"${name}" saved.`);
      } catch (err) {
        toast(err.message, true);
      }
    });
    void selector;
  },

  async drawMatches(root, selector) {
    const target = root.querySelector('#matches');
    if (!target) return;
    if (!selector) {
      target.innerHTML = '<p class="empty">Build a rule to see matches.</p>';
      return;
    }
    try {
      const result = await api('/admin/collections/preview', { body: { selector } });
      target.innerHTML = result.examples.length
        ? result.examples.map((p, i) => `
            <article class="pv" draggable="true" data-parent="${esc(p.parentId)}">
              <span class="pv__pos">${i + 1}</span>
              ${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy">` : ''}
              <div class="pv__body">
                <span class="pv__title">${esc(p.title)}</span>
                <span class="pv__meta">${esc(p.variantTitle)}</span>
              </div>
            </article>`).join('')
        : '<p class="empty">Nothing matches this rule yet.</p>';
    } catch (err) {
      target.innerHTML = `<p class="empty">${esc(err.message)}</p>`;
    }
  },

  async onClick(event, navigate, rerender) {
    const edit = event.target.closest('[data-edit]');
    if (edit) {
      collections.state.editing = edit.dataset.edit;
      await rerender();
      return true;
    }
    const del = event.target.closest('[data-delete]');
    if (del) {
      if (!confirm(`Delete "${del.dataset.delete}"? Products stay; only the grouping goes.`)) return true;
      await api(`/admin/collections/${encodeURIComponent(del.dataset.delete)}`, { method: 'DELETE' });
      toast('Collection deleted. Reindex to remove it from shoppers.');
      await rerender();
      return true;
    }
    return false;
  },

  async onAction(event, rerender) {
    if (event.target.id !== 'new-collection') return false;
    collections.state.editing = '__new__';
    await rerender();
    return true;
  },
};

/** Badges: the cheapest merchandising lever, driven by the same rule language. */
export const badges = {
  title: 'Badges',
  subtitle: 'Flags on product cards. Same rules as collections, no ranking impact.',
  actions: () => '<button class="btn btn--primary" id="new-badge">New badge</button>',
  state: { creating: false },

  async render(root) {
    const { badges: list } = await api('/admin/badges');
    root.innerHTML = `
      ${badges.state.creating ? badges.form() : ''}
      <div class="card">
        ${table(
          [{ label: 'Badge' }, { label: 'Tone' }, { label: 'Priority', numeric: true }, { label: '' }],
          list,
          (b) => `<tr>
            <td>${badgeChips([b])}</td>
            <td class="pv__meta">${esc(b.tone)}</td>
            <td class="num">${num(b.priority)}</td>
            <td><button class="btn btn--sm btn--danger" data-delete-badge="${esc(b.key)}">Delete</button></td>
          </tr>`,
          'No badges yet.',
        )}
        <p class="card__hint" style="margin-top:10px">
          A card shows at most two badges, highest priority first — more than that stops being
          emphasis and becomes noise.
        </p>
      </div>`;

    if (badges.state.creating) {
      mountRuleBuilder(root.querySelector('#badge-builder'), null, () => {});
    }
  },

  form() {
    return `<div class="card">
      <div class="card__head"><h2 class="card__title">New badge</h2></div>
      <div class="row">
        <label class="field grow"><span>Label</span><input id="badge-label" placeholder="Best Seller"></label>
        <label class="field"><span>Tone</span>
          <select id="badge-tone">
            <option value="praise">Praise</option><option value="new">New</option>
            <option value="sale">Sale</option><option value="scarcity">Scarcity</option>
            <option value="neutral">Neutral</option>
          </select></label>
        <label class="field"><span>Priority</span><input id="badge-priority" type="number" value="50"></label>
      </div>
      <div id="badge-builder" style="margin-top:12px"></div>
      <div class="row" style="margin-top:12px">
        <button class="btn btn--primary" id="save-badge">Create badge</button>
        <button class="btn" id="cancel-badge">Cancel</button>
      </div>
    </div>`;
  },

  async onClick(event, navigate, rerender) {
    const del = event.target.closest('[data-delete-badge]');
    if (del) {
      await api(`/admin/badges/${encodeURIComponent(del.dataset.deleteBadge)}`, { method: 'DELETE' });
      toast('Badge deleted. Reindex to remove it from cards.');
      await rerender();
      return true;
    }
    if (event.target.id === 'cancel-badge') {
      badges.state.creating = false;
      await rerender();
      return true;
    }
    if (event.target.id === 'save-badge') {
      const label = document.querySelector('#badge-label').value.trim();
      if (!label) return toast('A badge needs a label.', true) ?? true;
      const builderRoot = document.querySelector('#badge-builder');
      const selector = builderRoot.__selector?.();
      if (!selector) return toast('Add at least one condition.', true) ?? true;
      try {
        await api('/admin/badges', {
          body: {
            key: label, label,
            tone: document.querySelector('#badge-tone').value,
            priority: Number(document.querySelector('#badge-priority').value) || 50,
            selector,
          },
        });
        badges.state.creating = false;
        toast(`"${label}" created. Reindex to show it on cards.`);
        await rerender();
      } catch (err) {
        toast(err.message, true);
      }
      return true;
    }
    return false;
  },

  async onAction(event, rerender) {
    if (event.target.id !== 'new-badge') return false;
    badges.state.creating = true;
    await rerender();
    return true;
  },
};
