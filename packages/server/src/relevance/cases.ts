/**
 * The judged queries.
 *
 * Each case states what a shopper typing that query should get. Written from
 * the shopper's intent, deliberately *not* from what the engine currently
 * does — a suite tuned until it passes measures nothing except its own
 * tuning. Where a case fails, the failure is the finding.
 *
 * Grouped by the behaviour each is there to protect, because the point of a
 * regression suite is to know what broke, not just that something did.
 */
import type { RelevanceCase } from './judge.js';
import type { Corpus } from './corpus.js';

export function cases(corpus: Corpus): RelevanceCase[] {
  const anySku = corpus.docs[0]?.sku ?? '';

  return [
    // ---- Plain nouns. The floor: if these break, nothing else matters. ----
    {
      id: 'noun-shutters',
      query: 'shutters',
      intent: 'A plural product noun returns that product type and nothing else',
      expect: { category: 'Shutters' },
      minResults: 20,
      rescued: false,
    },
    {
      id: 'noun-crown-moulding',
      query: 'crown moulding',
      intent: 'A two-word product noun is one concept, not two loose words',
      expect: { category: 'Crown Moulding' },
      minResults: 20,
      rescued: false,
    },
    {
      id: 'noun-ceiling-medallion',
      query: 'ceiling medallion',
      intent: 'A product noun that shares a word with another category still lands',
      expect: { category: 'Ceiling Medallions' },
      minResults: 10,
      rescued: false,
    },
    {
      id: 'noun-chandelier',
      query: 'chandelier',
      intent: 'A singular noun matches a catalogue that spells it plurally',
      expect: { category: 'Chandeliers' },
      minResults: 10,
      rescued: false,
    },
    {
      id: 'noun-faux-wood-beam',
      query: 'faux wood beam',
      intent: 'A three-word product name matches the family named after it',
      expect: { category: 'Faux Wood Beams' },
      minResults: 20,
      rescued: false,
    },

    // ---- Features typed as free text. The behaviour built for this. ----
    {
      id: 'feature-black-pvc-shutter',
      query: 'black pvc shutter',
      intent: 'A finish and a material together narrow to products having both',
      expect: { category: 'Shutters', attr: { finish: 'Black', material: 'PVC' } },
      understands: ['Black', 'PVC'],
      minResults: 1,
    },
    {
      id: 'feature-walnut-beam',
      query: 'walnut beam',
      intent: 'A finish word filters the product type rather than merely boosting it',
      expect: { category: 'Faux Wood Beams', attr: { finish: 'Walnut' } },
      understands: ['Walnut'],
      minResults: 1,
    },
    {
      id: 'feature-primed-white-column',
      query: 'primed white column',
      intent: 'A two-word finish is one value, not two colour words',
      expect: { category: 'Porch Columns', attr: { finish: 'Primed White' } },
      understands: ['Primed White'],
      minResults: 1,
    },
    {
      id: 'feature-hunter-green-shutter',
      query: 'hunter green shutter',
      intent: 'An uncommon two-word finish still resolves to the catalogue value',
      expect: { category: 'Shutters', attr: { finish: 'Hunter Green' } },
      understands: ['Hunter Green'],
      minResults: 1,
    },
    {
      id: 'feature-oil-rubbed-bronze-chandelier',
      query: 'oil rubbed bronze chandelier',
      intent: 'A three-word finish resolves whole rather than matching "bronze"',
      expect: { category: 'Chandeliers', attr: { finish: 'Oil Rubbed Bronze' } },
      minResults: 1,
    },
    {
      id: 'feature-cedar-bracket',
      query: 'cedar bracket',
      intent: 'A shopper says "cedar"; the catalogue says "Western Red Cedar"',
      expect: { category: 'Brackets', attr: { material: 'Western Red Cedar' } },
      minResults: 1,
    },
    {
      id: 'feature-black-shutter-not-lighting',
      query: 'black shutter',
      intent: 'A colour shared with another category does not drag that category in',
      expect: { category: 'Shutters', attr: { finish: 'Black' } },
      forbid: { category: 'Chandeliers' },
      minResults: 5,
    },

    // ---- Dimensions. Millwork is bought by size. ----
    {
      id: 'dim-4x6-beam',
      query: '4x6 beam',
      intent: 'A cross-section filters to beams of that section',
      expect: { category: 'Faux Wood Beams', attr: { width: '4 in', height: '6 in' } },
      minResults: 1,
    },
    {
      id: 'dim-12ft-beam',
      query: '12 ft beam',
      intent: 'Feet are converted to the inches the catalogue stores',
      expect: { category: 'Faux Wood Beams', attr: { length: '144 in' } },
      minResults: 1,
    },
    {
      id: 'dim-24in-medallion',
      query: '24 inch ceiling medallion',
      intent: 'A single dimension on a product sized by one number',
      expect: { category: 'Ceiling Medallions', attr: { size: '24 in' } },
      minResults: 1,
    },

    // ---- Styles, and words that mean different things in different aisles. ----
    {
      id: 'style-hand-hewn-beam',
      query: 'hand hewn beam',
      intent: 'A style name narrows within the product type',
      expect: { category: 'Faux Wood Beams', attr: { style: 'Hand Hewn' } },
      minResults: 1,
    },
    {
      id: 'style-board-and-batten-shutter',
      query: 'board and batten shutter',
      intent: 'A phrase that is a shutter category and a wall-panel style resolves by context',
      expect: { category: 'Shutters' },
      minResults: 10,
      rescued: false,
    },
    {
      id: 'style-shaker-wainscot',
      query: 'shaker wainscot panel',
      intent: 'Style plus product noun, where the style exists in one family only',
      expect: { category: 'Wall Panels', attr: { style: 'Shaker' } },
      minResults: 1,
    },

    // ---- Recovery. Shoppers type badly, and the catalogue must cope. ----
    {
      id: 'typo-chandaleer',
      query: 'chandaleer',
      intent: 'A misspelling of a category noun still finds the category',
      expect: { anyOf: [{ category: 'Chandeliers' }, { title: 'chandelier' }] },
      minResults: 5,
    },
    {
      id: 'typo-crownmoulding',
      query: 'crownmoulding',
      intent: 'A missing space between two real words is split, not failed',
      expect: { category: 'Crown Moulding' },
      minResults: 5,
    },
    {
      id: 'relax-black-polyurethane-shutter',
      query: 'black polyurethane shutter',
      intent: 'A combination the catalogue does not stock relaxes to the nearest real one'
        + ' rather than returning an empty page',
      expect: { category: 'Shutters' },
      // A rescue is meant to return something adjacent, not everything that
      // could have been meant, so there is no complete answer set to measure
      // coverage against.
      partial: true,
      minResults: 1,
      rescued: true,
    },

    // ---- Exact lookup. A part number is a lookup, not a search. ----
    {
      id: 'sku-exact',
      query: anySku,
      intent: 'A SKU returns that one product and nothing near it',
      expect: { title: '.' },
      partial: true,
      minResults: 1,
      rescued: false,
      k: 3,
    },
  ];
}
