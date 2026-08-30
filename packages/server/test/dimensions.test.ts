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

  test('a long measurement in inches is treated as a length', () => {
    assert.deepEqual(constraintMap('beam 120 in'), { length_in: 120 });
  });

  test('the residual keeps the search terms and drops the sizes', () => {
    const { residual } = parseDimensions('4x6 walnut beam 12ft');
    assert.equal(residual, 'walnut beam');
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
