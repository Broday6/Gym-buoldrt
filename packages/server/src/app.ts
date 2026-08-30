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
  const search = new SearchService(engine, {
    synonyms,
    redirects,
    collections,
    cache: new ResultCache({
      maxEntries: Number(process.env.COMPASS_CACHE_ENTRIES ?? 2_000),
      ttlMs: Number(process.env.COMPASS_CACHE_TTL_MS ?? 60_000),
    }),
  });
  const autocomplete = new AutocompleteService(engine, search, db, redirects);
  const analytics = new AnalyticsService(db);
  const recommend = new RecommendService(engine, search, db);
  const preview = new PreviewService(engine);
  const collector = new EventCollector(db);
  collector.start();

  const app = Fastify({
    logger: options.logger === false ? false : { level: process.env.LOG_LEVEL ?? 'info' },
    // The ceiling for a catalogue push. Shopper-facing endpoints are held to a
    // far smaller limit by the guards below.
    bodyLimit: Number(process.env.COMPASS_MAX_BODY_BYTES ?? 64 * 1024 * 1024),
    trustProxy: process.env.COMPASS_TRUST_PROXY === '1',
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
      max: Number(process.env.COMPASS_RATE_ADMIN ?? 60),
      windowMs: 60_000,
    }),
    metrics,
    trustProxy: process.env.COMPASS_TRUST_PROXY === '1',
    maxSearchBodyBytes: Number(process.env.COMPASS_MAX_SEARCH_BODY_BYTES ?? 32 * 1024),
    isAdminApi,
  });

  app.get('/metrics', async () => metrics.snapshot());

  const keyStore = new KeyStore(db);
  const open = options.open ?? process.env.COMPASS_DEV_OPEN === '1';
  await registerRoutes(app, {
    engine, search, autocomplete, synonyms, redirects, collections, analytics, recommend,
    preview, sites, collector, db, auth: { keyStore, open },
  });

  // The demo storefront and the built SDK bundle, when present.
  const demoDir = resolve(HERE, '../../demo/public');
  if (existsSync(demoDir)) {
    await app.register(fastifyStatic, { root: demoDir, prefix: '/demo/' });

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

  // The SDK ships as plain ES modules, so it is served straight from source.
  const sdkDir = resolve(HERE, '../../sdk/src');
  if (existsSync(sdkDir)) {
    await app.register(fastifyStatic, { root: sdkDir, prefix: '/sdk/', decorateReply: false });
  }

  app.addHook('onClose', async () => {
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
