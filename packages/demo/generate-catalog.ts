/**
 * Demo catalogue generator.
 *
 * Produces a NetSuite-saved-search-shaped CSV for an architectural millwork
 * catalogue: parent products with deep variant matrices (finish x size x
 * length), realistic category paths, and — deliberately — the same mess a real
 * export carries. Every data-quality rule and rescue path needs something to
 * catch, so roughly one product in twelve is missing an image, a description,
 * a category or a price, and a handful of SKUs are duplicated outright.
 */

export interface GeneratorOptions {
  productCount?: number;
  seed?: number;
  /** Fraction of products carrying a deliberate data-quality defect. */
  messRate?: number;
}

/** Deterministic PRNG so the demo catalogue is reproducible run to run. */
function mulberry32(seed: number): () => number {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Family {
  category: string[];
  noun: string;
  brands: string[];
  materials: string[];
  finishes: string[];
  styles: string[];
  /** width x height cross-sections in inches. */
  sections?: [number, number][];
  lengths?: number[];
  sizes?: string[];
  skuPrefix: string;
  basePrice: [number, number];
  descriptors: string[];
}

const FAMILIES: Family[] = [
  {
    category: ['Millwork', 'Beams', 'Faux Wood Beams'],
    noun: 'Faux Wood Ceiling Beam',
    brands: ['Ekena Millwork', 'Volterra'],
    materials: ['Endurathane', 'Polyurethane', 'Reclaimed Pine'],
    finishes: ['Walnut', 'Espresso', 'Natural Pecan', 'Whitewash', 'Weathered Gray', 'Unfinished'],
    styles: ['Rustic', 'Sandblasted', 'Hand Hewn', 'Riverwood'],
    sections: [[4, 6], [6, 8], [8, 10], [3.5, 5.5], [10, 12]],
    lengths: [48, 72, 96, 120, 144, 192],
    skuPrefix: 'BM',
    basePrice: [149, 899],
    descriptors: [
      'lightweight high-density polyurethane that installs with construction adhesive',
      'moulded from real reclaimed timber for authentic grain and knot detail',
      'a three-sided U-channel that wraps existing structural beams',
    ],
  },
  {
    category: ['Exterior', 'Shutters', 'Board and Batten Shutters'],
    noun: 'Board and Batten Shutter',
    brands: ['Ekena Millwork', 'Timberthane'],
    materials: ['PVC', 'Western Red Cedar', 'Composite'],
    finishes: ['Black', 'Charcoal', 'Hunter Green', 'Colonial Red', 'Sage', 'Primed White', 'Bronze'],
    styles: ['Joined', 'Spaced', 'Z-Frame', 'Offset'],
    sections: [[14, 39], [16, 43], [18, 55], [20, 67], [12, 31]],
    skuPrefix: 'SH',
    basePrice: [89, 429],
    descriptors: [
      'cellular PVC that will not rot, warp or attract insects',
      'paintable and stainable, shipped ready for exterior mounting hardware',
      'a true board-and-batten profile with authentic gap spacing',
    ],
  },
  {
    category: ['Millwork', 'Moulding', 'Crown Moulding'],
    noun: 'Crown Moulding',
    brands: ['Ekena Millwork', 'Focal Point'],
    materials: ['Polyurethane', 'MDF', 'Poplar'],
    finishes: ['Primed White', 'Unfinished', 'Antique Gold', 'Pewter'],
    styles: ['Egg and Dart', 'Dentil', 'Traditional', 'Modern Cove', 'Acanthus'],
    sections: [[3.5, 3.5], [5.25, 5.25], [7, 7], [2.75, 2.75]],
    lengths: [96, 144],
    skuPrefix: 'MLD',
    basePrice: [39, 289],
    descriptors: [
      'covers the seam where the wall meets the ceiling in one clean run',
      'flexible enough for gentle radius walls without kerf cuts',
      'factory-primed and ready for paint straight out of the carton',
    ],
  },
  {
    category: ['Interior', 'Ceiling', 'Ceiling Medallions'],
    noun: 'Ceiling Medallion',
    brands: ['Ekena Millwork'],
    materials: ['Polyurethane', 'Urethane'],
    finishes: ['Primed White', 'Antique Gold', 'Bronze', 'Copper', 'Unfinished'],
    styles: ['Victorian', 'Acanthus', 'Traditional', 'Contemporary', 'Art Deco'],
    sizes: ['16 in', '20 in', '24 in', '29 in', '36 in', '42 in'],
    skuPrefix: 'CM',
    basePrice: [45, 379],
    descriptors: [
      'a factory-primed centrepiece that frames a chandelier or ceiling fan',
      'lightweight enough to install with adhesive and two finish screws',
      'deeply undercut relief detail that reads from floor level',
    ],
  },
  {
    category: ['Interior', 'Lighting', 'Chandeliers'],
    noun: 'Chandelier',
    brands: ['Lumenaire', 'Ekena Lighting'],
    materials: ['Wrought Iron', 'Brushed Brass', 'Crystal'],
    finishes: ['Oil Rubbed Bronze', 'Matte Black', 'Polished Nickel', 'Antique Brass'],
    styles: ['Farmhouse', 'Empire', 'Sputnik', 'Candelabra', 'Drum'],
    sizes: ['5-Light', '6-Light', '8-Light', '12-Light'],
    skuPrefix: 'CHN',
    basePrice: [189, 1899],
    descriptors: [
      'a dimmable fixture rated for sloped and vaulted ceiling installation',
      'hand-forged arms with a hand-applied finish, no two exactly alike',
      'includes six feet of adjustable chain and a matching canopy',
    ],
  },
  {
    category: ['Exterior', 'Brackets', 'Decorative Brackets'],
    noun: 'Decorative Bracket',
    brands: ['Ekena Millwork', 'Timberthane'],
    materials: ['Polyurethane', 'Western Red Cedar', 'Douglas Fir'],
    finishes: ['Unfinished', 'Primed White', 'Walnut', 'Weathered Gray'],
    styles: ['Traditional', 'Craftsman', 'Olivia', 'Bedford', 'Farmhouse'],
    sections: [[4, 12], [6, 18], [8, 24], [3.5, 10]],
    skuPrefix: 'BKT',
    basePrice: [29, 219],
    descriptors: [
      'structural-look support for gable ends, shelves and countertop overhangs',
      'weather-resistant and ready for exterior paint or stain',
      'hand-finished detail on all three exposed faces',
    ],
  },
  {
    category: ['Millwork', 'Columns', 'Porch Columns'],
    noun: 'Porch Column',
    brands: ['Ekena Millwork', 'Columns Direct'],
    materials: ['PVC', 'Fiberglass', 'Polyurethane'],
    finishes: ['Primed White', 'Unfinished', 'Sand'],
    styles: ['Tuscan', 'Doric', 'Craftsman', 'Roman Ionic'],
    sections: [[8, 8], [10, 10], [12, 12], [6, 6]],
    lengths: [96, 108, 120],
    skuPrefix: 'COL',
    basePrice: [249, 1499],
    descriptors: [
      'load-bearing to 20,000 lbs with a smooth paint-ready surface',
      'a split-and-wrap design that installs around an existing post',
      'moisture-proof cellular PVC for direct exterior exposure',
    ],
  },
  {
    category: ['Interior', 'Wall', 'Wall Panels'],
    noun: 'Wainscot Wall Panel',
    brands: ['Ekena Millwork'],
    materials: ['MDF', 'PVC', 'Polyurethane'],
    finishes: ['Primed White', 'Unfinished'],
    styles: ['Shaker', 'Raised Panel', 'Beadboard', 'Board and Batten'],
    sections: [[32, 48], [36, 96], [42, 48]],
    skuPrefix: 'WP',
    basePrice: [59, 349],
    descriptors: [
      'a paint-ready panel system that covers a full wall run without seams',
      'moisture-resistant, so it holds up in a powder room or mudroom',
      'pre-assembled stiles and rails, no shop time required',
    ],
  },
];

const HEADERS = [
  'Item Name/Number', 'Parent Item', 'Display Name', 'Sales Description', 'Manufacturer',
  'Commerce Category', 'Base Price', 'Sale Price', 'Quantity Available', 'Image URL',
  'Manufacturer Part Number', 'Rating', 'Review Count', 'Units Sold', 'Margin %',
  'Date Created', 'Keywords', 'Is Inactive',
  'Custom Item Field: Material', 'Custom Item Field: Finish', 'Custom Item Field: Style',
  'Custom Item Field: Width', 'Custom Item Field: Height', 'Custom Item Field: Length',
  'Custom Item Field: Size',
];

function pick<T>(rand: () => number, items: T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

function money(rand: () => number, [lo, hi]: [number, number]): number {
  return Math.round((lo + rand() * (hi - lo)) * 100) / 100;
}

function csvEscape(value: string | number): string {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function generateCatalogCsv(options: GeneratorOptions = {}): string {
  const productCount = options.productCount ?? 520;
  const messRate = options.messRate ?? 1 / 12;
  const rand = mulberry32(options.seed ?? 20260830);
  const rows: (string | number)[][] = [];
  const usedSkus = new Set<string>();
  let productIndex = 0;

  while (productIndex < productCount) {
    const family = FAMILIES[productIndex % FAMILIES.length]!;
    productIndex++;
    const style = pick(rand, family.styles);
    const material = pick(rand, family.materials);
    const brand = pick(rand, family.brands);
    const section = family.sections ? pick(rand, family.sections) : null;
    const size = family.sizes ? pick(rand, family.sizes) : null;

    const sectionLabel = section ? `${trim(section[0])}"W x ${trim(section[1])}"H ` : '';
    const title = `${style} ${sectionLabel}${material} ${family.noun}`.replace(/\s+/g, ' ');
    const parentId = `${family.skuPrefix}-${String(productIndex).padStart(4, '0')}`;
    const basePrice = money(rand, family.basePrice);

    // Deliberate defects, one product in messRate.
    const defect = rand() < messRate
      ? pick(rand, ['no_image', 'no_description', 'no_category', 'no_price', 'duplicate_sku'])
      : null;

    const description = defect === 'no_description'
      ? ''
      : `${title} in ${material}. ${pick(rand, family.descriptors)}. Sold individually.`;
    const category = defect === 'no_category' ? '' : family.category.join(' > ');
    const dateCreated = new Date(Date.now() - Math.floor(rand() * 900) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const rating = Math.round((3.4 + rand() * 1.6) * 10) / 10;
    const reviewCount = Math.floor(rand() * 240);
    const unitsSold = Math.floor(Math.pow(rand(), 2) * 900);
    const margin = Math.round((18 + rand() * 46) * 10) / 10;

    // Variant matrix: finish x (length | size). This is where SKU count grows.
    const finishes = shuffle(rand, family.finishes).slice(0, 2 + Math.floor(rand() * 4));
    const lengths = family.lengths ? shuffle(rand, family.lengths).slice(0, 1 + Math.floor(rand() * 3)) : [null];
    let variantSeq = 0;

    for (const finish of finishes) {
      for (const length of lengths) {
        variantSeq++;
        const skuBits = [
          family.skuPrefix,
          section ? `${trim(section[0])}X${trim(section[1])}` : '',
          length ? `X${length}` : '',
          size ? size.replace(/[^A-Za-z0-9]/g, '').toUpperCase() : '',
          finish.slice(0, 2).toUpperCase(),
          String(productIndex).padStart(3, '0'),
        ];
        let sku = skuBits.join('').replace(/[^A-Z0-9]/gi, '').toUpperCase();
        if (usedSkus.has(sku)) sku = `${sku}V${variantSeq}`;
        usedSkus.add(sku);

        const lengthPremium = length ? (length / 96) * 0.9 : 1;
        const price = Math.round(basePrice * lengthPremium * 100) / 100;
        const onSale = rand() < 0.18;
        const inventory = rand() < 0.08 ? 0 : Math.floor(rand() * 320);

        rows.push([
          sku,
          parentId,
          title,
          description,
          brand,
          category,
          defect === 'no_price' ? '' : price,
          onSale ? Math.round(price * (0.72 + rand() * 0.16) * 100) / 100 : '',
          inventory,
          // Served by the demo server's placeholder route; a real catalogue
          // ships absolute CDN URLs here.
          defect === 'no_image' ? '' : `/demo/img/${sku}.svg?f=${encodeURIComponent(finish)}`,
          `${family.skuPrefix}-${finish.slice(0, 3).toUpperCase()}-${variantSeq}`,
          rating,
          reviewCount,
          unitsSold,
          margin,
          dateCreated,
          [family.noun, style, material, finish].join('|'),
          rand() < 0.03 ? 'T' : 'F',
          material,
          finish,
          style,
          section ? `${trim(section[0])} in` : '',
          section ? `${trim(section[1])} in` : '',
          length ? `${length} in` : '',
          size ?? '',
        ]);

        // A duplicated SKU row: exactly what a bad saved-search join produces.
        if (defect === 'duplicate_sku' && variantSeq === 1) {
          rows.push([...rows[rows.length - 1]!]);
        }
      }
    }
  }

  return [HEADERS, ...rows].map((r) => r.map(csvEscape).join(',')).join('\n');
}

function trim(n: number): string {
  return String(Number(n.toFixed(2)));
}

function shuffle<T>(rand: () => number, items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
