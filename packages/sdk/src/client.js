/**
 * Compass Search storefront client.
 *
 * Framework-agnostic and dependency-free so it drops into a Miva template (or
 * any storefront) behind one script tag. Everything the widgets render is also
 * available as plain JSON here, for storefronts that want their own markup.
 */

const SHOPPER_KEY = 'compass_shopper_id';
const SESSION_KEY = 'compass_session_id';
const RECENT_KEY = 'compass_recent_searches';
/** Session-scoped on purpose: a hint about this visit, not a profile. */
const AFFINITY_KEY = 'compass_affinity';
const SESSION_TTL_MS = 30 * 60 * 1000;

function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * Storage is wrapped because Safari private mode throws on write.
 *
 * `which` names the store rather than taking one, because the accessor itself
 * throws where storage is denied — Safari's private mode, a sandboxed frame, a
 * browser set to block site data — so it has to be read inside the try. It
 * used to take a store and then ignore it, which quietly made the session
 * store a second handle on localStorage: session state outlived the session,
 * across tabs and restarts.
 */
function safeStorage(which = 'localStorage') {
  let store = null;
  try {
    store = globalThis[which] ?? null;
  } catch {
    store = null;
  }
  return {
    get(key) {
      try { return store?.getItem(key) ?? null; } catch { return null; }
    },
    set(key, value) {
      try { store?.setItem(key, value); } catch { /* storage denied: skip */ }
    },
  };
}

export class CompassClient {
  constructor(options) {
    if (!options?.site) throw new Error('CompassClient requires a `site`');
    this.site = options.site;
    this.baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
    this.apiKey = options.apiKey ?? null;
    this.hitsPerPage = options.hitsPerPage ?? 24;
    this.onError = options.onError ?? ((err) => console.warn('[compass]', err));

    const local = safeStorage();
    const session = safeStorage('sessionStorage');
    this.local = local;
    this.session = session;

    // A first-party anonymous id; never tied to a customer record.
    this.shopperId = local.get(SHOPPER_KEY) ?? uuid();
    local.set(SHOPPER_KEY, this.shopperId);

    const stored = session.get(SESSION_KEY);
    const parsed = stored ? JSON.parse(stored) : null;
    this.sessionId = parsed && Date.now() - parsed.at < SESSION_TTL_MS ? parsed.id : uuid();
    session.set(SESSION_KEY, JSON.stringify({ id: this.sessionId, at: Date.now() }));

    this.queue = [];
    this.flushTimer = null;
    if (typeof addEventListener === 'function') {
      // Flush on the way out so the last click of a session is not lost.
      addEventListener('pagehide', () => this.flush(true));
    }
  }

  async request(path, body, signal) {
    const headers = { 'content-type': 'application/json' };
    if (this.apiKey) headers['x-compass-key'] = this.apiKey;
    const response = await fetch(`${this.baseUrl}/v1/${this.site}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`compass ${path} failed: ${response.status} ${detail}`);
    }
    return response.json();
  }

  /** Full search. Returns the raw SearchResponse. */
  search(params = {}, signal) {
    return this.request('/search', {
      hitsPerPage: this.hitsPerPage,
      ...params,
      shopperId: this.shopperId,
      sessionId: this.sessionId,
    }, signal);
  }

  /** Category browse: the same engine, keyed by category instead of a query. */
  browse(categoryId, params = {}, signal) {
    return this.request('/browse', {
      hitsPerPage: this.hitsPerPage,
      ...params,
      categoryId,
      shopperId: this.shopperId,
      sessionId: this.sessionId,
    }, signal);
  }

  // ---- analytics ---------------------------------------------------------

  track(type, payload = {}) {
    this.queue.push({
      type,
      site: this.site,
      shopperId: this.shopperId,
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      ...payload,
    });
    if (this.queue.length >= 20) this.flush();
    else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), 1500);
    }
  }

  trackClick(hit, position, query) {
    this.track('click', { sku: hit.sku, parentId: hit.parentId, position, query });
    this.rememberTaste(hit);
  }

  /**
   * What this visit seems to be about.
   *
   * A shopper who clicks three black products has said something worth acting
   * on, and the variant label they clicked — "Black / PVC / Joined" — already
   * names it. Kept in session storage, not sent to the server as identity and
   * not persisted between visits: it is a hint about right now, and someone
   * shopping for a bathroom on Tuesday should not still be steered toward it
   * in October.
   */
  rememberTaste(hit) {
    const parts = String(hit?.variantTitle ?? '')
      .split('/').map((p) => p.trim()).filter((p) => p.length > 1 && p.length <= 40);
    if (hit?.brand) parts.push(hit.brand);
    if (!parts.length) return;
    // Most recent first, so a change of mind takes effect immediately rather
    // than being outvoted by everything clicked before it.
    const next = [...parts, ...this.affinity().filter((a) => !parts.includes(a))].slice(0, 8);
    this.session.set(AFFINITY_KEY, JSON.stringify(next));
  }

  /** The attribute values worth tilting this visit's results toward. */
  affinity() {
    try {
      const raw = JSON.parse(this.session.get(AFFINITY_KEY) ?? '[]');
      return Array.isArray(raw) ? raw.filter((v) => typeof v === 'string') : [];
    } catch {
      return [];
    }
  }

  trackAddToCart(sku, quantity = 1, query) {
    this.track('add_to_cart', { sku, quantity, query });
  }

  trackPurchase(items, revenue) {
    for (const item of items) {
      this.track('purchase', { sku: item.sku, quantity: item.quantity ?? 1, revenue: item.revenue });
    }
    if (revenue !== undefined) this.track('purchase', { revenue });
  }

  flush(useBeacon = false) {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.queue.length === 0) return;
    const events = this.queue;
    this.queue = [];
    const url = `${this.baseUrl}/v1/${this.site}/events`;
    const body = JSON.stringify({ events });

    // sendBeacon survives the page unloading; fetch does not.
    if (useBeacon && navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
      return;
    }
    const headers = { 'content-type': 'application/json' };
    if (this.apiKey) headers['x-compass-key'] = this.apiKey;
    fetch(url, { method: 'POST', headers, body, keepalive: true }).catch(this.onError);
  }

  // ---- recent searches ---------------------------------------------------

  recentSearches(limit = 5) {
    try {
      return JSON.parse(this.local.get(RECENT_KEY) ?? '[]').slice(0, limit);
    } catch {
      return [];
    }
  }

  rememberSearch(query) {
    const trimmed = (query ?? '').trim();
    if (!trimmed) return;
    const next = [trimmed, ...this.recentSearches(20).filter((q) => q !== trimmed)].slice(0, 10);
    this.local.set(RECENT_KEY, JSON.stringify(next));
  }
}

/** Collapse rapid keystrokes into one request, and cancel the ones overtaken. */
export function debounceAsync(fn, waitMs = 120) {
  let timer = null;
  let controller = null;
  return (...args) =>
    new Promise((resolve, reject) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        controller?.abort();
        controller = new AbortController();
        fn(...args, controller.signal).then(resolve, (err) => {
          if (err?.name === 'AbortError') return;
          reject(err);
        });
      }, waitMs);
    });
}
