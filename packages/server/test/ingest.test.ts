import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { inferMapping } from '../src/ingest/mapping.js';
import { attributeToNumeric, categoryIdsFor, normalizeRows, toVariantDocs } from '../src/ingest/normalize.js';
import { parseCsv, sniffDelimiter } from '../src/ingest/pipeline.js';

const NETSUITE_HEADERS = [
  'Item Name/Number', 'Parent Item', 'Display Name', 'Sales Description', 'Manufacturer',
  'Commerce Category', 'Base Price', 'Quantity Available', 'Custom Item Field: Finish',
  'Custom Item Field: Width', 'Some Accounting Column',
];

describe('field mapping', () => {
  test('NetSuite saved-search headings map without configuration', () => {
    const m = inferMapping(NETSUITE_HEADERS);
    assert.equal(m.fields.sku, 'Item Name/Number');
    assert.equal(m.fields.title, 'Display Name');
    assert.equal(m.fields.price, 'Base Price');
    assert.equal(m.fields.inventory, 'Quantity Available');
    assert.equal(m.fields.categoryPath, 'Commerce Category');
    assert.equal(m.parentKey, 'Parent Item');
  });

  test('custom item fields become searchable attributes', () => {
    const m = inferMapping(NETSUITE_HEADERS);
    assert.equal(m.attributes.finish, 'Custom Item Field: Finish');
    assert.equal(m.attributes.width, 'Custom Item Field: Width');
  });

  test('every column is kept, but only product-like ones become filters', () => {
    // The policy this reverses kept only headings matching a list of sixteen
    // words, so a ninety-column NetSuite export arrived as six. A field that
    // was never ingested cannot be searched, filtered or shown, and nobody
    // discovers the omission until a shopper asks for it.
    const m = inferMapping(NETSUITE_HEADERS);
    assert.ok(Object.values(m.attributes).includes('Some Accounting Column'),
      'unfamiliar columns are still stored');
    // ...but it is not offered as a facet, and does not reach the search text.
    assert.ok(!(m.facetable ?? []).includes('some_accounting_column'));
    assert.ok((m.facetable ?? []).length > 0, 'the product-like ones are');
  });

  test('plumbing columns are dropped entirely', () => {
    const m = inferMapping(['sku', 'title', 'Internal ID', 'Date Last Modified', 'Finish']);
    assert.ok(!Object.keys(m.attributes).includes('internal_id'));
    assert.ok(!Object.keys(m.attributes).some((k) => k.startsWith('date_last')));
    assert.ok(Object.keys(m.attributes).includes('finish'));
  });

  test('generic feed headings map too', () => {
    const m = inferMapping(['sku', 'title', 'price', 'brand', 'category', 'color']);
    assert.equal(m.fields.sku, 'sku');
    assert.equal(m.fields.brand, 'brand');
    assert.equal(m.attributes.color, 'color');
  });
});

describe('measurement attributes', () => {
  test('dimension attributes gain a numeric inches value', () => {
    assert.equal(attributeToNumeric('width', '4 in'), 4);
    assert.equal(attributeToNumeric('length', '12 ft'), 144);
    assert.equal(attributeToNumeric('height', '3-1/2"'), 3.5);
  });
  test('non-dimension attributes stay text', () => {
    assert.equal(attributeToNumeric('finish', 'Walnut'), undefined);
  });
});

describe('category ids', () => {
  test('one id per level, so browse can target any depth', () => {
    assert.deepEqual(categoryIdsFor(['Millwork', 'Beams', 'Faux Wood Beams']), [
      'millwork', 'millwork/beams', 'millwork/beams/faux-wood-beams',
    ]);
  });
});

const CSV = `Item Name/Number,Parent Item,Display Name,Sales Description,Base Price,Quantity Available,Commerce Category,Custom Item Field: Finish,Custom Item Field: Width,Image URL
SH-BL-1,SH-100,Board and Batten Shutter,A shutter that will not rot or warp outdoors,199.00,12,Exterior > Shutters,Black,14 in,https://x/1.jpg
SH-WH-1,SH-100,Board and Batten Shutter,A shutter that will not rot or warp outdoors,199.00,4,Exterior > Shutters,White,14 in,https://x/2.jpg
SH-BL-1,SH-100,Duplicate Row,dupe,199.00,12,Exterior > Shutters,Black,14 in,https://x/1.jpg
BM-1,BM-200,Faux Wood Beam,,449.00,0,,Walnut,4 in,
,,Orphan Row,no sku at all,10,1,,,,
`;

describe('normalisation', () => {
  const rows = parseCsv(CSV);
  const mapping = inferMapping(Object.keys(rows[0]!));
  const { products, quality } = normalizeRows('ekena', rows, mapping);

  test('variants collapse under their parent', () => {
    const shutter = products.find((p) => p.parentId === 'SH-100');
    assert.equal(shutter?.variants.length, 2, 'the duplicate row must not become a third variant');
    assert.deepEqual(shutter?.variants.map((v) => v.attributes.finish), ['Black', 'White']);
  });

  test('a variant title is derived when the source has none', () => {
    const shutter = products.find((p) => p.parentId === 'SH-100');
    assert.equal(shutter?.variants[0]?.variantTitle, 'Black');
  });

  test('the quality report names every defect rather than dropping it silently', () => {
    assert.deepEqual(quality.duplicateSkus, ['SH-BL-1']);
    assert.ok(quality.uncategorised.includes('BM-200'));
    assert.ok(quality.emptyDescriptions.includes('BM-200'));
    assert.ok(quality.missingImages.includes('BM-200'));
    assert.equal(quality.rejected.length, 2, 'the duplicate and the SKU-less row are both reported');
    assert.ok(quality.rejected.some((r) => r.reason.includes('missing SKU')));
  });

  test('totals count parents and variants separately', () => {
    assert.equal(quality.totalProducts, 2);
    assert.equal(quality.totalVariants, 3);
  });
});

describe('variant documents', () => {
  const rows = parseCsv(CSV);
  const mapping = inferMapping(Object.keys(rows[0]!));
  const { products } = normalizeRows('ekena', rows, mapping);
  const docs = toVariantDocs('ekena', products);

  test('one document per variant, parent fields denormalised onto each', () => {
    const black = docs.find((d) => d.sku === 'SH-BL-1')!;
    assert.equal(black.title, 'Board and Batten Shutter');
    assert.equal(black.parentId, 'SH-100');
    assert.equal(black.variantCount, 2);
  });

  test('attribute values are searchable on their own', () => {
    const black = docs.find((d) => d.sku === 'SH-BL-1')!;
    assert.ok(black.attributeText.includes('Black'));
    assert.ok(black.attributeText.includes('finish:Black'));
  });

  test('measurement attributes carry a numeric column for size filtering', () => {
    const black = docs.find((d) => d.sku === 'SH-BL-1')!;
    assert.equal(black.attrs.width_in, 14);
  });

  test('stock and effective price are derived, not trusted from the feed', () => {
    const white = docs.find((d) => d.sku === 'SH-WH-1')!;
    const beam = docs.find((d) => d.sku === 'BM-1')!;
    assert.equal(white.inStock, true);
    assert.equal(beam.inStock, false, 'zero inventory is out of stock');
    assert.equal(white.effectivePrice, 199);
  });
});

describe('whatever shape the feed arrives in', () => {
  /**
   * Getting the delimiter wrong is not a parse error, which is what makes it
   * worth a test. Every line becomes one enormous column, the mapping layer
   * recognises none of it, and the ingest cheerfully reports a catalogue whose
   * products have a single field.
   */
  test('a tab-separated feed is read as tab-separated', () => {
    // What Searchspring exports, under a .txt extension that says nothing.
    const feed = ['sku\tname\tprice\tcategory_hierarchy',
      'BM-1\tRustic Faux Beam\t149.00\tMillwork > Beams'].join('\n');
    assert.equal(sniffDelimiter(feed), '\t');
    const rows = parseCsv(feed);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.sku, 'BM-1');
    assert.equal(rows[0]!.name, 'Rustic Faux Beam');
  });

  test('a comma in a value does not make a tab-separated file comma-separated', () => {
    // The header alone decides, so prose in a description cannot mislead it.
    const feed = ['sku\tdescription', 'BM-1\tLightweight, paintable, and pre-primed'].join('\n');
    assert.equal(sniffDelimiter(feed), '\t');
    assert.equal(parseCsv(feed)[0]!.description, 'Lightweight, paintable, and pre-primed');
  });

  for (const [label, delimiter] of [['pipe', '|'], ['semicolon', ';'], ['comma', ',']] as const) {
    test(`a ${label}-separated feed is read as ${label}-separated`, () => {
      const feed = ['sku', 'title', 'price'].join(delimiter)
        + '\n' + ['BM-1', 'Rustic Faux Beam', '149.00'].join(delimiter);
      assert.equal(sniffDelimiter(feed), delimiter);
      assert.equal(parseCsv(feed)[0]!.title, 'Rustic Faux Beam');
    });
  }

  test('inch marks in a value do not swallow the rest of the file', () => {
    // Millwork feeds are full of 6"W x 8"H, and a strict parser reads the
    // first inch mark as opening a quoted field that never closes.
    const feed = ['sku,title', 'BM-1,6"W x 8"H Faux Beam', 'BM-2,Another Beam'].join('\n');
    const rows = parseCsv(feed);
    assert.equal(rows.length, 2, 'both rows survive');
    assert.match(rows[0]!.title!, /6"W x 8"H/);
  });

  test('Searchspring headings map to the same schema fields NetSuite ones do', () => {
    const mapping = inferMapping([
      'sku', 'name', 'description', 'brand', 'category_hierarchy', 'price', 'msrp',
      'imageUrl', 'mfrPartNumber', 'quantity', 'popularity', 'keywords', 'finish',
    ]);
    assert.equal(mapping.fields.sku, 'sku');
    assert.equal(mapping.fields.title, 'name');
    assert.equal(mapping.fields.categoryPath, 'category_hierarchy');
    assert.equal(mapping.fields.image, 'imageUrl');
    assert.equal(mapping.fields.mpn, 'mfrPartNumber');
    assert.equal(mapping.fields.inventory, 'quantity');
    assert.equal(mapping.fields.salesVelocity, 'popularity');
    // And anything the list does not know stays an attribute, as ever.
    assert.equal(mapping.attributes.finish, 'finish');
    assert.ok(mapping.facetable?.includes('finish'));
  });
});
