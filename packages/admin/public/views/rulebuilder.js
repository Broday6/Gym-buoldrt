import { api, esc, num } from '../lib.js';

/**
 * Visual rule builder.
 *
 * The spec's rule against shipping any admin action whose only path is editing
 * raw JSON. A selector is a declarative structure precisely so it can
 * round-trip to and from form controls, and this is the other half of that
 * bargain.
 *
 * Every edit re-counts against the live index, because a rule you cannot see
 * the effect of is a rule you will not trust.
 */

const FIELDS = [
  { value: 'categoryPath', label: 'Category', kind: 'text' },
  { value: 'brand', label: 'Brand', kind: 'text' },
  { value: 'title', label: 'Title', kind: 'text' },
  { value: 'tags', label: 'Tag', kind: 'text' },
  { value: 'variant.attrs.finish', label: 'Finish', kind: 'text' },
  { value: 'variant.attrs.material', label: 'Material', kind: 'text' },
  { value: 'variant.attrs.style', label: 'Style', kind: 'text' },
  { value: 'minPrice', label: 'Lowest price', kind: 'number' },
  { value: 'maxPrice', label: 'Highest price', kind: 'number' },
  { value: 'margin', label: 'Margin %', kind: 'number' },
  { value: 'salesVelocity', label: 'Units sold', kind: 'number' },
  { value: 'reviewScore', label: 'Rating', kind: 'number' },
  { value: 'totalInventory', label: 'Total stock', kind: 'number' },
  { value: 'variant.inventory', label: 'Variant stock', kind: 'number' },
  { value: 'inStock', label: 'In stock', kind: 'boolean' },
  { value: 'onSale', label: 'On sale', kind: 'boolean' },
  { value: 'dateAdded', label: 'Date added', kind: 'date' },
];

const OPS = {
  text: [
    ['equals', 'is'], ['not_equals', 'is not'], ['contains', 'contains'],
    ['not_contains', 'does not contain'], ['starts_with', 'starts with'],
    ['in', 'is one of'], ['exists', 'is set'], ['missing', 'is not set'],
  ],
  number: [
    ['gte', 'at least'], ['lte', 'at most'], ['gt', 'more than'], ['lt', 'less than'],
    ['equals', 'is'], ['between', 'between'],
  ],
  boolean: [['equals', 'is']],
  date: [['gte', 'on or after'], ['lte', 'on or before']],
};

export function fieldKind(field) {
  return FIELDS.find((f) => f.value === field)?.kind ?? 'text';
}

/** Render the builder into a container, and call back on every change. */
export function mountRuleBuilder(container, initial, onChange) {
  const model = {
    mode: initial?.any ? 'any' : 'all',
    clauses: (initial?.all ?? initial?.any ?? []).filter((c) => 'field' in c).map((c) => ({ ...c })),
  };
  if (model.clauses.length === 0) {
    model.clauses.push({ field: 'categoryPath', op: 'contains', value: '' });
  }

  function selector() {
    const clauses = model.clauses
      .filter((c) => c.field && c.op)
      // An incomplete clause is dropped rather than sent: a half-typed rule
      // must never be interpreted as "match everything".
      .filter((c) => ['exists', 'missing'].includes(c.op) || String(c.value ?? '') !== '')
      .map((c) => {
        const kind = fieldKind(c.field);
        const clause = { field: c.field, op: c.op };
        if (['exists', 'missing'].includes(c.op)) return clause;
        if (c.op === 'in') {
          clause.value = String(c.value).split(',').map((v) => v.trim()).filter(Boolean);
        } else if (kind === 'number') {
          clause.value = Number(c.value);
          if (c.op === 'between') clause.to = Number(c.to);
        } else if (kind === 'boolean') {
          clause.value = String(c.value) === 'true';
        } else {
          clause.value = c.value;
        }
        return clause;
      });
    return clauses.length ? { [model.mode]: clauses } : null;
  }

  function draw() {
    container.innerHTML = `
      <div class="rule">
        <div class="rule__mode">
          Match
          <select data-mode>
            <option value="all"${model.mode === 'all' ? ' selected' : ''}>all</option>
            <option value="any"${model.mode === 'any' ? ' selected' : ''}>any</option>
          </select>
          of these conditions
        </div>
        ${model.clauses.map((c, i) => clauseHtml(c, i)).join('')}
        <button class="btn btn--sm" data-add type="button">+ Add condition</button>
        <div class="rule__preview" data-preview>Counting matching products…</div>
      </div>`;

    container.querySelector('[data-mode]').addEventListener('change', (e) => {
      model.mode = e.target.value;
      emit();
    });
    container.querySelector('[data-add]').addEventListener('click', () => {
      model.clauses.push({ field: 'brand', op: 'equals', value: '' });
      draw();
      emit();
    });
    container.addEventListener('change', onControl);
    container.addEventListener('input', onControl);
    container.addEventListener('click', (e) => {
      const remove = e.target.closest('[data-remove]');
      if (!remove) return;
      model.clauses.splice(Number(remove.dataset.remove), 1);
      if (model.clauses.length === 0) {
        model.clauses.push({ field: 'categoryPath', op: 'contains', value: '' });
      }
      draw();
      emit();
    });
  }

  function onControl(event) {
    const control = event.target.closest('[data-index]');
    if (!control) return;
    const clause = model.clauses[Number(control.dataset.index)];
    if (!clause) return;
    clause[control.dataset.part] = control.value;
    if (control.dataset.part === 'field') {
      // Comparators are per-type; keep the clause valid when the field changes.
      const kind = fieldKind(clause.field);
      if (!OPS[kind].some(([op]) => op === clause.op)) clause.op = OPS[kind][0][0];
      clause.value = '';
      draw();
    } else if (control.dataset.part === 'op') {
      draw();
    }
    emit();
  }

  let seq = 0;
  async function emit() {
    const built = selector();
    onChange?.(built);
    const preview = container.querySelector('[data-preview]');
    if (!preview) return;
    if (!built) {
      preview.textContent = 'Add a condition to see how many products match.';
      return;
    }
    const mine = ++seq;
    try {
      const result = await api('/admin/collections/preview', { body: { selector: built } });
      if (mine !== seq) return;
      preview.innerHTML = `Matches <strong>${num(result.matched)}</strong> of
        ${num(result.total)} products &mdash; ${esc(result.description)}`;
    } catch (err) {
      if (mine !== seq) return;
      preview.textContent = err.message;
    }
  }

  draw();
  void emit();
  // Exposed on the element too, so a form elsewhere on the page can read the
  // current rule without holding a reference to the builder.
  container.__selector = selector;
  return { selector };
}

function clauseHtml(clause, index) {
  const kind = fieldKind(clause.field);
  const needsValue = !['exists', 'missing'].includes(clause.op);
  return `<div class="clause">
    <select data-index="${index}" data-part="field">
      ${FIELDS.map((f) =>
        `<option value="${esc(f.value)}"${f.value === clause.field ? ' selected' : ''}>${esc(f.label)}</option>`,
      ).join('')}
    </select>
    <select data-index="${index}" data-part="op">
      ${OPS[kind].map(([op, label]) =>
        `<option value="${op}"${op === clause.op ? ' selected' : ''}>${esc(label)}</option>`,
      ).join('')}
    </select>
    ${needsValue ? valueControl(clause, index, kind) : '<span></span>'}
    <button class="btn btn--sm btn--danger" data-remove="${index}" type="button"
      aria-label="Remove condition">&times;</button>
  </div>`;
}

function valueControl(clause, index, kind) {
  if (kind === 'boolean') {
    return `<select data-index="${index}" data-part="value">
      <option value="true"${String(clause.value) === 'true' ? ' selected' : ''}>yes</option>
      <option value="false"${String(clause.value) === 'false' ? ' selected' : ''}>no</option>
    </select>`;
  }
  const type = kind === 'number' ? 'number' : kind === 'date' ? 'date' : 'text';
  const placeholder = clause.op === 'in' ? 'comma, separated, values' : '';
  const main = `<input data-index="${index}" data-part="value" type="${clause.op === 'in' ? 'text' : type}"
    value="${esc(clause.value ?? '')}" placeholder="${esc(placeholder)}">`;
  if (clause.op !== 'between') return main;
  return `<span style="display:flex;gap:5px">
    ${main}
    <input data-index="${index}" data-part="to" type="number" value="${esc(clause.to ?? '')}" placeholder="to">
  </span>`;
}
