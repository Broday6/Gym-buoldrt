import type { Product, Variant } from '@compass/shared';

/**
 * Product selectors.
 *
 * The rule language behind dynamic collections and custom attribute values. It
 * is deliberately small and declarative rather than an expression string: a
 * merchandiser builds these in a form, so every clause has to round-trip
 * cleanly to and from UI controls, and a malformed rule has to be a validation
 * error rather than a runtime surprise.
 *
 * A selector is evaluated against a PARENT product. Variant-level fields match
 * if ANY variant satisfies them, because a product belongs in "Black Exterior"
 * if it is available in black — not only if every variant is.
 */

export type Comparator =
  | 'equals' | 'not_equals'
  | 'contains' | 'not_contains'
  | 'starts_with'
  | 'in' | 'not_in'
  | 'gt' | 'gte' | 'lt' | 'lte'
  | 'between'
  | 'exists' | 'missing';

export interface Condition {
  /**
   * Dotted path. Parent fields (`title`, `brand`, `categoryPath`, `margin`,
   * `salesVelocity`, `tags`, `dateAdded`) or a variant field prefixed
   * `variant.` (`variant.price`, `variant.inventory`, `variant.attrs.finish`).
   */
  field: string;
  op: Comparator;
  value?: string | number | boolean | (string | number)[];
  /** For `between`. */
  to?: number;
}

export interface Selector {
  /** Every clause must match. */
  all?: (Condition | Selector)[];
  /** At least one clause must match. */
  any?: (Condition | Selector)[];
  /** No clause may match. */
  none?: (Condition | Selector)[];
}

export class SelectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SelectorError';
  }
}

const COMPARATORS = new Set<Comparator>([
  'equals', 'not_equals', 'contains', 'not_contains', 'starts_with',
  'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'between', 'exists', 'missing',
]);

/** Reject a malformed selector at write time, not at ingest time. */
export function validateSelector(selector: unknown, depth = 0): Selector {
  if (depth > 5) throw new SelectorError('selector is nested too deeply');
  if (!selector || typeof selector !== 'object') throw new SelectorError('selector must be an object');
  const node = selector as Record<string, unknown>;
  const groups = ['all', 'any', 'none'].filter((k) => node[k] !== undefined);
  if (groups.length === 0) {
    throw new SelectorError('selector needs at least one of all, any or none');
  }
  for (const group of groups) {
    const clauses = node[group];
    if (!Array.isArray(clauses) || clauses.length === 0) {
      throw new SelectorError(`"${group}" must be a non-empty array`);
    }
    for (const clause of clauses) {
      if (clause && typeof clause === 'object' && 'field' in (clause as object)) {
        validateCondition(clause as Condition);
      } else {
        validateSelector(clause, depth + 1);
      }
    }
  }
  return selector as Selector;
}

function validateCondition(condition: Condition): void {
  if (!condition.field || typeof condition.field !== 'string') {
    throw new SelectorError('every condition needs a field');
  }
  if (!COMPARATORS.has(condition.op)) {
    throw new SelectorError(`unknown comparator "${condition.op}"`);
  }
  const needsValue = condition.op !== 'exists' && condition.op !== 'missing';
  if (needsValue && condition.value === undefined) {
    throw new SelectorError(`"${condition.op}" needs a value`);
  }
  if ((condition.op === 'in' || condition.op === 'not_in') && !Array.isArray(condition.value)) {
    throw new SelectorError(`"${condition.op}" needs an array of values`);
  }
  if (condition.op === 'between' && (typeof condition.value !== 'number' || typeof condition.to !== 'number')) {
    throw new SelectorError('"between" needs numeric value and to');
  }
}

export function matches(product: Product, selector: Selector): boolean {
  if (selector.all && !selector.all.every((c) => evaluate(product, c))) return false;
  if (selector.any && !selector.any.some((c) => evaluate(product, c))) return false;
  if (selector.none && selector.none.some((c) => evaluate(product, c))) return false;
  // An empty selector matches nothing, which is the safe direction: a rule the
  // merchandiser has not finished writing should not sweep in the catalogue.
  return Boolean(selector.all || selector.any || selector.none);
}

function evaluate(product: Product, clause: Condition | Selector): boolean {
  if ('field' in clause) return evaluateCondition(product, clause);
  return matches(product, clause);
}

function evaluateCondition(product: Product, condition: Condition): boolean {
  if (condition.field.startsWith('variant.')) {
    const path = condition.field.slice('variant.'.length);
    // Any variant satisfying it puts the product in scope.
    return product.variants.some((v) => compare(variantValue(v, path), condition));
  }
  return compare(parentValue(product, condition.field), condition);
}

function parentValue(product: Product, field: string): unknown {
  switch (field) {
    case 'title': return product.title;
    case 'description': return product.description;
    case 'brand': return product.brand;
    case 'categoryPath': return product.categoryPath;
    case 'categoryIds': return product.categoryIds;
    case 'tags': return product.tags;
    case 'reviewScore': return product.reviewScore;
    case 'reviewCount': return product.reviewCount;
    case 'salesVelocity': return product.salesVelocity;
    case 'margin': return product.margin;
    case 'dateAdded': return product.dateAdded;
    case 'parentId': return product.parentId;
    case 'variantCount': return product.variants.length;
    // Aggregates across variants, which is how a merchandiser thinks about a
    // product: "under $100" means its cheapest variant is.
    case 'minPrice': return Math.min(...product.variants.map(effectivePrice));
    case 'maxPrice': return Math.max(...product.variants.map(effectivePrice));
    case 'inStock': return product.variants.some((v) => (v.inventory ?? 0) > 0);
    case 'totalInventory': return product.variants.reduce((n, v) => n + (v.inventory ?? 0), 0);
    case 'onSale': return product.variants.some((v) => (v.salePrice ?? 0) > 0 && v.salePrice! < v.price);
    default:
      return undefined;
  }
}

function variantValue(variant: Variant, path: string): unknown {
  if (path.startsWith('attrs.')) return variant.attributes?.[path.slice('attrs.'.length)];
  switch (path) {
    case 'sku': return variant.sku;
    case 'mpn': return variant.mpn;
    case 'price': return variant.price;
    case 'salePrice': return variant.salePrice;
    case 'effectivePrice': return effectivePrice(variant);
    case 'inventory': return variant.inventory;
    case 'variantTitle': return variant.variantTitle;
    case 'discontinued': return variant.discontinued;
    default:
      return undefined;
  }
}

function effectivePrice(variant: Variant): number {
  return variant.salePrice && variant.salePrice > 0 ? variant.salePrice : variant.price;
}

function compare(actual: unknown, condition: Condition): boolean {
  const { op, value } = condition;
  if (op === 'exists') return actual !== undefined && actual !== null && actual !== '';
  if (op === 'missing') return actual === undefined || actual === null || actual === '';
  if (actual === undefined || actual === null) return false;

  // An array field satisfies a scalar comparison if any element does, so
  // `categoryPath contains "Beams"` works without the author thinking about it.
  if (Array.isArray(actual)) {
    return actual.some((item) => compare(item, condition));
  }

  switch (op) {
    case 'equals': return normalise(actual) === normalise(value);
    case 'not_equals': return normalise(actual) !== normalise(value);
    case 'contains': return normalise(actual).includes(normalise(value));
    case 'not_contains': return !normalise(actual).includes(normalise(value));
    case 'starts_with': return normalise(actual).startsWith(normalise(value));
    case 'in': return (value as (string | number)[]).some((v) => normalise(v) === normalise(actual));
    case 'not_in': return !(value as (string | number)[]).some((v) => normalise(v) === normalise(actual));
    case 'gt': return numeric(actual) > numeric(value);
    case 'gte': return numeric(actual) >= numeric(value);
    case 'lt': return numeric(actual) < numeric(value);
    case 'lte': return numeric(actual) <= numeric(value);
    case 'between': return numeric(actual) >= numeric(value) && numeric(actual) <= numeric(condition.to);
    default: return false;
  }
}

function normalise(value: unknown): string {
  if (typeof value === 'string') return value.toLowerCase().trim();
  if (value instanceof Date) return value.toISOString();
  return String(value).toLowerCase().trim();
}

function numeric(value: unknown): number {
  if (typeof value === 'number') return value;
  // Dates compare as timestamps, so "added since" rules work.
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  const n = Number(String(value).replace(/[$,%\s]/g, ''));
  return Number.isFinite(n) ? n : Number.NaN;
}

/** Human-readable summary of a selector, for the admin list view. */
export function describeSelector(selector: Selector): string {
  const parts: string[] = [];
  const render = (clauses: (Condition | Selector)[] | undefined, joiner: string): string | null => {
    if (!clauses?.length) return null;
    return clauses
      .map((c) => ('field' in c ? describeCondition(c) : `(${describeSelector(c)})`))
      .join(joiner);
  };
  const all = render(selector.all, ' and ');
  const any = render(selector.any, ' or ');
  const none = render(selector.none, ' or ');
  if (all) parts.push(all);
  if (any) parts.push(`(${any})`);
  if (none) parts.push(`not (${none})`);
  return parts.join(' and ') || 'nothing';
}

function describeCondition(condition: Condition): string {
  const readable: Record<string, string> = {
    equals: 'is', not_equals: 'is not', contains: 'contains', not_contains: 'does not contain',
    starts_with: 'starts with', in: 'is one of', not_in: 'is none of',
    gt: '>', gte: '≥', lt: '<', lte: '≤', between: 'between', exists: 'is set', missing: 'is not set',
  };
  const op = readable[condition.op] ?? condition.op;
  if (condition.op === 'exists' || condition.op === 'missing') return `${condition.field} ${op}`;
  if (condition.op === 'between') return `${condition.field} ${op} ${condition.value} and ${condition.to}`;
  const value = Array.isArray(condition.value) ? condition.value.join(', ') : condition.value;
  return `${condition.field} ${op} ${value}`;
}
