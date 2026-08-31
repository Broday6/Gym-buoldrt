/**
 * The demo's merchandising, in one place.
 *
 * Read by the seed, which writes it to Postgres, and by the browser build,
 * which bakes it into a self-contained page. Two copies of these rules would
 * mean the hosted demo and the running product could disagree about what
 * "Dark Finishes" means.
 */
/**
 * Demo structures that deliberately cut across the catalogue taxonomy: none of
 * these map to a single category, which is the whole point of the feature.
 */
export const DEMO_COLLECTIONS = [
  {
    slug: 'farmhouse-kitchen',
    name: 'Farmhouse Kitchen',
    description: 'Beams, brackets and moulding that read farmhouse.',
    selector: {
      all: [
        { field: 'variant.attrs.style', op: 'in', value: ['Rustic', 'Hand Hewn', 'Farmhouse', 'Craftsman'] },
        { field: 'inStock', op: 'equals', value: true },
      ],
    },
  },
  {
    slug: 'dark-finishes',
    name: 'Dark Finishes',
    description: 'Anything available in a dark finish, whatever it is.',
    selector: {
      any: [
        { field: 'variant.attrs.finish', op: 'in', value: ['Black', 'Matte Black', 'Espresso', 'Charcoal', 'Oil Rubbed Bronze'] },
      ],
    },
  },
  {
    slug: 'contractor-value',
    name: 'Contractor Value',
    description: 'High-margin, deep-stock lines worth pushing.',
    kind: 'internal' as const,
    selector: {
      all: [
        { field: 'margin', op: 'gte', value: 45 },
        { field: 'totalInventory', op: 'gte', value: 200 },
      ],
    },
  },
  {
    slug: 'clearance',
    name: 'Clearance',
    description: 'On sale right now.',
    selector: { all: [{ field: 'onSale', op: 'equals', value: true }] },
  },
];

/** Rule-driven badges: the cheapest merchandising lever there is. */
export const DEMO_BADGES = [
  { key: 'best_seller', label: 'Best Seller', tone: 'praise' as const, priority: 10,
    selector: { all: [{ field: 'salesVelocity', op: 'gte', value: 400 }] } },
  { key: 'new', label: 'New', tone: 'new' as const, priority: 20,
    selector: { all: [{ field: 'dateAdded', op: 'gte', value: isoDaysAgo(120) }] } },
  { key: 'low_stock', label: 'Low Stock', tone: 'scarcity' as const, priority: 30,
    selector: { all: [
      { field: 'variant.inventory', op: 'between', value: 1, to: 6 },
    ] } },
  { key: 'clearance', label: 'Clearance', tone: 'sale' as const, priority: 5,
    selector: { all: [{ field: 'onSale', op: 'equals', value: true },
                      { field: 'margin', op: 'lt', value: 35 }] } },
];

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** A merchandiser-invented facet that no source system supplies. */
export const DEMO_ATTRIBUTES = [
  {
    key: 'room',
    label: 'Room',
    displayType: 'checkbox' as const,
    position: 12,
    values: [
      { value: 'Kitchen', selector: { any: [
        { field: 'categoryPath', op: 'contains', value: 'Beams' },
        { field: 'categoryPath', op: 'contains', value: 'Brackets' },
      ] } },
      { value: 'Living Room', selector: { any: [
        { field: 'categoryPath', op: 'contains', value: 'Moulding' },
        { field: 'categoryPath', op: 'contains', value: 'Ceiling' },
        { field: 'categoryPath', op: 'contains', value: 'Lighting' },
      ] } },
      { value: 'Exterior', selector: { any: [
        { field: 'categoryPath', op: 'contains', value: 'Exterior' },
      ] } },
      { value: 'Bathroom', selector: { all: [
        { field: 'categoryPath', op: 'contains', value: 'Wall' },
        { field: 'variant.attrs.material', op: 'in', value: ['PVC', 'Composite'] },
      ] } },
    ],
  },
  {
    key: 'price_band',
    label: 'Budget',
    displayType: 'checkbox' as const,
    position: 2,
    sortBy: 'custom' as const,
    customOrder: ['Under $100', '$100 – $300', '$300 – $700', 'Premium'],
    values: [
      { value: 'Under $100', selector: { all: [{ field: 'minPrice', op: 'lt', value: 100 }] } },
      { value: '$100 – $300', selector: { all: [{ field: 'minPrice', op: 'between', value: 100, to: 300 }] } },
      { value: '$300 – $700', selector: { all: [{ field: 'minPrice', op: 'between', value: 300, to: 700 }] } },
      { value: 'Premium', selector: { all: [{ field: 'minPrice', op: 'gt', value: 700 }] } },
    ],
  },
];
