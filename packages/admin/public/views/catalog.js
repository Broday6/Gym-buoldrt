import { api, esc, num, table, toast } from '../lib.js';

/**
 * Catalog health.
 *
 * The data-quality report from the last ingest, and the rebuild button.
 * Merchandising changes to collections, attributes and badges are stamped into
 * the index at ingest, so this is also where those get published.
 */
export const catalog = {
  title: 'Catalog',
  subtitle: 'Ingest history, data quality, and publishing merchandising changes.',
  actions: () => '<button class="btn btn--primary" id="reindex">Rebuild index</button>',

  async render(root) {
    const status = await api('/catalog/status');
    const latest = status.runs?.[0];
    const quality = latest?.quality ?? {};

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
      </div>

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
