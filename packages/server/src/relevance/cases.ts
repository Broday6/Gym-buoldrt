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
  const anyMpn = corpus.docs.find((d) => d.mpn)?.mpn ?? anySku;

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

    // ---- A family whose specs are written as prose, not columns. ----
    {
      id: 'noun-gable-vent',
      query: 'gable vent',
      intent: 'A family whose attributes were recovered from prose is still a normal aisle',
      expect: { category: 'Gable Vents' },
      minResults: 20,
      rescued: false,
    },
    {
      id: 'style-arch-top-vent',
      query: 'arch top gable vent',
      intent: 'A style is a filter even when the category does not name it',
      expect: { category: 'Gable Vents', attr: { style: 'Arch Top' } },
      understands: ['Arch Top'],
      minResults: 1,
      rescued: false,
    },

    {
      id: 'discovered-attribute-filters',
      query: 'brickmould frame gable vent',
      intent: 'An attribute that existed only in prose is a filter, not just matching text',
      expect: { category: 'Gable Vents', attr: { frame: 'Brickmould Frame' } },
      understands: ['Brickmould Frame'],
      minResults: 1,
      rescued: false,
    },
    {
      id: 'discovered-attribute-negation',
      query: 'non-functional decorative gable vent',
      intent: 'A value whose name contains another value still resolves to itself',
      // "Functional w/Louver Box" is a substring away, and a text match alone
      // returns the opposite of what was asked for.
      expect: { category: 'Gable Vents', attr: { type: 'Non-Functional Decorative' } },
      minResults: 1,
      rescued: false,
    },

    // ---- Two aisles named in one query. ----
    {
      id: 'head-noun-ceiling-beams',
      query: 'ceiling beams',
      intent: 'A query naming two aisles is asking for the last one; the first describes it',
      // "Ceiling" is an aisle of its own and comes first, so taking the
      // earliest match filtered to medallions and threw "beams" away.
      expect: { category: 'Beams' },
      forbid: { category: 'Ceiling Medallions' },
      minResults: 10,
      rescued: false,
    },
    {
      id: 'head-noun-exterior-shutters',
      query: 'exterior shutters',
      intent: 'A department in front of a product type narrows to the product type',
      expect: { category: 'Shutters' },
      minResults: 10,
      rescued: false,
    },
    {
      id: 'head-noun-longer-phrase-wins',
      query: 'ceiling medallion',
      intent: 'A longer product name still beats a shorter one inside it',
      // The fix above must not make "ceiling medallion" resolve to medallions
      // by accident of word order — it resolves because it is the longer name.
      expect: { category: 'Ceiling Medallions' },
      minResults: 10,
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

    // ---- The same size, asked for every way a person asks for it. ----
    // These exist as a group on purpose: the failure they guard against is not
    // that one of them returns nothing, it is that they disagree. A shopper
    // who rephrases and gets a different page has been told the first page was
    // wrong, and nothing on either page explains which to believe.
    ...['12 ft beam', "12' beam", '12ft beam', '12 foot long beam',
      'beam 12 ft long', '12 foot long beams', 'beams that are 12 ft']
      .map((query, i): RelevanceCase => ({
        id: `phrasing-12ft-${i}`,
        query,
        intent: 'Every way of saying "twelve feet long" finds the same beams',
        expect: { category: 'Faux Wood Beams', attr: { length: '144 in' } },
        minResults: 1,
        rescued: false,
      })),
    {
      id: 'axis-width-named',
      query: '6 inch wide beam',
      intent: 'Naming the axis filters that axis, not whichever one happens to carry the number',
      expect: { category: 'Faux Wood Beams', attr: { width: '6 in' } },
      minResults: 1,
      rescued: false,
    },
    {
      id: 'axis-medallion-across',
      query: '24 inch wide ceiling medallion',
      intent: 'A product sold by one number is that wide, so naming width still finds it',
      expect: { category: 'Ceiling Medallions', attr: { size: '24 in' } },
      minResults: 1,
      rescued: false,
    },
    {
      id: 'dim-labelled-cross-section',
      query: '6"W x 8"H faux wood beam',
      intent: 'The form the catalogue writes its own titles in, which shoppers paste back',
      expect: { category: 'Faux Wood Beams', attr: { width: '6 in', height: '8 in' } },
      minResults: 1,
      rescued: false,
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

    // ---- What a shopper calls a colour the catalogue spells in full. ----
    // Nobody types "Hunter Green". These are read out of the catalogue's own
    // values, so they hold on any catalogue rather than on a list of colours.
    {
      id: 'colour-partial-green',
      query: 'green shutter',
      intent: 'The plain colour word finds the finish the catalogue spells in full',
      expect: { category: 'Shutters', attr: { finish: 'Hunter Green' } },
      understands: ['Hunter Green'],
      minResults: 1,
      rescued: false,
    },
    {
      id: 'colour-partial-red-not-cedar',
      query: 'red shutter',
      intent: 'A colour word belongs to the value it is the head of, not one it merely sits in',
      // "Colonial Red" is a red; "Western Red Cedar" is a cedar. Before the
      // head rule this returned cedar shutters.
      expect: { category: 'Shutters', attr: { finish: 'Colonial Red' } },
      minResults: 1,
      rescued: false,
    },
    {
      id: 'colour-spelling-grey',
      query: 'grey beam',
      intent: 'Both spellings of the same colour are the same colour',
      expect: { category: 'Faux Wood Beams', attr: { finish: 'Weathered Gray' } },
      minResults: 1,
      rescued: false,
    },
    {
      id: 'colour-product-noun-wins',
      query: 'shaker wainscot panel',
      intent: 'A word the taxonomy uses names a product, and a feature may not redefine it',
      // `panel` is the head of the style "Raised Panel" and also the name of
      // the aisle. Letting the style claim it asked for two contradictory
      // styles at once.
      expect: { category: 'Wall Panels', attr: { style: 'Shaker' } },
      minResults: 1,
      rescued: false,
    },

    // ---- Exact lookup. A part number is a lookup, not a search. ----
    {
      id: 'sku-partial',
      query: anySku.slice(0, 8),
      intent: 'Part of a part number finds its family, not the whole catalogue',
      // Read off a damaged label, or the prefix a range shares. This used to
      // match nothing, and the zero-result rescue answered with best sellers.
      expect: { title: '.' },
      partial: true,
      minResults: 1,
      rescued: false,
      k: 5,
    },
    {
      id: 'sku-manufacturer-number',
      query: anyMpn,
      intent: "The number on the box works as well as the number in our system",
      expect: { title: '.' },
      partial: true,
      minResults: 1,
      rescued: false,
      k: 5,
    },
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
