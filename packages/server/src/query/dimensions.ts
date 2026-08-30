import type { ParsedConstraint } from '@compass/shared';

/**
 * Dimension parsing.
 *
 * Millwork shoppers type sizes in every notation a tape measure allows:
 * `4x6`, `4" x 6"`, `12 ft`, `12'`, `12 foot`, `3-1/2 inch`, `3 1/2"`, `1/2in`.
 * All of it normalises to inches so a single numeric filter can serve them.
 */

const UNIT_TO_INCHES: Record<string, number> = {
  '"': 1,
  in: 1,
  inch: 1,
  inches: 1,
  "'": 12,
  ft: 12,
  foot: 12,
  feet: 12,
  mm: 1 / 25.4,
  cm: 1 / 2.54,
  m: 1000 / 25.4,
};

/** Longest-first so `inches` wins over `in` and `feet` over `ft`. */
const UNIT_PATTERN = Object.keys(UNIT_TO_INCHES)
  .sort((a, b) => b.length - a.length)
  .map((u) => u.replace(/[.*+?^${}()|[\]\\"']/g, '\\$&'))
  .join('|');

/** `3-1/2`, `3 1/2`, `1/2`, `3.5`, `12` -> a number. */
const NUMBER_SRC = String.raw`\d+\s*-\s*\d+\s*\/\s*\d+|\d+\s+\d+\s*\/\s*\d+|\d+\s*\/\s*\d+|\d+(?:\.\d+)?`;

export function parseMeasurement(raw: string): number | null {
  const s = raw.trim().replace(/\s+/g, ' ');
  // Mixed number: "3-1/2" or "3 1/2"
  const mixed = s.match(new RegExp(String.raw`^(\d+)\s*[-\s]\s*(\d+)\s*\/\s*(\d+)$`));
  if (mixed) {
    const [, whole, num, den] = mixed;
    const d = Number(den);
    if (!d) return null;
    return Number(whole) + Number(num) / d;
  }
  // Bare fraction: "1/2"
  const frac = s.match(new RegExp(String.raw`^(\d+)\s*\/\s*(\d+)$`));
  if (frac) {
    const d = Number(frac[2]);
    if (!d) return null;
    return Number(frac[1]) / d;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function toInches(value: number, unit?: string): number {
  if (!unit) return value;
  const factor = UNIT_TO_INCHES[unit.toLowerCase()];
  return factor === undefined ? value : value * factor;
}

/** Round to 1/16" so 3.4999999 and 3.5 compare equal downstream. */
function quantise(inches: number): number {
  return Math.round(inches * 16) / 16;
}

export interface DimensionMatch {
  constraints: ParsedConstraint[];
  /** The query with all consumed dimension text removed. */
  residual: string;
}

/**
 * A 2- or 3-part cross-section: `4x6`, `4"x6"`, `4x6x12`, `4 x 6 x 12 ft`.
 * Parts map to width, height and (when present) length.
 */
const CROSS_SECTION = new RegExp(
  String.raw`\b(${NUMBER_SRC})\s*(${UNIT_PATTERN})?\s*[x×]\s*(${NUMBER_SRC})\s*(${UNIT_PATTERN})?` +
    String.raw`(?:\s*[x×]\s*(${NUMBER_SRC})\s*(${UNIT_PATTERN})?)?`,
  'gi',
);

/** A standalone measurement with an explicit unit: `12 ft`, `3-1/2"`, `48in`. */
const STANDALONE = new RegExp(String.raw`\b(${NUMBER_SRC})\s*(${UNIT_PATTERN})(?![a-z])`, 'gi');

/**
 * A bare number is only a length when the shopper said so: `12 foot beam`
 * already carries a unit, but `beam 12` is ambiguous and stays a search term.
 */
export function parseDimensions(query: string): DimensionMatch {
  const constraints: ParsedConstraint[] = [];
  let residual = query;
  const consume = (source: string) => {
    residual = residual.replace(source, ' ');
  };

  for (const m of query.matchAll(CROSS_SECTION)) {
    const [source, aRaw, aUnit, bRaw, bUnit, cRaw, cUnit] = m;
    const a = parseMeasurement(aRaw!);
    const b = parseMeasurement(bRaw!);
    if (a === null || b === null) continue;
    constraints.push(
      { field: 'width_in', value: quantise(toInches(a, aUnit)), source, kind: 'dimension' },
      { field: 'height_in', value: quantise(toInches(b, bUnit)), source, kind: 'dimension' },
    );
    if (cRaw) {
      const c = parseMeasurement(cRaw);
      if (c !== null) {
        // A bare third part is conventionally length in inches (4x6x120).
        constraints.push({
          field: 'length_in',
          value: quantise(toInches(c, cUnit)),
          source,
          kind: 'dimension',
        });
      }
    }
    consume(source);
  }

  // Whatever survived the cross-section pass may still hold a lone measurement.
  for (const m of [...residual.matchAll(STANDALONE)]) {
    const [source, numRaw, unit] = m;
    const n = parseMeasurement(numRaw!);
    if (n === null) continue;
    const inches = quantise(toInches(n, unit));
    // Feet/metres are length units in this catalogue; inches under 24 are
    // usually a profile size, so they stay generic and match any dimension.
    const isLongForm = /^(ft|foot|feet|'|m)$/i.test(unit!);
    constraints.push({
      field: isLongForm || inches >= 24 ? 'length_in' : 'any_dimension_in',
      value: inches,
      source,
      kind: 'unit',
    });
    consume(source);
  }

  return { constraints, residual: residual.replace(/\s+/g, ' ').trim() };
}
