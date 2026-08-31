import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteEngine } from './engine/sqlite.js';
import { TypesenseEngine } from './engine/typesense.js';
import type { SearchEngine } from './engine/types.js';
import { SearchService } from './services/search.js';
import { AutocompleteService } from './services/autocomplete.js';
import { ResultCache } from './services/cache.js';
import { SynonymStore } from './merchandising/synonyms.js';
import { RedirectStore } from './merchandising/redirects.js';
import { CollectionStore } from './merchandising/collections.js';
import { AnalyticsService } from './services/analytics.js';
import { RecommendService } from './services/recommend.js';
import { PreviewService } from './services/preview.js';
import { SiteRegistry } from './config/sites.js';
import { EventCollector } from './events/collector.js';
import { createPool, migrate, type Db } from './db/pool.js';
import { KeyStore } from './routes/auth.js';
import { registerRoutes } from './routes/index.js';
import { AJV_OPTIONS } from './routes/schemas.js';
import { Scheduler } from './services/scheduler.js';
import { HistoryService } from './services/history.js';
import { QueryRuleStore } from './merchandising/queryrules.js';
import { SignalStore } from './services/signals.js';
import { AutopilotService } from './services/autopilot.js';
import { ImpressionRecorder } from './services/impressions.js';
import { Metrics, RateLimiter, registerGuards } from './routes/guards.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Whether a URL is an admin API route.
 *
 * Scoped to `/v1/` deliberately. The console's own static assets live under
 * `/admin/`, and a module script is always fetched with an Origin header even
 * same-origin — so a looser check locks the console out of its own JavaScript.
 */
/** True when a browser Origin header names the host the request arrived on. */
export function sameOrigin(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function isAdminApi(url: string): boolean {
  if (!url.startsWith('/v1/')) return false;
  return url.includes('/admin/') || url.includes('/catalog/') ||
    url.includes('/synonyms') || url.includes('/redirects') ||
    url.includes('/analytics/');
}

export interface AppOptions {
  databaseUrl?: string;
  enginePath?: string;
  /** Skip API-key checks. Set by COMPASS_DEV_OPEN for the demo storefront. */
  open?: boolean;
  logger?: boolean;
}

export interface BuiltApp {
  app: FastifyInstance;
  engine: SearchEngine;
  db: Db;
  collector: EventCollector;
  sites: SiteRegistry;
  search: SearchService;
  autocomplete: AutocompleteService;
  synonyms: SynonymStore;
  redirects: RedirectStore;
  collections: CollectionStore;
  analytics: AnalyticsService;
  recommend: RecommendService;
  preview: PreviewService;
}

/** Choose the retrieval core: Typesense when configured, SQLite otherwise. */
export function createEngine(options: AppOptions = {}): SearchEngine {
  if (process.env.TYPESENSE_HOST) {
    return new TypesenseEngine({
      host: process.env.TYPESENSE_HOST,
      port: Number(process.env.TYPESENSE_PORT ?? 8108),
      protocol: process.env.TYPESENSE_PROTOCOL ?? 'http',
      apiKey: process.env.TYPESENSE_API_KEY ?? '',
    });
  }
  return new SqliteEngine(options.enginePath ?? process.env.COMPASS_INDEX_PATH ?? './data/compass.db');
}

export async function buildApp(options: AppOptions = {}): Promise<BuiltApp> {
  const db = createPool(options.databaseUrl);
  await migrate(db);

  const engine = createEngine(options);
  const sites = SiteRegistry.load();
  const synonyms = new SynonymStore(db);
  const redirects = new RedirectStore(db);
  const collections = new CollectionStore(db);
  const queryRules = new QueryRuleStore(db);
  const signals = new SignalStore(db);
  const impressions = new ImpressionRecorder(db);
  impressions.start();
  const search = new SearchService(engine, {
    synonyms,
    redirects,
    collections,
    queryRules,
    signals,
    impressions,
    cache: new ResultCache({
      maxEntries: Number(process.env.COMPASS_CACHE_ENTRIES ?? 2_000),
      ttlMs: Number(process.env.COMPASS_CACHE_TTL_MS ?? 60_000),
    }),
  });
  const autocomplete = new AutocompleteService(engine, search, db, redirects);
  const analytics = new AnalyticsService(db);
  const autopilot = new AutopilotService(db, { queryRules, synonyms });
  const recommend = new RecommendService(engine, search, db);
  const preview = new PreviewService(engine);
  const history = new HistoryService(db, { collections, synonyms, redirects });
  const collector = new EventCollector(db);
  collector.start();

  const app = Fastify({
    logger: options.logger === false ? false : { level: process.env.LOG_LEVEL ?? 'info' },
    // The ceiling for a catalogue push. Shopper-facing endpoints are held to a
    // far smaller limit by the guards below.
    bodyLimit: Number(process.env.COMPASS_MAX_BODY_BYTES ?? 64 * 1024 * 1024),
    trustProxy: process.env.COMPASS_TRUST_PROXY === '1',
    ajv: { customOptions: { ...AJV_OPTIONS } },
  });

  // A public search key ships in a storefront bundle, so the search endpoints
  // must tolerate any origin. Admin endpoints must not: a browser should never
  // be able to reach them cross-origin with an admin key.
  await app.register(cors, {
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    origin: (origin, done) => done(null, true),
    hook: 'onRequest',
  });
  app.addHook('onRequest', async (request, reply) => {
    // A browser sends Origin on every non-GET fetch, same-origin included, so
    // the test is whether the origin MATCHES the host — not whether it exists.
    // Rejecting on presence alone locks the admin console out of its own API.
    if (!isAdminApi(request.url)) return;
    const origin = request.headers.origin;
    if (origin && !sameOrigin(origin, request.headers.host)) {
      await reply.code(403).send({ error: 'admin endpoints are not available cross-origin' });
    }
  });

  const metrics = new Metrics();
  registerGuards(app, {
    search: new RateLimiter({
      max: Number(process.env.COMPASS_RATE_SEARCH ?? 600),
      windowMs: 60_000,
    }),
    admin: new RateLimiter({
      // A console screen is several calls, and a merchandiser clicking through
      // screens makes dozens a minute — the previous ceiling of 60 was low
      // enough to rate-limit ordinary use, which shows up as screens that fail
      // to load rather than as anything recognisable as a limit. Still bounded:
      // an admin key that is looping is a bug or a compromise either way.
      max: Number(process.env.COMPASS_RATE_ADMIN ?? 600),
      windowMs: 60_000,
    }),
    metrics,
    trustProxy: process.env.COMPASS_TRUST_PROXY === '1',
    maxSearchBodyBytes: Number(process.env.COMPASS_MAX_SEARCH_BODY_BYTES ?? 32 * 1024),
    isAdminApi,
  });

  const keyStore = new KeyStore(db);
  const open = options.open ?? process.env.COMPASS_DEV_OPEN === '1';
  // Maintenance the deployment would otherwise have to remember: the rollup
  // that keeps the dashboard current runs here, once across all instances.
  const scheduler = new Scheduler({ db, sites, analytics, autopilot, log: app.log });
  scheduler.start();
  await registerRoutes(app, {
    engine, search, autocomplete, synonyms, redirects, collections, analytics, recommend,
    preview, history, queryRules, autopilot, sites, collector, db, auth: { keyStore, open }, scheduler,
  });

  // The demo storefront and the built SDK bundle, when present.
  const demoDir = resolve(HERE, '../../demo/public');
  if (existsSync(demoDir)) {
    await app.register(fastifyStatic, { root: demoDir, prefix: '/demo/' });

    /**
     * Crawlable category and collection pages.
     *
     * The storefront is a JavaScript application, and §4.11 asks for a
     * server-rendered fallback. This serves the same page with the products,
     * the head directives and a plain paginated list already in the markup, so
     * a crawler — or a shopper with JavaScript disabled — gets real content
     * rather than an empty div. The client-side app takes over on load and
     * replaces it.
     *
     * Rendered for the two page types that are landing pages. Internal search
     * results are deliberately not: they are `noindex` by policy, so there is
     * nothing to render them for.
     */
    app.get<{ Params: { kind: string; id: string }; Querystring: Record<string, string> }>(
      '/demo/:kind/:id',
      async (request, reply) => {
        const { kind, id } = request.params;
        if (kind !== 'c' && kind !== 'collections') return reply.callNotFound();
        const site = sites.get(request.query.site ?? sites.list()[0]?.id ?? '');
        if (!site) return reply.callNotFound();

        const body = {
          ...(kind === 'collections'
            ? { collection: decodeURIComponent(id) }
            : { categoryId: decodeURIComponent(id) }),
          page: Math.max(1, Number(request.query.page ?? 1)),
          hitsPerPage: 24,
          seo: true,
          ...(request.query.material ? { filters: { material: [request.query.material] } } : {}),
        };
        const result = search.seoFor(site, body, await search.browse(site, body));
        const { renderCrawlablePage } = await import('./demo/render.js');
        return reply
          .type('text/html')
          .header('cache-control', 'public, max-age=300')
          .send(renderCrawlablePage(site, body, result, demoDir));
      },
    );

    // The seeded storefront's public search keys.
    //
    // A search-scoped key is designed to be visible: it ships inside every
    // storefront bundle and can only read search endpoints and post events.
    // Publishing it here is what lets the demo exercise real authentication
    // instead of running with the door open. Admin keys are never served —
    // the seed prints those for the console to be pasted in once.
    app.get('/demo/config.json', async (_request, reply) => {
      const file = resolve(process.cwd(), 'data/demo/keys.json');
      let keys: Record<string, { search?: string }> = {};
      if (existsSync(file)) {
        try {
          keys = JSON.parse(await readFile(file, 'utf8')) as typeof keys;
        } catch (err) {
          app.log.warn({ err }, 'demo key file is unreadable; storefront will run keyless');
        }
      }
      return reply.header('cache-control', 'no-store').send({
        searchKeys: Object.fromEntries(
          Object.entries(keys)
            .filter(([, v]) => typeof v?.search === 'string')
            .map(([site, v]) => [site, v.search]),
        ),
      });
    });

    // Placeholder product imagery for the seeded catalogue, so the demo grid
    // shows something judgeable instead of broken-image icons.
    const { placeholderSvg } = await import('./demo/placeholder.js');
    app.get<{ Params: { sku: string }; Querystring: { f?: string } }>(
      '/demo/img/:sku',
      async (request, reply) => {
        const sku = request.params.sku.replace(/\.svg$/i, '');
        return reply
          .header('content-type', 'image/svg+xml')
          .header('cache-control', 'public, max-age=86400')
          .send(placeholderSvg(sku, request.query.f ?? ''));
      },
    );
  }
  // The merchandiser console: plain ES modules, no build step, served by the
  // same process that serves the API it talks to.
  const adminDir = resolve(HERE, '../../admin/public');
  if (existsSync(adminDir)) {
    await app.register(fastifyStatic, { root: adminDir, prefix: '/admin/', decorateReply: false });
  }

  /**
   * Browsable API reference.
   *
   * A JSON document is the contract; this is the version a person reads. It
   * renders the same `/openapi.json` the server generates, so there is no
   * second copy to fall behind.
   */
  app.get('/docs', async (_request, reply) =>
    reply.type('text/html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Compass Search — API reference</title>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%231f5f4f'/%3E%3Cpath d='M12 9l-5 7 5 7M20 9l5 7-5 7' stroke='white' stroke-width='2.6' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
  <link rel="stylesheet" href="/admin/app.css">
  <style>
    body { max-width: 940px; margin: 0 auto; padding: 32px 22px 80px; }
    h1 { font-size: 24px; letter-spacing: -.02em; margin: 0 0 4px; }
    .lede { color: var(--muted); margin: 0 0 26px; white-space: pre-wrap; }
    code { font-family: var(--mono); font-size: .92em; background: var(--surface-2);
           padding: 1px 5px; border-radius: 4px; }
    h2 { font-size: 15px; margin: 30px 0 4px; }
    h2 + p { color: var(--muted); margin: 0 0 12px; font-size: 13px; }
    .op { border: 1px solid var(--border); border-radius: var(--radius); padding: 11px 14px; margin-bottom: 8px; }
    .op__head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
    .verb { font: 600 11px/1.6 var(--mono); letter-spacing: .06em; padding: 1px 7px; border-radius: 4px;
            background: var(--surface-2); color: var(--muted); }
    .verb--post { background: var(--accent-soft); color: var(--accent); }
    .verb--delete { background: #fbe5e5; color: #9c2b2b; }
    .path { font-family: var(--mono); font-size: 13px; }
    .op__summary { color: var(--muted); font-size: 13px; margin: 5px 0 0; }
    details { margin-top: 8px; }
    summary { cursor: pointer; font-size: 12px; color: var(--accent); }
    pre { background: var(--surface); border-radius: 6px; padding: 10px 12px; overflow-x: auto;
          font-size: 11.5px; margin: 8px 0 0; }
  </style>
</head>
<body>
  <main id="app"><p class="empty">Loading…</p></main>
  <script type="module">
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    // OpenAPI descriptions are CommonMark. Code spans are the only markup used
    // here, and rendering them beats showing a reader raw backticks.
    const prose = (v) => esc(v).replace(/\`([^\`]+)\`/g, '<code>$1</code>');
    const spec = await (await fetch('/openapi.json')).json();
    const byTag = new Map(spec.tags.map((t) => [t.name, []]));
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        byTag.get(op.tags[0])?.push({ path, method, op });
      }
    }
    document.querySelector('#app').innerHTML = \`
      <h1>\${esc(spec.info.title)} <span class="pill">v\${esc(spec.info.version)}</span></h1>
      <p class="lede">\${prose(spec.info.description)}</p>
      \${spec.tags.map((tag) => \`
        <h2>\${esc(tag.name)}</h2>
        <p>\${prose(tag.description)}</p>
        \${byTag.get(tag.name).map(({ path, method, op }) => \`
          <article class="op">
            <div class="op__head">
              <span class="verb verb--\${method}">\${method.toUpperCase()}</span>
              <span class="path">\${esc(path)}</span>
              \${op['x-required-role']
                ? \`<span class="pill">\${esc(op['x-required-role'])}</span>\`
                : '<span class="pill pill--ok">no key</span>'}
            </div>
            <p class="op__summary">\${esc(op.summary)}</p>
            \${op.requestBody ? \`<details><summary>Request body</summary><pre>\${
              esc(JSON.stringify(op.requestBody.content['application/json'].schema, null, 2))
            }</pre></details>\` : ''}
          </article>\`).join('')}\`).join('')}\`;
  </script>
</body>
</html>`));

  // The SDK ships as plain ES modules, so it is served straight from source.
  const sdkDir = resolve(HERE, '../../sdk/src');
  if (existsSync(sdkDir)) {
    await app.register(fastifyStatic, { root: sdkDir, prefix: '/sdk/', decorateReply: false });
  }

  app.addHook('onClose', async () => {
    scheduler.stop();
    await impressions.stop();
    await collector.stop();
    await engine.close();
    await db.end();
  });

  void join;
  return {
    app, engine, db, collector, sites, search, autocomplete, synonyms, redirects, collections,
    analytics, recommend, preview,
  };
}
