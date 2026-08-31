import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseDimensions, parseMeasurement, toInches } from '../src/query/dimensions.js';

describe('parseMeasurement', () => {
  const cases: [string, number | null][] = [
    ['12', 12],
    ['3.5', 3.5],
    ['1/2', 0.5],
    ['3-1/2', 3.5],
    ['3 1/2', 3.5],
    ['5-3/4', 5.75],
    ['0/0', null],
    ['abc', null],
  ];
  for (const [input, expected] of cases) {
    test(`"${input}" -> ${expected}`, () => {
      assert.equal(parseMeasurement(input), expected);
    });
  }
});

describe('toInches', () => {
  test('feet in every spelling normalise identically', () => {
    for (const unit of ['ft', 'foot', 'feet', "'"]) {
      assert.equal(toInches(12, unit), 144, `unit "${unit}"`);
    }
  });
  test('metric converts', () => {
    assert.equal(Math.round(toInches(25.4, 'mm') * 100) / 100, 1);
    assert.equal(Math.round(toInches(2.54, 'cm') * 100) / 100, 1);
  });
  test('a missing unit is already inches', () => {
    assert.equal(toInches(6), 6);
  });
});

describe('parseDimensions', () => {
  const constraintMap = (q: string) =>
    Object.fromEntries(parseDimensions(q).constraints.map((c) => [c.field, c.value]));

  test('bare cross-section', () => {
    assert.deepEqual(constraintMap('4x6 beam'), { width_in: 4, height_in: 6 });
  });

  test('cross-section with spaces and inch marks', () => {
    assert.deepEqual(constraintMap('4" x 6" beam'), { width_in: 4, height_in: 6 });
  });

  test('three-part cross-section carries a length', () => {
    assert.deepEqual(constraintMap('4x6x120'), { width_in: 4, height_in: 6, length_in: 120 });
  });

  test('acceptance: "4x6 beam 12ft" parses both size and length', () => {
    assert.deepEqual(constraintMap('4x6 beam 12ft'), {
      width_in: 4,
      height_in: 6,
      length_in: 144,
    });
  });

  test("every spelling of 12 feet agrees", () => {
    for (const q of ['4x6 beam 12ft', "4x6 beam 12'", '4x6 beam 12 foot', '4x6 beam 12 feet']) {
      assert.equal(constraintMap(q).length_in, 144, `query "${q}"`);
    }
  });

  test('fractional inches normalise', () => {
    assert.deepEqual(constraintMap('3-1/2 inch crown moulding'), { any_dimension_in: 3.5 });
  });

  test('a lone measurement in inches matches any axis, however large', () => {
    // This used to become a strict `length_in` filter above 24 inches, on the
    // theory that small numbers are profile sizes and large ones are lengths.
    // The threshold cost real traffic: a ceiling medallion carries its
    // diameter as a size rather than a length, so "24 inch ceiling medallion"
    // filtered on an axis medallions do not have, matched nothing, and fell
    // through to catalogue-wide best sellers.
    assert.deepEqual(constraintMap('beam 120 in'), { any_dimension_in: 120 });
    assert.deepEqual(constraintMap('24 inch ceiling medallion'), { any_dimension_in: 24 });
  });

  test('feet and metres still mean length, because no other axis is spoken of that way', () => {
    // "12 foot beam" is a length and nothing else. Keeping the narrower filter
    // where the unit settles it is what stops the change above from making
    // every measurement vague.
    assert.deepEqual(constraintMap('12 foot beam'), { length_in: 144 });
    assert.deepEqual(constraintMap("beam 10'"), { length_in: 120 });
  });

  test('the residual keeps the search terms and drops the sizes', () => {
    const { residual } = parseDimensions('4x6 walnut beam 12ft');
    assert.equal(residual, 'walnut beam');
  });

  describe('however the shopper phrases the same size', () => {
    // The failure this guards is not that one phrasing returns nothing — it is
    // that they disagree. "12 foot long beam" used to leave the word "long" in
    // the search text, match no product, and get rescued by dropping the
    // length filter: every beam in the catalogue, four-foot ones included, for
    // a shopper who could not have been clearer.
    const SAME = [
      '12 ft beam', "12' beam", '12ft beam', '12 foot beam', '12 feet beam',
      '12 foot long beam', '12 ft long beam', '12 foot long beams',
      'beam 12 ft long', 'beams that are 12 ft', '12 ft long faux wood beam',
      'length 12 ft beam', 'beam 12 feet in length',
    ];
    for (const query of SAME) {
      test(`"${query}" is a 144 inch length`, () => {
        assert.deepEqual(constraintMap(query), { length_in: 144 }, query);
      });
    }

    test('and the axis word never survives into the search text', () => {
      // Whatever is left over is searched for as words, so a stray "long"
      // there is not merely untidy — it is a term no product matches.
      for (const query of SAME) {
        assert.ok(!/\b(long|length|wide|width|tall|high|deep)\b/.test(
          parseDimensions(query).residual,
        ), `"${query}" left "${parseDimensions(query).residual}"`);
      }
    });
  });

  describe('naming the axis', () => {
    test('the word the shopper used picks the axis, over any guess from the unit', () => {
      assert.deepEqual(constraintMap('6 inch wide beam'), { width_in: 6 });
      assert.deepEqual(constraintMap('8 inch tall beam'), { height_in: 8 });
      assert.deepEqual(constraintMap('beam 8 inches in height'), { height_in: 8 });
      // Feet would otherwise be read as a length; "wide" outranks that.
      assert.deepEqual(constraintMap('3 foot wide panel'), { width_in: 36 });
    });

    test('an unnamed axis stays deliberately vague', () => {
      // Matching whichever axis carries the number is the honest reading of
      // "6 inch beam", and narrower than it would be to guess one.
      assert.deepEqual(constraintMap('6 inch beam'), { any_dimension_in: 6 });
    });

    test('an axis word with no measurement is left alone as a search term', () => {
      const { constraints, residual } = parseDimensions('long beam');
      assert.deepEqual(constraints, []);
      assert.equal(residual, 'long beam');
    });
  });

  describe('the labelled cross-section the catalogue writes titles in', () => {
    test('6"W x 8"H is a cross-section, not two loose numbers', () => {
      // Pasting a product title into the search box is among the most common
      // things a shopper does, and this form used to match nothing at all.
      assert.deepEqual(constraintMap('6"W x 8"H Endurathane Faux Wood Beam'),
        { width_in: 6, height_in: 8 });
    });

    test('the letters win over the order they appear in', () => {
      assert.deepEqual(constraintMap('8"H x 6"W beam'), { height_in: 8, width_in: 6 });
    });

    test('the unlabelled form still reads by position', () => {
      assert.deepEqual(constraintMap('4x6 beam'), { width_in: 4, height_in: 6 });
      assert.deepEqual(constraintMap('4x6x120 beam'),
        { width_in: 4, height_in: 6, length_in: 120 });
    });

    test('a labelled section and a length together', () => {
      assert.deepEqual(constraintMap('6"W x 8"H 12 ft long faux wood beam'),
        { width_in: 6, height_in: 8, length_in: 144 });
      assert.equal(parseDimensions('6"W x 8"H 12 ft long faux wood beam').residual,
        'faux wood beam');
    });
  });

  test('a bare number stays a search term, not a filter', () => {
    // "beam 12" is ambiguous; guessing a filter here would hide real results.
    assert.deepEqual(parseDimensions('beam 12').constraints, []);
  });

  test('metric cross-sections convert', () => {
    const map = constraintMap('100mm x 200mm beam');
    assert.equal(Math.round(map.width_in! as number), 4);
    assert.equal(Math.round(map.height_in! as number), 8);
  });
});
