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
 * A 2- or 3-part cross-section: `4x6`, `4"x6"`, `4x6x12`, `4 x 6 x 12 ft`,
 * and the labelled form the catalogue writes its own titles in — `6"W x 8"H`.
 *
 * Parts map to width, height and (when present) length by position, unless a
 * part names its own axis, in which case that wins. The labelled form matters
 * more than it looks: pasting a product title into the search box is one of
 * the most common things a shopper does, and until the axis letters were
 * allowed for, `6"W x 8"H Endurathane Beam` matched no cross-section at all
 * and left `6"w x 8"h` sitting in the search text as words.
 */
const AXIS_LETTER = '[whdl]';
const CROSS_SECTION = new RegExp(
  String.raw`\b(${NUMBER_SRC})\s*(${UNIT_PATTERN})?(?:\s*(${AXIS_LETTER})\b)?\s*[x×]` +
    String.raw`\s*(${NUMBER_SRC})\s*(${UNIT_PATTERN})?(?:\s*(${AXIS_LETTER})\b)?` +
    String.raw`(?:\s*[x×]\s*(${NUMBER_SRC})\s*(${UNIT_PATTERN})?(?:\s*(${AXIS_LETTER})\b)?)?`,
  'gi',
);

/** `W` -> width, and so on, for the labelled cross-section form. */
const LETTER_TO_FIELD: Record<string, string> = {
  w: 'width_in', h: 'height_in', d: 'height_in', l: 'length_in',
};

/** Where each part of an unlabelled cross-section lands, by position. */
const POSITIONAL_FIELDS = ['width_in', 'height_in', 'length_in'];

/**
 * Words that say which axis a measurement is on.
 *
 * A shopper does not type "12 ft beam" so much as "12 foot long beam", and
 * before this the word `long` survived into the search text, matched no
 * product, and sent the query into the zero-result rescue — which dropped the
 * length filter and returned every beam in the catalogue, four-foot ones
 * included. The phrasing that read most naturally was the one that worked
 * worst, and nothing about the result page said so.
 *
 * Mapped to the axes the engines actually filter on. `depth` folds into height
 * because that is already how the engines read it: a document's height is
 * looked up as height, then depth. `thick` and `across` name axes no engine
 * stores separately, so they are consumed but leave the constraint as it was —
 * removing the word is the fix; claiming a precision the index cannot honour
 * would not be.
 */
const AXIS_WORDS: Record<string, string | null> = {
  long: 'length_in', length: 'length_in', lengths: 'length_in',
  wide: 'width_in', width: 'width_in',
  tall: 'height_in', high: 'height_in', height: 'height_in',
  deep: 'height_in', depth: 'height_in',
  thick: null, thickness: null, across: null, diameter: null,
};

const AXIS_PATTERN = Object.keys(AXIS_WORDS).sort((a, b) => b.length - a.length).join('|');

/**
 * A standalone measurement with an explicit unit: `12 ft`, `3-1/2"`, `48in`,
 * optionally with the axis named on either side: `length 48in`, `12 ft long`,
 * `24 inches in width`.
 */
const STANDALONE = new RegExp(
  String.raw`(?:\b(${AXIS_PATTERN})\s*:?\s+)?` +
    String.raw`\b(${NUMBER_SRC})\s*(${UNIT_PATTERN})(?![a-z])` +
    String.raw`(?:\s+(?:in\s+)?(${AXIS_PATTERN})\b)?`,
  'gi',
);

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
    const [source, aRaw, aUnit, aAxis, bRaw, bUnit, bAxis, cRaw, cUnit, cAxis] = m;
    const parts = [[aRaw, aUnit, aAxis], [bRaw, bUnit, bAxis], [cRaw, cUnit, cAxis]] as const;

    const lifted: ParsedConstraint[] = [];
    let position = 0;
    for (const [raw, unit, axis] of parts) {
      if (!raw) continue;
      const n = parseMeasurement(raw);
      if (n === null) continue;
      // A named axis beats the position it happens to sit in, so `8"H x 6"W`
      // is not read as an eight-inch-wide beam. A bare third part is
      // conventionally the length (4x6x120).
      const field = (axis && LETTER_TO_FIELD[axis.toLowerCase()])
        ?? POSITIONAL_FIELDS[position]
        ?? 'length_in';
      lifted.push({ field, value: quantise(toInches(n, unit)), source, kind: 'dimension' });
      position++;
    }
    // Two parts is the minimum that makes a cross-section; one is a lone
    // measurement and the standalone pass below reads it better.
    if (lifted.length < 2) continue;
    constraints.push(...lifted);
    consume(source);
  }

  // Whatever survived the cross-section pass may still hold a lone measurement.
  for (const m of [...residual.matchAll(STANDALONE)]) {
    const [source, leadingAxis, numRaw, unit, trailingAxis] = m;
    const n = parseMeasurement(numRaw!);
    if (n === null) continue;
    const inches = quantise(toInches(n, unit));
    // A lone measurement names a size, not an axis. Feet and metres are the
    // exception — nobody asks for a twelve-foot-wide medallion — so they mean
    // length; everything else has to match whichever axis carries it.
    //
    // This used to also read any measurement of 24 inches or more as a length,
    // on the theory that small numbers are profile sizes. That threshold cost
    // real traffic: "24 inch ceiling medallion" became a strict length filter,
    // medallions carry their diameter as a size rather than a length, nothing
    // matched, and the shopper was dropped into catalogue-wide best sellers
    // with no medallion on the page. The catalogue has 52 of them.
    const isLongForm = /^(ft|foot|feet|'|m)$/i.test(unit!);
    const named = trailingAxis ?? leadingAxis;
    // The shopper naming the axis outranks any inference from the unit.
    const axis = named ? AXIS_WORDS[named.toLowerCase()] : undefined;
    constraints.push({
      field: axis ?? (isLongForm ? 'length_in' : 'any_dimension_in'),
      value: inches,
      source,
      kind: 'unit',
    });
    // The whole phrase goes, axis word included. Leaving "long" behind is what
    // broke this: it is not a word any product carries.
    consume(source);
  }

  return { constraints, residual: residual.replace(/\s+/g, ' ').trim() };
}
