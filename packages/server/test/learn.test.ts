import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { learnAttributes } from '../src/ingest/learn.js';
import { inferMapping } from '../src/ingest/mapping.js';
import type { SourceRow } from '../src/ingest/normalize.js';

/**
 * Inferring product data is only worth doing if it is trustworthy, and most of
 * these are about the refusals rather than the recoveries. A blank cell costs
 * one product one filter; a wrong cell is believed by search, facets,
 * merchandising rules and the shopper, and nobody ever finds out.
 */

const HEADERS = ['SKU', 'Display Name', 'Sales Description', 'Commerce Category',
  'Keywords', 'Material', 'Finish', 'Style'];

function run(rows: Record<string, string>[]) {
  const filled = rows.map((r) => {
    const full: SourceRow = {};
    for (const h of HEADERS) full[h] = r[h] ?? '';
    return full;
  });
  const report = learnAttributes(filled, inferMapping(HEADERS));
  return { rows: filled, report };
}

/** Enough populated rows to teach the vocabulary, in one category. */
function teach(category = 'Exterior > Shutters'): Record<string, string>[] {
  return [
    { SKU: 'T1', 'Display Name': 'Joined PVC Shutter', 'Commerce Category': category,
      Material: 'PVC', Finish: 'Black', Style: 'Joined' },
    { SKU: 'T2', 'Display Name': 'Spaced Cedar Shutter', 'Commerce Category': category,
      Material: 'Western Red Cedar', Finish: 'Hunter Green', Style: 'Spaced' },
  ];
}

describe('learning the vocabulary from the catalogue', () => {
  test('a value stated in a title fills the column it was missing from', () => {
    const { rows, report } = run([
      ...teach(),
      { SKU: 'A1', 'Display Name': 'Spaced PVC Shutter', 'Commerce Category': 'Exterior > Shutters' },
    ]);
    assert.equal(rows[2]!.Material, 'PVC');
    assert.equal(rows[2]!.Style, 'Spaced');
    assert.equal(report.filled, 2);
  });

  test('the vocabulary is whatever the feed contains, not a list of known words', () => {
    // Nothing here knows what a millwork finish is, which is the point: the
    // same code works on a catalogue of shoes.
    const headers = ['SKU', 'Display Name', 'Commerce Category', 'Scent'];
    const rows: SourceRow[] = [
      { SKU: 'S1', 'Display Name': 'Bergamot Candle', 'Commerce Category': 'Home', Scent: 'Bergamot' },
      { SKU: 'S2', 'Display Name': 'Oud Candle', 'Commerce Category': 'Home', Scent: '' },
      { SKU: 'S3', 'Display Name': 'Bergamot Diffuser', 'Commerce Category': 'Home', Scent: '' },
    ];
    learnAttributes(rows, inferMapping(headers));
    assert.equal(rows[2]!.Scent, 'Bergamot');
    // "Oud" was never stated in a column, so it is not a scent this catalogue
    // knows about, and inventing it would be guessing.
    assert.equal(rows[1]!.Scent, '');
  });

  test('a stated value is never overwritten, however the text reads', () => {
    const { rows } = run([
      ...teach(),
      { SKU: 'A1', 'Display Name': 'Joined PVC Shutter', 'Commerce Category': 'Exterior > Shutters',
        Material: 'Western Red Cedar' },
    ]);
    assert.equal(rows[2]!.Material, 'Western Red Cedar', 'the source is the authority');
  });
});

describe('refusing to guess', () => {
  test('two values of one attribute in the same text means it does not say', () => {
    const { rows, report } = run([
      ...teach(),
      { SKU: 'A1', 'Display Name': 'Shutter', 'Commerce Category': 'Exterior > Shutters',
        'Sales Description': 'Western Red Cedar frame with a PVC insert' },
    ]);
    assert.equal(rows[2]!.Material, '');
    assert.equal(report.declined, 1);
  });

  test('the title settles what a rambling description muddies', () => {
    // Real descriptions name materials the product is not made of — "cellular
    // PVC that will not rot" sits under a cedar shutter. The title is curated
    // and it is consulted first.
    const { rows } = run([
      ...teach(),
      { SKU: 'A1', 'Display Name': 'Joined Western Red Cedar Shutter',
        'Commerce Category': 'Exterior > Shutters',
        'Sales Description': 'Unlike PVC, Western Red Cedar takes stain beautifully' },
    ]);
    assert.equal(rows[2]!.Material, 'Western Red Cedar');
  });

  test('a word two attributes both use is left alone while both are empty', () => {
    const headers = ['SKU', 'Display Name', 'Commerce Category', 'Finish', 'Colour'];
    const rows: SourceRow[] = [
      { SKU: 'T1', 'Display Name': 'A', 'Commerce Category': 'X', Finish: 'Black', Colour: 'Red' },
      { SKU: 'T2', 'Display Name': 'B', 'Commerce Category': 'X', Finish: 'Bronze', Colour: 'Black' },
      { SKU: 'A1', 'Display Name': 'Black Shutter', 'Commerce Category': 'X', Finish: '', Colour: '' },
    ];
    const report = learnAttributes(rows, inferMapping(headers));
    assert.equal(rows[2]!.Finish, '');
    assert.equal(rows[2]!.Colour, '');
    assert.ok(report.declined > 0);
  });

  test('...but is assigned when only one of the two is still empty', () => {
    const headers = ['SKU', 'Display Name', 'Commerce Category', 'Finish', 'Colour'];
    const rows: SourceRow[] = [
      { SKU: 'T1', 'Display Name': 'A', 'Commerce Category': 'X', Finish: 'Black', Colour: 'Red' },
      { SKU: 'T2', 'Display Name': 'B', 'Commerce Category': 'X', Finish: 'Bronze', Colour: 'Black' },
      { SKU: 'A1', 'Display Name': 'Black Shutter', 'Commerce Category': 'X', Finish: '', Colour: 'Red' },
    ];
    learnAttributes(rows, inferMapping(headers));
    assert.equal(rows[2]!.Finish, 'Black');
  });

  test('a value is matched as a word, not as a run of letters', () => {
    const { rows } = run([
      ...teach(),
      { SKU: 'A1', 'Display Name': 'Shutter model PVCX-400',
        'Commerce Category': 'Exterior > Shutters' },
    ]);
    assert.equal(rows[2]!.Material, '', 'PVC must not fire inside a part number');
  });
});

describe('the same word in a different aisle', () => {
  test('a style belonging to another category is not a candidate here', () => {
    // "Board and Batten" is a style of wall panel and the name of a kind of
    // shutter. A shutter title containing it names one known style it could
    // be — Joined — and one it could not.
    const headers = ['SKU', 'Display Name', 'Commerce Category', 'Style'];
    const rows: SourceRow[] = [
      { SKU: 'W1', 'Display Name': 'Board and Batten Panel',
        'Commerce Category': 'Interior > Wall Panels', Style: 'Board and Batten' },
      { SKU: 'S1', 'Display Name': 'Joined Board and Batten Shutter',
        'Commerce Category': 'Exterior > Shutters', Style: 'Joined' },
      { SKU: 'S2', 'Display Name': 'Joined Board and Batten Shutter',
        'Commerce Category': 'Exterior > Shutters', Style: '' },
    ];
    learnAttributes(rows, inferMapping(headers));
    assert.equal(rows[2]!.Style, 'Joined');
  });

  test('a category with no vocabulary of its own falls back to the catalogue', () => {
    const { rows } = run([
      ...teach(),
      // Filed nowhere, which the generator's own defects produce.
      { SKU: 'A1', 'Display Name': 'Joined PVC Shutter', 'Commerce Category': '' },
    ]);
    assert.equal(rows[2]!.Material, 'PVC');
  });
});

describe('overlapping values', () => {
  test('the longer value wins rather than reading as a disagreement', () => {
    const headers = ['SKU', 'Display Name', 'Commerce Category', 'Finish'];
    const rows: SourceRow[] = [
      { SKU: 'T1', 'Display Name': 'A', 'Commerce Category': 'X', Finish: 'Primed White' },
      { SKU: 'T2', 'Display Name': 'B', 'Commerce Category': 'X', Finish: 'White Oak' },
      { SKU: 'A1', 'Display Name': 'Primed White Column', 'Commerce Category': 'X', Finish: '' },
    ];
    learnAttributes(rows, inferMapping(headers));
    assert.equal(rows[2]!.Finish, 'Primed White');
  });
});

describe('measurements', () => {
  test('a labelled cross-section in a title fills width and height', () => {
    const headers = ['SKU', 'Display Name', 'Commerce Category', 'Width', 'Height'];
    const rows: SourceRow[] = [
      { SKU: 'B1', 'Display Name': 'Rustic 6"W x 8"H Faux Beam',
        'Commerce Category': 'Beams', Width: '', Height: '' },
    ];
    learnAttributes(rows, inferMapping(headers));
    assert.equal(rows[0]!.Width, '6 in');
    assert.equal(rows[0]!.Height, '8 in');
  });

  test('a bare 4x6 in a title is not given axes on a guess', () => {
    // It could be a section, a pack count or part of a model name, and a wrong
    // number in a dimension filter silently excludes rather than fails.
    const headers = ['SKU', 'Display Name', 'Commerce Category', 'Width', 'Height'];
    const rows: SourceRow[] = [
      { SKU: 'B1', 'Display Name': 'Rustic 4x6 Faux Beam',
        'Commerce Category': 'Beams', Width: '', Height: '' },
    ];
    learnAttributes(rows, inferMapping(headers));
    assert.equal(rows[0]!.Width, '');
  });

  test('a stated dimension is left alone', () => {
    const headers = ['SKU', 'Display Name', 'Commerce Category', 'Width', 'Height'];
    const rows: SourceRow[] = [
      { SKU: 'B1', 'Display Name': 'Rustic 6"W x 8"H Faux Beam',
        'Commerce Category': 'Beams', Width: '5.5 in', Height: '' },
    ];
    learnAttributes(rows, inferMapping(headers));
    assert.equal(rows[0]!.Width, '5.5 in');
    assert.equal(rows[0]!.Height, '8 in');
  });
});

describe('reporting what it did', () => {
  test('every recovery is counted by attribute and by where it was read from', () => {
    const { report } = run([
      ...teach(),
      { SKU: 'A1', 'Display Name': 'Spaced PVC Shutter', 'Commerce Category': 'Exterior > Shutters' },
      { SKU: 'A2', 'Display Name': 'Shutter', 'Commerce Category': 'Exterior > Shutters',
        Keywords: 'Shutter|Hunter Green' },
    ]);
    assert.equal(report.byKey.material, 1);
    assert.equal(report.byKey.style, 1);
    assert.equal(report.byKey.finish, 1);
    assert.equal(report.bySource.title, 2);
    assert.equal(report.bySource.tags, 1);
    assert.equal(report.rowsChanged, 2);
    // A merchandiser has to be able to see individual claims, not just totals.
    assert.ok(report.samples.some((s) => s.sku === 'A2' && s.value === 'Hunter Green'));
  });

  test('the sample shows the range of what was claimed, not the same claim repeatedly', () => {
    // Every variant of a product repeats its parent's material, so an
    // unfiltered sample is one product over and over.
    const variants = Array.from({ length: 40 }, (_, i) => ({
      SKU: `V${i}`, 'Display Name': 'Spaced PVC Shutter',
      'Commerce Category': 'Exterior > Shutters',
    }));
    const { report } = run([...teach(), ...variants]);
    assert.equal(report.filled, 80, 'every variant is still filled in');
    const materials = report.samples.filter((s) => s.key === 'material');
    assert.ok(materials.length <= 2, `sampled PVC ${materials.length} times`);
  });
});

describe('attributes that exist nowhere but in prose', () => {
  /**
   * Shaped after a real NetSuite export of gable vents: columns for internal
   * id, record type, description and name, with the material, style and frame
   * stated only inside the description as labelled pairs. Four attributes
   * every shopper filters on, and not a column between them.
   */
  const HEADERS = ['Internal ID', 'Type', 'Description', 'Name'];
  const vent = (id: string, description: string): SourceRow => ({
    'Internal ID': id, Type: 'Assembly/Bill of Materials',
    Description: description, Name: `GVP-${id}`,
  });

  function ventRows(n: number, description: string): SourceRow[] {
    return Array.from({ length: n }, (_, i) => vent(String(i), description));
  }

  test('a labelled pair used across the feed becomes a real attribute', () => {
    const rows = ventRows(20,
      'TrueCraft STYLE: Arch Top Gable Vent  TYPE: Functional  MATERIAL: PVC'
      + '  FRAME: 1" x 4" Flat Trim Frame');
    const mapping = inferMapping(HEADERS);
    const report = learnAttributes(rows, mapping);

    assert.equal(rows[0]!['learned:material'], 'PVC');
    assert.equal(rows[0]!['learned:style'], 'Arch Top Gable Vent');
    assert.equal(rows[0]!['learned:frame'], '1" x 4" Flat Trim Frame');
    // The column has to exist in the mapping too, or nothing downstream —
    // facets, filters, merchandising rules — can see it.
    assert.equal(mapping.attributes.material, 'learned:material');
    assert.ok(mapping.facetable?.includes('material'));
    assert.ok(report.discovered.material);
  });

  test('only the shouted word before the colon is the label', () => {
    // In "MATERIAL: PVC  FRAME: Standard", PVC is the previous value.
    const rows = ventRows(20, 'MATERIAL: PVC  FRAME: Standard Frame');
    learnAttributes(rows, inferMapping(HEADERS));
    assert.equal(rows[0]!['learned:material'], 'PVC');
    assert.equal(rows[0]!['learned:frame'], 'Standard Frame');
    assert.equal(rows[0]!['learned:pvc frame'], undefined);
  });

  test('a template placeholder is a form, not a value', () => {
    // 26 of the 711 real rows carry exactly this.
    const rows = ventRows(20, 'SIZE (RO): __"W X __"H  MATERIAL: PVC');
    learnAttributes(rows, inferMapping(HEADERS));
    assert.equal(rows[0]!['learned:size'], undefined);
    assert.equal(rows[0]!['learned:material'], 'PVC');
  });

  test('one stray colon does not add a column to the catalogue', () => {
    const rows = [...ventRows(40, 'A plain description with no labels'),
      vent('x', 'NOTE: shipped flat')];
    const mapping = inferMapping(HEADERS);
    learnAttributes(rows, mapping);
    assert.equal(mapping.attributes.note, undefined);
  });

  test('lower-case prose and clock times are not labels', () => {
    const rows = ventRows(20, 'Ships by 12:30 daily. note: paintable surface.');
    const mapping = inferMapping(HEADERS);
    learnAttributes(rows, mapping);
    assert.deepEqual(Object.keys(mapping.attributes).filter((k) => k.startsWith('learned')), []);
    assert.equal(Object.keys(mapping.attributes).some((k) => k === 'note'), false);
  });

  test('an attribute the feed already has a column for is not duplicated', () => {
    // Otherwise the facet splits in two and neither half is complete.
    const headers = [...HEADERS, 'Material'];
    const rows = ventRows(20, 'MATERIAL: PVC').map((r) => ({ ...r, Material: 'Cedar' }));
    const mapping = inferMapping(headers);
    learnAttributes(rows, mapping);
    assert.equal(mapping.attributes.material, 'Material');
    assert.equal(rows[0]!.Material, 'Cedar', 'the stated column still wins');
  });
});
