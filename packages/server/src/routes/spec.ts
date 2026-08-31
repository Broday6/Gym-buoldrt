/**
 * Build the OpenAPI document without starting a server.
 *
 * Registering the routes is the only way to describe them accurately, so this
 * registers them against a throwaway Fastify instance with inert dependencies.
 * Nothing is called — handlers are closures, and route registration never runs
 * them — so no database, index or network is needed. That is what lets both the
 * generator and the drift test run anywhere.
 */
import Fastify from 'fastify';
import { SiteRegistry } from '../config/sites.js';
import { KeyStore } from './auth.js';
import { registerRoutes } from './index.js';
import { buildSpec, reconcile, trackRoutes, type RouteRecord } from './openapi.js';
import { AJV_OPTIONS, SHARED_SCHEMAS } from './schemas.js';
import { Metrics, RateLimiter, registerGuards } from './guards.js';
import type { Db } from '../db/pool.js';

/** A database that answers nothing, because nothing asks during registration. */
const inertDb = {
  query: async () => ({ rows: [], rowCount: 0 }),
  end: async () => {},
} as unknown as Db;

const inert = new Proxy({}, { get: () => () => undefined });

export async function collectRoutes(): Promise<RouteRecord[]> {
  const app = Fastify({ logger: false, ajv: { customOptions: { ...AJV_OPTIONS } } });
  const routes = trackRoutes(app);
  // The guards register routes of their own (/metrics), so they are part of the
  // API surface and belong in its description.
  registerGuards(app, {
    search: new RateLimiter({ max: 1, windowMs: 1 }),
    admin: new RateLimiter({ max: 1, windowMs: 1 }),
    metrics: new Metrics(),
    isAdminApi: () => false,
    trustProxy: false,
    maxSearchBodyBytes: 1,
  });
  await registerRoutes(app, {
    engine: inert, search: inert, autocomplete: inert, synonyms: inert, redirects: inert,
    collections: inert, analytics: inert, recommend: inert, preview: inert, history: inert,
    sites: SiteRegistry.load(), collector: inert, db: inertDb,
    auth: { keyStore: new KeyStore(inertDb), open: false },
  } as unknown as Parameters<typeof registerRoutes>[1]);
  await app.ready();
  await app.close();
  return routes;
}

export async function generateSpec(): Promise<object> {
  const routes = await collectRoutes();
  const { undocumented, stale } = reconcile(routes);
  if (undocumented.length || stale.length) {
    throw new Error(
      [
        undocumented.length ? `routes with no documentation: ${undocumented.join(', ')}` : '',
        stale.length ? `documented routes that no longer exist: ${stale.join(', ')}` : '',
        'Edit DOCS in packages/server/src/routes/openapi.ts.',
      ].filter(Boolean).join('\n'),
    );
  }
  const { version } = JSON.parse(
    (await import('node:fs')).readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  return buildSpec(routes, version, [...SHARED_SCHEMAS]);
}
