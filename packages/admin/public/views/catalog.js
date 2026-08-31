import { api, esc, num, table, toast } from '../lib.js';

/**
 * Catalog health.
 *
 * The data-quality report from the last ingest, and the rebuild button.
 * Merchandising changes to collections, attributes and badges are stamped into
 * the index at ingest, so this is also where those get published.
 *
 * It is also where the ingest owns up to what it inferred. A feed that leaves
 * the Finish column empty on half its range still says "Walnut" in the item
 * name, and that gets read and filled in — which is the difference between
 * half a catalogue being filterable and all of it, and is also the system
 * writing product data nobody sent it. So it is shown, itemised, with where
 * each value was read from, rather than left as a number in a log.
 */
export const catalog = {
  title: 'Catalog',
  subtitle: 'Ingest history, data quality, and publishing merchandising changes.',
  // The screen is readable by an analyst; rebuilding the index is not.
  actions: () => '<button class="btn btn--primary" id="reindex" data-needs="admin">Rebuild index</button>',

  async render(root) {
    const status = await api('/catalog/status');
    const latest = status.runs?.[0];
    const quality = latest?.quality ?? {};
    const learned = latest?.learned ?? null;

    const issues = [
      ['Products with no image', quality.missingImages?.length ?? 0],
      ['Thin or empty descriptions', quality.emptyDescriptions?.length ?? 0],
      ['Uncategorised products', quality.uncategorised?.length ?? 0],
      ['Duplicate SKUs', quality.duplicateSkus?.length ?? 0],
      ['Variants with no price', quality.missingPrice?.length ?? 0],
      ['Rows rejected outright', quality.rejected?.length ?? 0],
    ];

    root.innerHTML = `
      <div class="stats">
        <div class="stat">
          <p class="stat__label">Indexed documents</p>
          <p class="stat__value">${num(status.documents)}</p>
          <p class="stat__note">one per buyable variant</p>
        </div>
        <div class="stat">
          <p class="stat__label">Products</p>
          <p class="stat__value">${num(quality.totalProducts ?? 0)}</p>
          <p class="stat__note">${num(quality.totalVariants ?? 0)} variants</p>
        </div>
        <div class="stat ${issues.reduce((n, [, v]) => n + v, 0) > 0 ? 'stat--warn' : 'stat--ok'}">
          <p class="stat__label">Data-quality issues</p>
          <p class="stat__value">${num(issues.reduce((n, [, v]) => n + v, 0))}</p>
          <p class="stat__note">reported, never silently dropped</p>
        </div>
        ${learned?.filled ? `
          <div class="stat">
            <p class="stat__label">Details filled in for you</p>
            <p class="stat__value">${num(learned.filled)}</p>
            <p class="stat__note">read from product text, on ${num(learned.rowsChanged)} products</p>
          </div>` : ''}
      </div>

      ${learned?.filled ? learnedCard(learned) : ''}

      <div class="card">
        <div class="card__head">
          <h2 class="card__title">Data quality</h2>
          <p class="card__hint">From the most recent ingest.</p>
        </div>
        ${table(
          [{ label: 'Issue' }, { label: 'Products', numeric: true }],
          issues.filter(([, v]) => v > 0).map(([label, value]) => ({ label, value })),
          (r) => `<tr><td>${esc(r.label)}</td><td class="num">${num(r.value)}</td></tr>`,
          'No issues in the last ingest.',
        )}
        ${(quality.rejected ?? []).length ? `
          <p class="card__hint" style="margin-top:12px">First rejected rows:</p>
          <ul class="mono" style="margin:6px 0 0;padding-left:18px;color:var(--muted)">
            ${quality.rejected.slice(0, 5).map((r) =>
              `<li>line ${num(r.row)}: ${esc(r.reason)}</li>`).join('')}
          </ul>` : ''}
      </div>

      <div class="card">
        <div class="card__head"><h2 class="card__title">Recent ingests</h2></div>
        ${table(
          [{ label: 'When' }, { label: 'Source' }, { label: 'Products', numeric: true },
           { label: 'Variants', numeric: true }, { label: 'Took', numeric: true }],
          status.runs ?? [],
          (r) => `<tr>
            <td>${esc(new Date(r.started_at).toLocaleString())}</td>
            <td class="mono">${esc(r.source)}</td>
            <td class="num">${num(r.products)}</td>
            <td class="num">${num(r.variants)}</td>
            <td class="num">${num(r.duration_ms)}ms</td>
          </tr>`,
          'No ingests recorded yet.',
        )}
      </div>`;
  },

  async onAction(event, rerender) {
    if (event.target.id !== 'reindex') return false;
    toast('A rebuild runs from the command line: npm run reindex -- <site> <catalog.csv>');
    return true;
  },
};

/**
 * What the ingest worked out for itself.
 *
 * Written to be checkable rather than impressive. The counts say how much was
 * filled in and where it was read from; the samples let a merchandiser spot
 * a wrong one without exporting anything; and the sentence about what it
 * declined is there because the refusals are the reason to trust the rest.
 */
function learnedCard(learned) {
  const byKey = Object.entries(learned.byKey ?? {}).sort((a, b) => b[1] - a[1]);
  const bySource = Object.entries(learned.bySource ?? {}).sort((a, b) => b[1] - a[1]);
  const WHERE = {
    title: 'the product name',
    variantTitle: 'the option name',
    tags: 'the keywords',
    description: 'the description',
  };

  return `
    <div class="card">
      <div class="card__head">
        <h2 class="card__title">Details filled in from the product text</h2>
        <p class="card__hint">
          Where your feed left a field empty but the product's own wording said it
        </p>
      </div>
      <p class="prose">
        A product whose Finish column is blank but whose name reads
        "Walnut Faux Wood Beam" can still be searched for by name — but it will not
        appear under the Walnut filter, in a Walnut collection, or in any rule about
        walnut products. These were read out of the product's own text and filled in,
        so the whole range behaves the same way.
        <strong>Nothing your feed states was changed</strong> — only blanks were filled.
      </p>

      <div class="row">
        ${byKey.map(([key, n]) => `
          <span class="pill">${esc(key)} <strong>${num(n)}</strong></span>`).join('')}
      </div>

      <p class="card__hint">
        Read from ${bySource.map(([f, n]) =>
          `${esc(WHERE[f] ?? f)} (${num(n)})`).join(', ')}.
        ${learned.declined
          ? `${num(learned.declined)} were left blank on purpose: the wording named more
             than one possible value, and a guess there would be worse than a gap.`
          : ''}
      </p>

      ${(learned.samples ?? []).length ? `
        <details class="guide__example">
          <summary>Check a sample of ${num(Math.min(learned.samples.length, 50))}</summary>
          ${table(
            [{ label: 'SKU' }, { label: 'Field' }, { label: 'Filled in with' },
              { label: 'Read from' }],
            learned.samples.slice(0, 50),
            (s) => `<tr>
              <td>${esc(s.sku)}</td>
              <td>${esc(s.key)}</td>
              <td><strong>${esc(s.value)}</strong></td>
              <td>${esc(WHERE[s.source] ?? s.source)}</td>
            </tr>`,
          )}
        </details>` : ''}
    </div>`;
}
