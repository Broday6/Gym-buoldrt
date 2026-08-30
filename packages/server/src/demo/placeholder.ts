/**
 * Deterministic placeholder product imagery for the demo storefront.
 *
 * The seeded catalogue has no real photography, and a grid of broken images
 * makes it impossible to judge the UI. This renders a stable SVG per SKU —
 * same SKU, same picture — tinted by finish so a colour facet visibly changes
 * what is on screen. Demo only; a real catalogue ships image URLs.
 */

const TINTS: Record<string, string> = {
  black: '#26262b', charcoal: '#3b3f46', 'primed white': '#e9e7e2', white: '#eeece7',
  bronze: '#7a5230', 'oil rubbed bronze': '#4a3728', brass: '#b5893b', 'antique brass': '#9c7736',
  'antique gold': '#c9a227', 'polished nickel': '#c2c6cb', pewter: '#8e9295',
  walnut: '#5b3a24', espresso: '#3d2b1f', 'natural pecan': '#a9743f', whitewash: '#ddd7cc',
  'weathered gray': '#8d8b86', sage: '#9caf88', 'hunter green': '#33513c',
  'colonial red': '#8b2f2b', unfinished: '#c4ae8e', copper: '#b06a3b', sand: '#d3c3a3',
  'matte black': '#212125', crystal: '#dfe9ef',
};

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function tintFor(finish: string, sku: string): string {
  const key = finish.toLowerCase().trim();
  if (TINTS[key]) return TINTS[key];
  for (const [name, colour] of Object.entries(TINTS)) if (key.includes(name)) return colour;
  return `hsl(${hash(sku) % 360} 24% 55%)`;
}

/** A simple architectural silhouette, varied by category so shapes differ. */
function shapeFor(kind: string, tint: string): string {
  switch (kind) {
    case 'BM': // beam
      return `<rect x="60" y="150" width="280" height="90" rx="6" fill="${tint}"/>
              <rect x="60" y="150" width="280" height="18" rx="6" fill="#fff" opacity=".14"/>
              <rect x="60" y="222" width="280" height="18" rx="6" fill="#000" opacity=".16"/>`;
    case 'SH': // shutter
      return `<rect x="150" y="70" width="100" height="260" rx="5" fill="${tint}"/>
              ${[0, 1, 2, 3, 4, 5].map((i) => `<rect x="158" y="${84 + i * 42}" width="84" height="30" rx="3" fill="#000" opacity=".13"/>`).join('')}`;
    case 'MLD': // moulding
      return `<path d="M50 250 L50 200 Q120 200 150 165 Q200 110 350 110 L350 250 Z" fill="${tint}"/>
              <path d="M50 250 L50 236 Q140 236 170 190 Q215 130 350 130 L350 110 Q200 110 150 165 Q120 200 50 200 Z" fill="#fff" opacity=".12"/>`;
    case 'CM': // ceiling medallion
      return `<circle cx="200" cy="200" r="120" fill="${tint}"/>
              <circle cx="200" cy="200" r="88" fill="#000" opacity=".12"/>
              <circle cx="200" cy="200" r="52" fill="#fff" opacity=".14"/>
              <circle cx="200" cy="200" r="20" fill="#000" opacity=".2"/>`;
    case 'CHN': // chandelier
      return `<path d="M200 50 L200 120" stroke="${tint}" stroke-width="7"/>
              <path d="M110 150 Q200 105 290 150" stroke="${tint}" stroke-width="9" fill="none"/>
              ${[110, 155, 200, 245, 290].map((x, i) => `<g><path d="M${x} ${150 + (i === 2 ? -12 : 0)} L${x} ${205 + (i === 2 ? -12 : 0)}" stroke="${tint}" stroke-width="6"/><ellipse cx="${x}" cy="${222 + (i === 2 ? -12 : 0)}" rx="19" ry="26" fill="${tint}" opacity=".82"/></g>`).join('')}`;
    case 'BKT': // bracket
      return `<path d="M110 90 L250 90 L250 120 L150 120 Q150 230 250 250 L250 285 Q110 265 110 120 Z" fill="${tint}"/>`;
    case 'COL': // column
      return `<rect x="150" y="90" width="100" height="220" fill="${tint}"/>
              <rect x="130" y="70" width="140" height="26" rx="4" fill="${tint}"/>
              <rect x="130" y="304" width="140" height="26" rx="4" fill="${tint}"/>
              ${[0, 1, 2].map((i) => `<rect x="${168 + i * 26}" y="102" width="7" height="196" fill="#000" opacity=".12"/>`).join('')}`;
    default: // wall panel and anything new
      return `<rect x="80" y="90" width="240" height="220" rx="5" fill="${tint}"/>
              <rect x="110" y="120" width="180" height="160" rx="4" fill="#000" opacity=".13"/>
              <rect x="132" y="142" width="136" height="116" rx="3" fill="#fff" opacity=".1"/>`;
  }
}

export function placeholderSvg(sku: string, finish = ''): string {
  const kind = (sku.match(/^[A-Z]+/)?.[0] ?? '').slice(0, 3);
  const tint = tintFor(finish, sku);
  const backdrop = `hsl(${hash(sku + 'bg') % 40 + 25} 14% ${94 - (hash(sku) % 5)}%)`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="400" height="400" role="img">
  <rect width="400" height="400" fill="${backdrop}"/>
  <rect x="0" y="300" width="400" height="100" fill="#000" opacity=".045"/>
  ${shapeFor(kind, tint)}
</svg>`;
}
