/**
 * Console primitives: API access, escaping, formatting, and the small DOM
 * helpers every view uses.
 *
 * Deliberately no framework and no build step, for the same reason the
 * storefront SDK has none: this has to be servable straight from the API
 * process, and a merchandising console is a handful of tables and forms.
 */

export const state = {
  site: null,
  sites: [],
  days: 30,
};

/**
 * Admin keys, held per site.
 *
 * The console talks to the same public API as everything else, so it needs an
 * admin key like any other client. It is asked for once and kept in this
 * browser — never fetched from the server, which would make an admin key
 * readable by anyone who can load the page.
 */
const KEY_STORE = 'compass.adminKeys';

export function adminKeys() {
  try {
    return JSON.parse(localStorage.getItem(KEY_STORE) ?? '{}');
  } catch {
    return {};
  }
}

export function setAdminKey(site, key) {
  localStorage.setItem(KEY_STORE, JSON.stringify({ ...adminKeys(), [site]: key.trim() }));
}

export function clearAdminKey(site) {
  const keys = adminKeys();
  delete keys[site];
  localStorage.setItem(KEY_STORE, JSON.stringify(keys));
}

/** Thrown when the key is missing, wrong, or scoped to another site. */
export class AuthError extends Error {}

/** Every call carries the site, so a view never has to remember to. */
export async function api(path, options = {}) {
  const url = path.startsWith('/v1/') ? path : `/v1/${state.site}${path}`;
  const key = adminKeys()[state.site];
  const headers = {};
  if (options.body) headers['content-type'] = 'application/json';
  if (key) headers['x-compass-key'] = key;
  const response = await fetch(url, {
    method: options.method ?? (options.body ? 'POST' : 'GET'),
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (response.status === 401 || response.status === 403) {
    // A stored key that no longer works is worse than none: it fails every
    // screen silently. Drop it so the console asks again.
    if (key) clearAdminKey(state.site);
    throw new AuthError(payload.error ?? 'this console needs an admin key');
  }
  if (!response.ok) {
    throw new Error(payload.error ?? `${response.status} on ${url}`);
  }
  return payload;
}

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export const money = (n) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
    .format(Number(n) || 0);

export const num = (n) => (Number(n) || 0).toLocaleString();
export const pct = (n) => `${(Number(n) || 0).toFixed(1)}%`;

export function toast(message, isError = false) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = `toast${isError ? ' toast--err' : ''}`;
  el.setAttribute('role', 'status');
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), isError ? 7000 : 3500);
}

/** `html` tagged template with automatic escaping of interpolated values. */
export function html(strings, ...values) {
  return strings.reduce((out, chunk, i) => {
    const value = values[i - 1];
    const rendered = Array.isArray(value) ? value.join('') : value;
    // A Raw wrapper opts out, for fragments a view has already built.
    return out + (value instanceof Raw ? value.value : esc(rendered ?? '')) + chunk;
  });
}

export class Raw {
  constructor(value) { this.value = value; }
}
export const raw = (value) => new Raw(Array.isArray(value) ? value.join('') : value);

/** A table, or a labelled empty state — never a bare empty <tbody>. */
export function table(columns, rows, renderRow, emptyMessage = 'Nothing here yet.') {
  if (!rows.length) return `<p class="empty">${esc(emptyMessage)}</p>`;
  return `<div class="table-wrap"><table>
    <thead><tr>${columns.map((c) =>
      `<th${c.numeric ? ' class="num"' : ''}>${esc(c.label)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(renderRow).join('')}</tbody>
  </table></div>`;
}

/**
 * Sparkline for a daily series.
 *
 * Two lines on one baseline: volume as a filled area, and the zero-result rate
 * as a dashed overlay, because the interesting question is always whether
 * failures are rising *faster* than traffic.
 */
export function sparkline(points, { width = 720, height = 64 } = {}) {
  if (points.length < 2) return '<p class="empty">Not enough days of data yet.</p>';
  const maxSearches = Math.max(...points.map((p) => p.searches), 1);
  const x = (i) => (i / (points.length - 1)) * width;
  const y = (v, max) => height - (v / max) * (height - 6) - 3;

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.searches, maxSearches).toFixed(1)}`).join(' ');
  const area = `${line} L${width},${height} L0,${height} Z`;
  const maxRate = Math.max(...points.map((p) => (p.searches ? p.zeroResults / p.searches : 0)), 0.01);
  const zero = points
    .map((p, i) => {
      const rate = p.searches ? p.zeroResults / p.searches : 0;
      return `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(rate, maxRate).toFixed(1)}`;
    })
    .join(' ');

  return `<svg class="spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"
      role="img" aria-label="Daily search volume and zero-result rate">
      <path class="spark__area" d="${area}"/>
      <path class="spark__line" d="${line}"/>
      <path class="spark__zero" d="${zero}"/>
    </svg>
    <div class="legend">
      <span><i style="background:var(--accent)"></i>searches (peak ${num(maxSearches)}/day)</span>
      <span><i style="background:var(--warn)"></i>zero-result rate (peak ${pct(maxRate * 100)})</span>
    </div>`;
}

export function badgeChips(badges) {
  if (!badges?.length) return '';
  return `<div class="badges">${badges
    .map((b) => `<span class="badge badge--${esc(b.tone)}">${esc(b.label)}</span>`)
    .join('')}</div>`;
}

/** Debounce that also drops the result of any call a newer one overtook. */
export function debounce(fn, waitMs = 220) {
  let timer = null;
  let seq = 0;
  return (...args) => {
    if (timer) clearTimeout(timer);
    const mine = ++seq;
    timer = setTimeout(() => {
      if (mine === seq) void fn(...args);
    }, waitMs);
  };
}
