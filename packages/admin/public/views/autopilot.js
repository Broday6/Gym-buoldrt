import { api, esc, num, toast } from '../lib.js';

/**
 * Merchandising the system proposes for itself.
 *
 * Every other merchandising screen answers "what do you want to change?" This
 * one answers "here is what the numbers say to change, and why." That is the
 * difference between a tool you have to drive and one that tells you where to
 * look — on a catalogue this size nobody can inspect every query, so the
 * queries that get tuned are the ones somebody happened to think of.
 *
 * Two rules about the design here, both learned from tools that get ignored:
 *
 *   - **Never a bare recommendation.** Each card leads with the numbers that
 *     produced it. A suggestion you cannot check is one you either apply on
 *     faith or ignore, and people ignore.
 *   - **Dismissal is a first-class action.** Proposals are derived on every
 *     read, so anything not remembered as refused comes back forever, and a
 *     list that cannot be cleared stops being read.
 */

const KIND = {
  promote: {
    label: 'Move up',
    tone: 'pill--ok',
    why: 'Shoppers are scrolling past what we ranked first to reach this.',
  },
  demote: {
    label: 'Move down',
    tone: 'pill--warn',
    why: 'This is holding a top slot and nobody takes it.',
  },
  synonym: {
    label: 'Vocabulary',
    tone: '',
    why: 'This search finds nothing, and these words find plenty.',
  },
};

export const autopilot = {
  title: 'Recommendations',
  subtitle: 'What the last 30 days of shopper behaviour says to change',
  needs: 'analyst',

  async render(root) {
    const { proposals } = await api('/admin/proposals');
    // Split, not sorted. Everything above the fold under "Ready to apply" has
    // to actually be appliable, or the heading is a lie and the first thing
    // anyone sees is three cards whose only button sends them elsewhere.
    const ready = proposals.filter((p) => p.kind !== 'demote');
    const review = proposals.filter((p) => p.kind === 'demote');

    root.innerHTML = `
      <div class="card">
        <div class="card__head">
          <h2 class="card__title">Ready to apply</h2>
          <p class="card__hint">
            ${ready.length
              ? `${ready.length} change${ready.length === 1 ? '' : 's'} the numbers support`
              : 'Nothing to apply right now'}
          </p>
          ${ready.length > 1
            ? `<div class="pagehead__actions">
                 <button class="btn btn--primary" data-needs="merchandiser" data-apply-all>
                   Apply all ${Math.min(ready.length, 5)}
                 </button>
               </div>`
            : ''}
        </div>

        ${ready.length
          ? `<div class="proposals">${ready.map(card).join('')}</div>`
          : `<p class="empty">
               Recommendations come from clicks measured against what was shown. Once
               there is a month of traffic, anything worth changing appears here.
             </p>`}
      </div>

      ${review.length ? `
        <div class="card">
          <div class="card__head">
            <h2 class="card__title">Worth a look</h2>
            <p class="card__hint">
              Shown often, never chosen — but a product nobody clicks can be a
              missing photograph rather than a bad product, so these are not
              applied from here
            </p>
          </div>
          <div class="proposals">${review.map(card).join('')}</div>
        </div>` : ''}

      <div class="card">
        <div class="card__head">
          <h2 class="card__title">Running on its own</h2>
        </div>
        <p class="prose">
          Ranking already learns without anyone here: click-through is measured per
          product, shrunk toward the site average so a handful of clicks cannot
          move anything, and fed back into the order results come out in. These
          cards are the changes too specific for ranking to make on its own.
        </p>
        <p class="prose">
          A nightly job can apply the confident ones for you. It is off unless the
          deployment sets <code>COMPASS_AUTOPILOT=on</code>, it only ever moves
          products up or adds vocabulary — never hides anything — and every change
          it makes appears in <strong>History</strong> under
          <code>autopilot</code>, revertible in one click like any other.
        </p>
      </div>`;
  },

  async onClick(event, navigate) {
    const applyAll = event.target.closest('[data-apply-all]');
    if (applyAll) {
      const { proposals } = await api('/admin/proposals');
      const batch = proposals.filter((p) => p.kind !== 'demote').slice(0, 5);
      let applied = 0;
      for (const proposal of batch) {
        try {
          await api('/admin/proposals/apply', { method: 'POST', body: { proposal } });
          applied++;
        } catch (err) {
          toast(err.message, true);
          break;
        }
      }
      toast(`Applied ${applied} recommendation${applied === 1 ? '' : 's'}`);
      return this.render(document.querySelector('.view'));
    }

    const card = event.target.closest('[data-proposal]');
    if (!card) return;
    const proposal = JSON.parse(decodeURIComponent(card.dataset.proposal));

    if (event.target.closest('[data-act="review"]')) {
      // A demotion is never applied from here: hiding a product is the one
      // action that can lose a sale outright rather than reorder one, and "no
      // clicks" can mean the photography is missing, not the product.
      return navigate('merchandiser', { query: proposal.query || '' });
    }

    if (event.target.closest('[data-act="dismiss"]')) {
      await api('/admin/proposals/dismiss', { method: 'POST', body: { id: proposal.id } });
      toast('Dismissed');
      return this.render(document.querySelector('.view'));
    }

    if (event.target.closest('[data-act="apply"]')) {
      try {
        await api('/admin/proposals/apply', { method: 'POST', body: { proposal } });
        toast('Applied — see History to undo');
        return this.render(document.querySelector('.view'));
      } catch (err) {
        toast(err.message, true);
      }
    }
  },
};

function card(proposal) {
  const meta = KIND[proposal.kind] ?? { label: proposal.kind, tone: '', why: '' };
  const confidence = Math.round((proposal.confidence ?? 0) * 100);
  const payload = encodeURIComponent(JSON.stringify(proposal));

  return `
    <article class="proposal" data-proposal="${payload}">
      <div class="proposal__head">
        <span class="pill ${meta.tone}">${esc(meta.label)}</span>
        <strong class="proposal__summary">${esc(proposal.summary)}</strong>
        <span class="proposal__conf" title="How strongly the evidence supports this">
          ${confidence}% confident
        </span>
      </div>

      <p class="proposal__why">${esc(meta.why)}</p>

      <dl class="proposal__evidence">
        ${(proposal.evidence ?? []).filter((e) => e.label !== 'Products').map((e) => `
          <div>
            <dt>${esc(e.label)}</dt>
            <dd>${esc(e.value)}</dd>
          </div>`).join('')}
      </dl>

      ${(proposal.products ?? []).length
        // Named, in the order they would be pinned. A recommendation about
        // MLD525X525X144PR499 cannot be checked without going to look it up.
        ? `<ol class="proposal__products">
             ${proposal.products.map((p) => `
               <li>
                 <span class="proposal__slot">${p.position}</span>
                 <span class="proposal__name">${esc(p.title ?? p.sku)}</span>
                 <span class="proposal__sku">${esc(p.sku)}</span>
                 <span class="proposal__clicks">${num(p.clicks)} clicks</span>
               </li>`).join('')}
           </ol>`
        : ''}

      <div class="proposal__act">
        ${proposal.kind === 'demote'
          ? `<button class="btn btn--sm" data-act="review" data-needs="merchandiser">
               Review in merchandiser
             </button>`
          : `<button class="btn btn--sm btn--primary" data-act="apply" data-needs="merchandiser">
               Apply
             </button>`}
        <button class="btn btn--sm" data-act="dismiss" data-needs="merchandiser">Dismiss</button>
        ${proposal.reach
          ? `<span class="proposal__reach">${num(proposal.reach)} searches affected</span>`
          : ''}
      </div>
    </article>`;
}
