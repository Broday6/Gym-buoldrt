import type { FastifyInstance } from 'fastify';
import type { EventBatch, SearchRequest } from '@compass/shared';
import type { AutocompleteRequest, AutocompleteService } from '../services/autocomplete.js';
import type { SynonymKind, SynonymStore } from '../merchandising/synonyms.js';
import type { MatchType, RedirectStore } from '../merchandising/redirects.js';
import type { SearchEngine } from '../engine/types.js';
import type { SearchService } from '../services/search.js';
import type { EventCollector } from '../events/collector.js';
import type { Db } from '../db/pool.js';
import { SiteNotFoundError, SORT_OPTIONS, type SiteRegistry } from '../config/sites.js';
import { ingestRows, summariseQuality, type IngestOptions } from '../ingest/pipeline.js';
import { requireScope, type AuthOptions } from './auth.js';
import type { SourceRow } from '../ingest/normalize.js';

export interface RouteDeps {
  engine: SearchEngine;
  search: SearchService;
  autocomplete: AutocompleteService;
  synonyms: SynonymStore;
  redirects: RedirectStore;
  sites: SiteRegistry;
  collector: EventCollector;
  db: Db;
  auth: AuthOptions;
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { engine, search, autocomplete, synonyms, redirects, sites, collector, db, auth } = deps;
  const searchScope = { preHandler: requireScope('search', auth) };
  const adminScope = { preHandler: requireScope('admin', auth) };

  app.get('/health', async () => {
    const checks: Record<string, string> = { engine: engine.kind };
    try {
      await db.query('SELECT 1');
      checks.database = 'ok';
    } catch (err) {
      checks.database = `error: ${(err as Error).message}`;
    }
    const counts: Record<string, number> = {};
    for (const site of sites.list()) counts[site.id] = await engine.documentCount(site.id);
    const healthy = checks.database === 'ok';
    return {
      status: healthy ? 'ok' : 'degraded',
      checks,
      documents: counts,
      events: collector.stats(),
      cache: search.cacheStats(),
    };
  });

  app.get('/v1/sites', async () => ({
    sites: sites.list().map((s) => ({ id: s.id, name: s.name, currency: s.currency })),
    sortOptions: SORT_OPTIONS,
  }));

  app.post<{ Params: { site: string }; Body: SearchRequest }>(
    '/v1/:site/search',
    searchScope,
    async (request, reply) => {
      const site = sites.get(request.params.site);
      if (!site) return reply.code(404).send({ error: `unknown site "${request.params.site}"` });
      const body = request.body ?? {};
      const response = await search.search(site, body);
      // Search volume is the analytics backbone, so it is recorded server-side
      // rather than trusted to a client-side beacon that ad blockers eat.
      if (body.shopperId && body.sessionId && (body.q ?? '').trim()) {
        collector.collect([{
          type: response.totalHits === 0 ? 'zero_result' : 'search',
          site: site.id,
          shopperId: body.shopperId,
          sessionId: body.sessionId,
          query: body.q,
          resultCount: response.totalHits,
          filters: body.filters,
          analyticsTags: body.analyticsTags,
          // A rescued query still counts as a zero-result query for the
          // merchandiser: it needed saving, and that is what they must fix.
          rescueStrategy: response.rescue?.strategy,
          effectiveQuery: response.effectiveQuery,
        }]);
      }
      return response;
    },
  );

  app.post<{ Params: { site: string }; Body: SearchRequest }>(
    '/v1/:site/browse',
    searchScope,
    async (request, reply) => {
      const site = sites.get(request.params.site);
      if (!site) return reply.code(404).send({ error: `unknown site "${request.params.site}"` });
      const body = request.body ?? {};
      if (!body.categoryId) return reply.code(400).send({ error: 'categoryId is required for browse' });
      return search.browse(site, body);
    },
  );

  app.post<{ Params: { site: string }; Body: AutocompleteRequest }>(
    '/v1/:site/autocomplete',
    searchScope,
    async (request, reply) => {
      const site = sites.get(request.params.site);
      if (!site) return reply.code(404).send({ error: `unknown site "${request.params.site}"` });
      return autocomplete.complete(site, request.body ?? { q: '' });
    },
  );

  app.get<{ Params: { site: string } }>('/v1/:site/directory', searchScope, async (request, reply) => {
    const site = sites.get(request.params.site);
    if (!site) return reply.code(404).send({ error: `unknown site "${request.params.site}"` });
    const directory = await engine.directory(site.id);
    return {
      site: site.id,
      // Top-level categories first; the SDK builds its nav from this.
      categories: directory.categories.sort((a, b) => a.id.localeCompare(b.id)),
      brands: directory.brands,
      facets: site.defaultFacets,
      sortOptions: SORT_OPTIONS,
      currency: site.currency,
    };
  });

  // ---- synonyms ----------------------------------------------------------

  app.get<{ Params: { site: string } }>('/v1/:site/synonyms', adminScope, async (request) => ({
    synonyms: await synonyms.list(request.params.site),
  }));

  app.post<{
    Params: { site: string };
    Body: { kind: SynonymKind; fromTerms?: string[]; terms: string[]; note?: string };
  }>('/v1/:site/synonyms', adminScope, async (request, reply) => {
    const site = sites.get(request.params.site);
    if (!site) return reply.code(404).send({ error: `unknown site "${request.params.site}"` });
    try {
      const rule = await synonyms.create(site.id, { ...request.body, author: actorOf(request) });
      await audit(db, site.id, actorOf(request), 'create', 'synonym', String(rule.id), null, rule);
      // A synonym changes what every cached query returns.
      search.invalidate(site.id);
      return reply.code(201).send(rule);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.delete<{ Params: { site: string; id: string } }>(
    '/v1/:site/synonyms/:id',
    adminScope,
    async (request, reply) => {
      const removed = await synonyms.remove(request.params.site, Number(request.params.id));
      if (!removed) return reply.code(404).send({ error: 'no such synonym' });
      await audit(db, request.params.site, actorOf(request), 'delete', 'synonym', request.params.id, null, null);
      search.invalidate(request.params.site);
      return { deleted: true };
    },
  );

  // ---- redirects ---------------------------------------------------------

  app.get<{ Params: { site: string } }>('/v1/:site/redirects', adminScope, async (request) => ({
    redirects: await redirects.list(request.params.site),
  }));

  app.post<{
    Params: { site: string };
    Body: { pattern: string; matchType: MatchType; url: string; label?: string; priority?: number };
  }>('/v1/:site/redirects', adminScope, async (request, reply) => {
    const site = sites.get(request.params.site);
    if (!site) return reply.code(404).send({ error: `unknown site "${request.params.site}"` });
    try {
      const rule = await redirects.create(site.id, { ...request.body, author: actorOf(request) });
      await audit(db, site.id, actorOf(request), 'create', 'redirect', String(rule.id), null, rule);
      search.invalidate(site.id);
      return reply.code(201).send(rule);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.delete<{ Params: { site: string; id: string } }>(
    '/v1/:site/redirects/:id',
    adminScope,
    async (request, reply) => {
      const removed = await redirects.remove(request.params.site, Number(request.params.id));
      if (!removed) return reply.code(404).send({ error: 'no such redirect' });
      await audit(db, request.params.site, actorOf(request), 'delete', 'redirect', request.params.id, null, null);
      search.invalidate(request.params.site);
      return { deleted: true };
    },
  );

  app.post<{ Params: { site: string }; Body: EventBatch }>(
    '/v1/:site/events',
    searchScope,
    async (request, reply) => {
      const events = (request.body?.events ?? []).map((e) => ({ ...e, site: request.params.site }));
      if (events.length === 0) return reply.code(400).send({ error: 'events array is required' });
      if (events.length > 500) return reply.code(413).send({ error: 'batch limited to 500 events' });
      const { accepted, rejected } = collector.collect(events);
      return reply.code(accepted > 0 ? 202 : 400).send({ accepted, rejected });
    },
  );

  app.post<{
    Params: { site: string };
    Body: { rows?: SourceRow[]; csv?: string; mapping?: IngestOptions['mapping']; source?: string };
  }>('/v1/:site/catalog/batch', adminScope, async (request, reply) => {
    const site = sites.get(request.params.site);
    if (!site) return reply.code(404).send({ error: `unknown site "${request.params.site}"` });
    const { rows, csv, mapping, source } = request.body ?? {};
    if (!rows?.length && !csv) return reply.code(400).send({ error: 'provide rows[] or csv' });

    const { parseCsv } = await import('../ingest/pipeline.js');
    const sourceRows = rows?.length ? rows : parseCsv(csv!);
    try {
      const result = await ingestRows(engine, site.id, sourceRows, { mapping });
      await db.query(
        `INSERT INTO ingest_runs (site_id, index_name, source, products, variants, duration_ms, quality, mapping)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [site.id, result.indexName, source ?? 'api', result.productsIndexed, result.variantsIndexed,
         result.durationMs, JSON.stringify(result.quality), JSON.stringify(result.mapping)],
      );
      // A new index invalidates every cached result for the site.
      search.invalidate(site.id);
      autocomplete.invalidate(site.id);
      return { ...result, issues: summariseQuality(result.quality) };
    } catch (err) {
      await db.query(
        `INSERT INTO ingest_runs (site_id, index_name, source, status, error) VALUES ($1,'','${'api'}','error',$2)`,
        [site.id, (err as Error).message],
      );
      throw err;
    }
  });

  /** Price/inventory deltas against the live index; the real-time path. */
  app.post<{
    Params: { site: string };
    Body: { updates: { sku: string; price?: number; salePrice?: number; inventory?: number }[] };
  }>('/v1/:site/catalog/updates', adminScope, async (request, reply) => {
    const site = sites.get(request.params.site);
    if (!site) return reply.code(404).send({ error: `unknown site "${request.params.site}"` });
    const updates = request.body?.updates ?? [];
    if (!updates.length) return reply.code(400).send({ error: 'updates array is required' });
    const started = Date.now();
    const changed = await engine.partialUpdate(site.id, updates);
    // Price and stock are visible in results, so cached pages are now stale.
    if (changed > 0) search.invalidate(site.id);
    return { requested: updates.length, updated: changed, durationMs: Date.now() - started };
  });

  app.get<{ Params: { site: string } }>('/v1/:site/catalog/status', adminScope, async (request, reply) => {
    const site = sites.get(request.params.site);
    if (!site) return reply.code(404).send({ error: `unknown site "${request.params.site}"` });
    const { rows } = await db.query(
      `SELECT index_name, source, products, variants, duration_ms, quality, status, error, started_at
       FROM ingest_runs WHERE site_id = $1 ORDER BY started_at DESC LIMIT 10`,
      [site.id],
    );
    return { site: site.id, documents: await engine.documentCount(site.id), runs: rows };
  });

  /** Who made an admin change. Roles land with the admin console in Phase 3. */
  function actorOf(request: { headers: Record<string, unknown> }): string {
    const header = request.headers['x-compass-actor'];
    return (Array.isArray(header) ? header[0] : (header as string)) || 'api';
  }

  app.setErrorHandler(async (error: unknown, request, reply) => {
    if (error instanceof SiteNotFoundError) {
      return reply.code(404).send({ error: error.message });
    }
    const err = error as { message?: string; statusCode?: number };
    const message = err.message ?? 'internal error';
    request.log.error({ err: message, url: request.url }, 'request failed');
    return reply.code(err.statusCode ?? 500).send({ error: message });
  });
}

/** Every merchandising change is recorded with its author and timestamp. */
async function audit(
  db: Db,
  siteId: string,
  actor: string,
  action: string,
  entityType: string,
  entityId: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (site_id, actor, action, entity_type, entity_id, before, after)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [siteId, actor, action, entityType, entityId,
     before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null],
  );
}
