import type { FastifyInstance } from 'fastify';
import type { EventBatch, SearchRequest } from '@compass/shared';
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
  sites: SiteRegistry;
  collector: EventCollector;
  db: Db;
  auth: AuthOptions;
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { engine, search, sites, collector, db, auth } = deps;
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
    return { status: healthy ? 'ok' : 'degraded', checks, documents: counts, events: collector.stats() };
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
