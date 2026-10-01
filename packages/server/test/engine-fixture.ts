import type { Product } from '@compass/shared';

/**
 * One catalogue and one set of shopper requests, shared by every test that
 * checks two engines agree. A second engine is only trustworthy if it is held
 * to exactly the cases the first was.
 */

const FINISHES = ['Black', 'White', 'Bronze', 'Hunter Green', 'Sage'];
const MATERIALS = ['PVC', 'Western Red Cedar', 'Composite'];

export function catalogue(): Product[] {
  const products: Product[] = [];
  for (let p = 0; p < 40; p++) {
    const material = MATERIALS[p % MATERIALS.length]!;
    const exterior = p % 2 === 0;
    products.push({
      parentId: `P-${p}`,
      title: exterior ? `Board and Batten Shutter ${12 + p}"W` : `Crown Moulding Profile ${p}`,
      description: exterior
        ? 'Cellular exterior shutter that will not rot, warp or attract insects.'
        : 'Interior crown moulding, primed and ready to finish.',
      brand: p % 5 === 0 ? 'Timberthane' : 'Ekena Millwork',
      categoryPath: exterior ? ['Exterior', 'Shutters'] : ['Interior', 'Moulding'],
      categoryIds: exterior ? ['exterior', 'exterior/shutters'] : ['interior', 'interior/moulding'],
      salesVelocity: 500 - p * 7,
      margin: 30 + (p % 40),
      reviewScore: 3 + (p % 20) / 10,
      reviewCount: p * 3,
      dateAdded: `2025-0${1 + (p % 9)}-01`,
      variants: FINISHES.slice(0, 2 + (p % 4)).map((finish, i) => ({
        sku: `P${p}-${finish.slice(0, 2).toUpperCase()}-${i}`,
        parentId: `P-${p}`,
        variantTitle: `${finish} / ${material}`,
        price: 80 + p * 9 + i * 13,
        salePrice: p % 4 === 0 ? 60 + p * 8 : undefined,
        inventory: (p + i) % 7,
        image: `https://x/${p}-${i}.jpg`,
        attributes: {
          finish, material,
          width_in: 12 + p, height_in: 39 + (p % 5) * 12,
        },
      })),
    });
  }
  return products;
}


export const QUERIES = [
  { label: 'a plain keyword', request: { q: 'shutter' } },
  { label: 'two words', request: { q: 'board batten' } },
  { label: 'a misspelling', request: { q: 'shuter' } },
  { label: 'a brand', request: { q: 'timberthane' } },
  { label: 'a finish plus a noun', request: { q: 'black shutter' } },
  { label: 'a facet filter', request: { q: 'shutter', filters: { material: ['PVC'] } } },
  { label: 'two facet groups', request: { q: '', filters: { material: ['PVC'], finish: ['Black'] } } },
  { label: 'a category browse', request: { categoryId: 'exterior/shutters' } },
  { label: 'a price sort', request: { categoryId: 'exterior/shutters', sort: 'price_asc' } },
  { label: 'best selling', request: { categoryId: 'interior/moulding', sort: 'best_selling' } },
  { label: 'a price range', request: { q: '', ranges: [{ field: 'price', min: 100, max: 300 }] } },
  { label: 'a second page', request: { categoryId: 'exterior/shutters', page: 2 } },
  { label: 'a query that matches nothing', request: { q: 'zzzznothing', rescue: false } },
];
