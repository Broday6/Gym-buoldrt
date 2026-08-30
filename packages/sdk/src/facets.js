import { esc } from './results.js';

/**
 * Faceted navigation.
 *
 * Two behaviours from one widget, because desktop and mobile want opposite
 * things:
 *
 *   Desktop — results update the moment a value is ticked. The grid is visible
 *   beside the filters, so the feedback is immediate and an apply button would
 *   just be an extra click.
 *
 *   Mobile — the filters take over the screen, selections are staged, and a
 *   sticky "Show N Results" button applies them. Live-updating a grid the
 *   shopper cannot see, behind a panel they have to dismiss, is disorienting;
 *   the count on the button is what tells them whether the filter was a good
 *   idea before they commit to it.
 *
 * Logic is OR within a group and AND across groups, which is why a group's own
 * selection is excluded from its own counts server-side — ticking "Walnut" must
 * not make every other finish disappear.
 */

const DEFAULTS = {
  mobileBreakpoint: 900,
  showMoreStep: 8,
};

export class FacetsWidget {
  constructor(options) {
    this.container = resolve(options.container);
    if (!this.container) throw new Error('FacetsWidget requires a container element');
    this.config = { ...DEFAULTS, ...options };
    this.onChange = options.onChange ?? (() => {});
    this.onPreview = options.onPreview ?? null;

    this.applied = {};      // what the results currently reflect
    this.staged = {};       // mobile: what the shopper has ticked but not applied
    this.ranges = {};
    this.stagedRanges = {};
    // Merchandiser-defined attributes travel separately from catalogue fields,
    // so a custom facet called "material" can never collide with the real one.
    this.appliedLabels = {};
    this.stagedLabels = {};
    this.customFields = new Set();
    this.facets = [];
    this.expanded = new Set();
    this.collapsed = new Set();
    this.modalOpen = false;
    this.previewCount = null;

    this.container.classList.add('compass-facets');
    this.container.addEventListener('change', (e) => this.onControlChange(e));
    this.container.addEventListener('click', (e) => this.onClick(e));
    this.container.addEventListener('input', (e) => this.onRangeInput(e));
  }

  get isMobile() {
    return window.innerWidth <= this.config.mobileBreakpoint;
  }

  /** Selections in flight: staged on mobile, applied everywhere else. */
  get working() {
    return this.isMobile && this.modalOpen ? this.staged : this.applied;
  }

  /** Values currently ticked for a field, regardless of which bag it is in. */
  selectedValues(field) {
    const staged = this.isMobile && this.modalOpen;
    return this.bagFor(field, staged)[field] ?? [];
  }

  get workingRanges() {
    return this.isMobile && this.modalOpen ? this.stagedRanges : this.ranges;
  }

  update(response) {
    this.facets = response.facets ?? [];
    this.applied = cloneFilters(response.appliedFilters ?? {});
    this.customFields = new Set(this.facets.filter((f) => f.custom).map((f) => f.field));
    this.totalHits = response.totalHits ?? 0;
    if (!this.modalOpen) {
      this.staged = cloneFilters(this.applied);
      this.stagedLabels = cloneFilters(this.appliedLabels);
      this.stagedRanges = { ...this.ranges };
    }
    this.render();
  }

  /** Selections for one field land in whichever bag that field belongs to. */
  bagFor(field, staged) {
    if (this.customFields.has(field)) return staged ? this.stagedLabels : this.appliedLabels;
    return staged ? this.staged : this.applied;
  }

  /** Mobile preview count for the apply button, without applying anything. */
  setPreviewCount(count) {
    this.previewCount = count;
    const button = this.container.querySelector('.compass-facets__apply');
    if (button) button.textContent = this.applyLabel();
  }

  applyLabel() {
    const count = this.previewCount ?? this.totalHits ?? 0;
    return `Show ${count.toLocaleString()} ${count === 1 ? 'Result' : 'Results'}`;
  }

  // ---- rendering ---------------------------------------------------------

  render() {
    const mobile = this.isMobile;
    this.container.dataset.mode = mobile ? 'mobile' : 'desktop';
    this.container.dataset.open = String(this.modalOpen);

    const chips = this.chipsHtml();
    const groups = this.facets.map((facet) => this.groupHtml(facet)).join('');

    if (mobile) {
      this.container.innerHTML = `
        <button type="button" class="compass-facets__trigger" aria-haspopup="dialog"
          aria-expanded="${this.modalOpen}">
          Filter${this.activeCount() ? ` <span class="compass-facets__badge">${this.activeCount()}</span>` : ''}
        </button>
        ${chips}
        <div class="compass-facets__modal" role="dialog" aria-modal="true" aria-label="Filters"
          ${this.modalOpen ? '' : 'hidden'}>
          <div class="compass-facets__modal-head">
            <h2 class="compass-facets__modal-title">Filters</h2>
            <button type="button" class="compass-facets__close" aria-label="Close filters">&times;</button>
          </div>
          <div class="compass-facets__modal-body">${groups}</div>
          <div class="compass-facets__modal-foot">
            <button type="button" class="compass-facets__clear-all">Clear all</button>
            <button type="button" class="compass-facets__apply">${this.applyLabel()}</button>
          </div>
        </div>`;
      return;
    }

    this.container.innerHTML = `
      ${chips}
      <div class="compass-facets__groups">${groups}</div>`;
  }

  chipsHtml() {
    const chips = [];
    for (const [field, values] of [
      ...Object.entries(this.applied),
      ...Object.entries(this.appliedLabels),
    ]) {
      const facet = this.facets.find((f) => f.field === field);
      for (const value of values) {
        const label = facet?.values.find((v) => String(v.value) === String(value))?.label ?? value;
        chips.push(`<button type="button" class="compass-chip" data-clear-value="${esc(value)}"
          data-field="${esc(field)}">
          <span class="compass-chip__label">${esc(facet?.label ?? field)}: ${esc(label)}</span>
          <span class="compass-chip__x" aria-hidden="true">&times;</span>
          <span class="compass-sr-only">Remove filter</span>
        </button>`);
      }
    }
    for (const [field, range] of Object.entries(this.ranges)) {
      const facet = this.facets.find((f) => f.field === field);
      chips.push(`<button type="button" class="compass-chip" data-clear-range="${esc(field)}">
        <span class="compass-chip__label">${esc(facet?.label ?? field)}: ${formatRange(range)}</span>
        <span class="compass-chip__x" aria-hidden="true">&times;</span>
        <span class="compass-sr-only">Remove filter</span>
      </button>`);
    }
    if (chips.length === 0) return '';
    return `<div class="compass-facets__chips">
      ${chips.join('')}
      <button type="button" class="compass-facets__clear-all-inline">Clear all</button>
    </div>`;
  }

  groupHtml(facet) {
    const collapsed = this.collapsed.has(facet.field);
    const body = facet.displayType === 'slider'
      ? this.sliderHtml(facet)
      : this.valuesHtml(facet);
    if (!body) return '';
    const id = `compass-facet-${facet.field}`;
    return `<section class="compass-facet" data-field="${esc(facet.field)}"
      data-type="${esc(facet.displayType)}">
      <h3 class="compass-facet__head">
        <button type="button" class="compass-facet__toggle" aria-expanded="${!collapsed}"
          aria-controls="${id}">
          ${esc(facet.label)}
          <span class="compass-facet__chevron" aria-hidden="true"></span>
        </button>
      </h3>
      <div class="compass-facet__body" id="${id}" ${collapsed ? 'hidden' : ''}>${body}</div>
    </section>`;
  }

  valuesHtml(facet) {
    if (!facet.values?.length) return '';
    const selected = new Set(this.selectedValues(facet.field).map(String));
    const expanded = this.expanded.has(facet.field);
    const limit = expanded ? facet.values.length : Math.min(facet.values.length, this.config.showMoreStep);
    const shown = facet.values.slice(0, limit);

    const items = shown.map((value) => {
      const checked = selected.has(String(value.value));
      const label = value.label ?? String(value.value);
      if (facet.displayType === 'swatch') {
        return `<label class="compass-swatch${checked ? ' is-selected' : ''}" title="${esc(label)} (${value.count})">
          <input type="checkbox" class="compass-sr-only" data-field="${esc(facet.field)}"
            value="${esc(value.value)}" ${checked ? 'checked' : ''}>
          <span class="compass-swatch__dot" style="--swatch:${swatchColor(label)}" aria-hidden="true"></span>
          <span class="compass-swatch__label">${esc(label)}</span>
          <span class="compass-swatch__count">${value.count}</span>
        </label>`;
      }
      return `<label class="compass-check${checked ? ' is-selected' : ''}">
        <input type="checkbox" data-field="${esc(facet.field)}" value="${esc(value.value)}"
          ${checked ? 'checked' : ''}>
        <span class="compass-check__label">${esc(label)}</span>
        <span class="compass-check__count">${value.count.toLocaleString()}</span>
      </label>`;
    });

    const more = facet.values.length > limit
      ? `<button type="button" class="compass-facet__more" data-more="${esc(facet.field)}">
           Show ${facet.values.length - limit} more</button>`
      : expanded && facet.values.length > this.config.showMoreStep
        ? `<button type="button" class="compass-facet__more" data-less="${esc(facet.field)}">Show fewer</button>`
        : '';

    return `<div class="compass-facet__values${facet.displayType === 'swatch' ? ' is-swatches' : ''}">
      ${items.join('')}</div>${more}`;
  }

  sliderHtml(facet) {
    if (!facet.stats) return '';
    const { min, max } = facet.stats;
    if (min >= max) return '';
    const current = this.workingRanges[facet.field] ?? {};
    const lo = current.min ?? min;
    const hi = current.max ?? max;
    // A slider alone cannot express "between 400 and 425"; the number inputs
    // are what make a precise budget expressible.
    return `<div class="compass-range">
      <div class="compass-range__track">
        <input type="range" class="compass-range__input" data-range="${esc(facet.field)}" data-edge="min"
          min="${Math.floor(min)}" max="${Math.ceil(max)}" value="${Math.floor(lo)}"
          aria-label="${esc(facet.label)} minimum">
        <input type="range" class="compass-range__input" data-range="${esc(facet.field)}" data-edge="max"
          min="${Math.floor(min)}" max="${Math.ceil(max)}" value="${Math.ceil(hi)}"
          aria-label="${esc(facet.label)} maximum">
      </div>
      <div class="compass-range__inputs">
        <label class="compass-range__field">
          <span class="compass-sr-only">${esc(facet.label)} minimum</span>
          <input type="number" data-range-number="${esc(facet.field)}" data-edge="min"
            value="${Math.floor(lo)}" min="${Math.floor(min)}" max="${Math.ceil(max)}" inputmode="numeric">
        </label>
        <span class="compass-range__dash" aria-hidden="true">–</span>
        <label class="compass-range__field">
          <span class="compass-sr-only">${esc(facet.label)} maximum</span>
          <input type="number" data-range-number="${esc(facet.field)}" data-edge="max"
            value="${Math.ceil(hi)}" min="${Math.floor(min)}" max="${Math.ceil(max)}" inputmode="numeric">
        </label>
      </div>
    </div>`;
  }

  // ---- interaction -------------------------------------------------------

  onControlChange(event) {
    const checkbox = event.target.closest('input[type="checkbox"][data-field]');
    if (checkbox) {
      this.toggleValue(checkbox.dataset.field, checkbox.value, checkbox.checked);
      return;
    }
    const number = event.target.closest('input[data-range-number]');
    if (number) this.setRangeEdge(number.dataset.rangeNumber, number.dataset.edge, number.value);
  }

  onRangeInput(event) {
    const slider = event.target.closest('input[data-range]');
    if (!slider) return;
    const field = slider.dataset.range;
    const group = this.container.querySelectorAll(`input[data-range="${field}"]`);
    const [minInput, maxInput] = group;
    // Keep the two thumbs from crossing over each other.
    if (slider.dataset.edge === 'min' && Number(slider.value) > Number(maxInput.value)) {
      slider.value = maxInput.value;
    }
    if (slider.dataset.edge === 'max' && Number(slider.value) < Number(minInput.value)) {
      slider.value = minInput.value;
    }
    const numbers = this.container.querySelectorAll(`input[data-range-number="${field}"]`);
    if (numbers[0]) numbers[0].value = minInput.value;
    if (numbers[1]) numbers[1].value = maxInput.value;
  }

  onClick(event) {
    const trigger = event.target.closest('.compass-facets__trigger');
    if (trigger) return this.openModal();

    const close = event.target.closest('.compass-facets__close');
    if (close) return this.closeModal(false);

    const apply = event.target.closest('.compass-facets__apply');
    if (apply) return this.closeModal(true);

    const clearAll = event.target.closest('.compass-facets__clear-all, .compass-facets__clear-all-inline');
    if (clearAll) return this.clearAll();

    const chip = event.target.closest('[data-clear-value]');
    if (chip) return this.toggleValue(chip.dataset.field, chip.dataset.clearValue, false, true);

    const rangeChip = event.target.closest('[data-clear-range]');
    if (rangeChip) return this.clearRange(rangeChip.dataset.clearRange);

    const more = event.target.closest('[data-more]');
    if (more) {
      this.expanded.add(more.dataset.more);
      return this.render();
    }
    const less = event.target.closest('[data-less]');
    if (less) {
      this.expanded.delete(less.dataset.less);
      return this.render();
    }
    const toggle = event.target.closest('.compass-facet__toggle');
    if (toggle) {
      const field = toggle.closest('.compass-facet').dataset.field;
      if (this.collapsed.has(field)) this.collapsed.delete(field);
      else this.collapsed.add(field);
      return this.render();
    }
    const slider = event.target.closest('input[data-range]');
    if (slider) this.commitRange(slider.dataset.range);
  }

  toggleValue(field, value, checked, force = false) {
    const staged = !force && this.isMobile && this.modalOpen;
    const target = this.bagFor(field, staged);
    const values = new Set((target[field] ?? []).map(String));
    if (checked) values.add(String(value));
    else values.delete(String(value));
    if (values.size) target[field] = [...values];
    else delete target[field];

    if (!staged) {
      this.staged = cloneFilters(this.applied);
      this.stagedLabels = cloneFilters(this.appliedLabels);
      this.emit();
    } else {
      this.render();
      this.requestPreview();
    }
  }

  setRangeEdge(field, edge, rawValue) {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) return;
    const target = this.workingRanges;
    target[field] = { ...(target[field] ?? {}), [edge]: value };
    this.commitRange(field);
  }

  commitRange(field) {
    const sliders = this.container.querySelectorAll(`input[data-range="${field}"]`);
    if (sliders.length === 2) {
      this.workingRanges[field] = {
        min: Number(sliders[0].value),
        max: Number(sliders[1].value),
      };
    }
    if (this.isMobile && this.modalOpen) this.requestPreview();
    else this.emit();
  }

  clearRange(field) {
    delete this.ranges[field];
    delete this.stagedRanges[field];
    this.emit();
  }

  clearAll() {
    if (this.isMobile && this.modalOpen) {
      this.staged = {};
      this.stagedLabels = {};
      this.stagedRanges = {};
      this.render();
      this.requestPreview();
      return;
    }
    this.applied = {};
    this.staged = {};
    this.appliedLabels = {};
    this.stagedLabels = {};
    this.ranges = {};
    this.stagedRanges = {};
    this.emit();
  }

  openModal() {
    this.staged = cloneFilters(this.applied);
    this.stagedLabels = cloneFilters(this.appliedLabels);
    this.stagedRanges = { ...this.ranges };
    this.modalOpen = true;
    this.previewCount = this.totalHits;
    document.body.classList.add('compass-facets-locked');
    this.render();
    this.container.querySelector('.compass-facets__close')?.focus();
  }

  closeModal(apply) {
    this.modalOpen = false;
    document.body.classList.remove('compass-facets-locked');
    if (apply) {
      this.applied = cloneFilters(this.staged);
      this.appliedLabels = cloneFilters(this.stagedLabels);
      this.ranges = { ...this.stagedRanges };
      this.emit();
    } else {
      this.render();
    }
    this.container.querySelector('.compass-facets__trigger')?.focus();
  }

  /** Ask the page for a count for the staged selection, without applying it. */
  requestPreview() {
    if (!this.onPreview) return;
    this.onPreview({
      filters: cloneFilters(this.staged),
      labelFilters: cloneFilters(this.stagedLabels),
      ranges: this.rangeList(this.stagedRanges),
    });
  }

  emit() {
    this.onChange({
      filters: cloneFilters(this.applied),
      labelFilters: cloneFilters(this.appliedLabels),
      ranges: this.rangeList(this.ranges),
    });
  }

  rangeList(source) {
    return Object.entries(source).map(([field, r]) => ({ field, ...r }));
  }

  activeCount() {
    const count = (bag) => Object.values(bag).reduce((n, v) => n + v.length, 0);
    return count(this.applied) + count(this.appliedLabels) + Object.keys(this.ranges).length;
  }
}

function cloneFilters(filters) {
  return Object.fromEntries(Object.entries(filters).map(([k, v]) => [k, [...v]]));
}

function formatRange(range) {
  if (range.min !== undefined && range.max !== undefined) return `${range.min} – ${range.max}`;
  if (range.min !== undefined) return `from ${range.min}`;
  return `up to ${range.max}`;
}

/**
 * Best-effort colour for a finish swatch. Real catalogues should map finishes
 * to hex values in the admin console; this is a readable default so a colour
 * facet is never a wall of identical grey dots.
 */
const SWATCH_HINTS = {
  black: '#1b1b1e', white: '#f4f4f5', 'primed white': '#f4f4f5', charcoal: '#3b3f46',
  bronze: '#7a5230', 'oil rubbed bronze': '#4a3728', brass: '#b5893b', 'antique brass': '#9c7736',
  'antique gold': '#c9a227', gold: '#d4af37', nickel: '#b9bcc0', 'polished nickel': '#c8ccd1',
  pewter: '#8e9295', copper: '#b06a3b', walnut: '#5b3a24', espresso: '#3d2b1f',
  'natural pecan': '#a9743f', whitewash: '#e6e1d8', 'weathered gray': '#8d8b86',
  gray: '#8d8b86', grey: '#8d8b86', sage: '#9caf88', 'hunter green': '#2f4f3a',
  green: '#3f6f4a', 'colonial red': '#8b2f2b', red: '#a83232', unfinished: '#c9b79c',
  sand: '#d8c9a9', cedar: '#a86a45', pine: '#d8b98a', crystal: '#e8f1f5',
};

function swatchColor(label) {
  const key = String(label).toLowerCase().trim();
  if (SWATCH_HINTS[key]) return SWATCH_HINTS[key];
  for (const [name, colour] of Object.entries(SWATCH_HINTS)) {
    if (key.includes(name)) return colour;
  }
  // Deterministic fallback so the same finish always gets the same colour.
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) % 360;
  return `hsl(${hash} 32% 62%)`;
}

function resolve(target) {
  if (!target) return null;
  return typeof target === 'string' ? document.querySelector(target) : target;
}
