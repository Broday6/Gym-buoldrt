import type { FastifyInstance } from 'fastify';
import type { EventBatch, SearchRequest } from '@compass/shared';
import type { AutocompleteRequest, AutocompleteService } from '../services/autocomplete.js';
import type { SynonymKind, SynonymStore } from '../merchandising/synonyms.js';
import type { MatchType, RedirectStore } from '../merchandising/redirects.js';
import type {
  CollectionInput, CollectionStore, CustomAttributeInput,
} from '../merchandising/collections.js';
import type { AnalyticsService } from '../services/analytics.js';
import type { RecommendRequest, RecommendService } from '../services/recommend.js';
import type { Selector } from '../merchandising/selector.js';
import type { PreviewService } from '../services/preview.js';
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
  collections: CollectionStore;
  analytics: AnalyticsService;
  recommend: RecommendService;
  preview: PreviewService;
  sites: SiteRegistry;
  collector: EventCollector;
  db: Db;
  auth: AuthOptions;
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const {
    engine, search, autocomplete, synonyms, redirects, collections, analytics, recommend,
    preview, sites, collector, db, auth,
  } = deps;
  const searchScope = { preHandler: requireScope('search', auth) };
  const adminScope = { preHandler: requireScope('admin', auth) };

  /**
   * Readiness, for a load balancer. Returns 503 when the instance cannot serve
   * useful traffic, which is a different question from whether the process is
   * alive — `/health` answers that and always returns 200.
   */
  app.get('/health/ready', async (_request, reply) => {
    const documents = await engine.documentCount(sites.list()[0]?.id ?? '');
    if (documents === 0) {
      return reply.code(503).send({ status: 'not_ready', reason: 'no documents indexed' });
    }
    return { status: 'ready', documents };
  });

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
      if (!body.categoryId && !body.collection) {
        return reply.code(400).send({ error: 'browse needs a categoryId or a collection' });
      }
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
      collections: await collections.browsable(site.id),
      sortOptions: SORT_OPTIONS,
      currency: site.currency,
    };
  });

  // ---- recommendations ---------------------------------------------------

  app.post<{ Params: { site: string }; Body: RecommendRequest }>(
    '/v1/:site/recommend',
    searchScope,
    async (request, reply) => {
      const site = sites.get(request.params.site);
      if (!site) return reply.code(404).send({ error: `unknown site "${request.params.site}"` });
      const body = request.body ?? ({ kind: 'top_sellers' } as RecommendRequest);
      return recommend.recommend(site, body);
    },
  );

  // ---- analytics ---------------------------------------------------------

  app.get<{ Params: { site: string }; Querystring: { days?: string } }>(
    '/v1/:site/analytics/overview',
    adminScope,
    async (request) => analytics.overview(request.params.site, days(request.query.days)),
  );

  app.get<{ Params: { site: string }; Querystring: { days?: string; limit?: string; format?: string } }>(
    '/v1/:site/analytics/queries',
    adminScope,
    async (request, reply) => {
      const rows = await analytics.topQueries(
        request.params.site, days(request.query.days), Number(request.query.limit ?? 25),
      );
      if (request.query.format === 'csv') {
        return reply.header('content-type', 'text/csv').send(analytics.toCsv(rows as never));
      }
      return { queries: rows };
    },
  );

  app.get<{ Params: { site: string }; Querystring: { days?: string; limit?: string; format?: string } }>(
    '/v1/:site/analytics/problems',
    adminScope,
    async (request, reply) => {
      const rows = await analytics.problemQueries(
        request.params.site, days(request.query.days), Number(request.query.limit ?? 25),
      );
      if (request.query.format === 'csv') {
        return reply.header('content-type', 'text/csv').send(analytics.toCsv(rows as never));
      }
      return { queries: rows };
    },
  );

  app.get<{ Params: { site: string }; Querystring: { days?: string } }>(
    '/v1/:site/analytics/trending',
    adminScope,
    async (request) => analytics.trending(request.params.site, days(request.query.days, 7)),
  );

  app.get<{ Params: { site: string }; Querystring: { days?: string } }>(
    '/v1/:site/analytics/facets',
    adminScope,
    async (request) => ({
      facets: await analytics.facetUsage(request.params.site, days(request.query.days)),
    }),
  );

  app.get<{ Params: { site: string }; Querystring: { days?: string } }>(
    '/v1/:site/analytics/timeseries',
    adminScope,
    async (request) => ({
      points: await analytics.timeseries(request.params.site, days(request.query.days)),
    }),
  );

  app.get<{ Params: { site: string }; Querystring: { q: string; days?: string } }>(
    '/v1/:site/analytics/clicked',
    adminScope,
    async (request, reply) => {
      if (!request.query.q) return reply.code(400).send({ error: 'q is required' });
      return {
        products: await analytics.clickedProducts(
          request.params.site, request.query.q, days(request.query.days),
        ),
      };
    },
  );

  app.post<{ Params: { site: string }; Body: { days?: number } }>(
    '/v1/:site/analytics/rollup',
    adminScope,
    async (request) => analytics.rollup(request.params.site, request.body?.days ?? 30),
  );

  // ---- badges ------------------------------------------------------------

  app.get<{ Params: { site: string } }>('/v1/:site/admin/badges', adminScope, async (request) => ({
    badges: (await collections.listBadges(request.params.site)).map((b) => ({
      key: b.key, label: b.label, tone: b.tone, priority: b.priority, enabled: b.enabled,
    })),
  }));

  app.post<{
    Params: { site: string };
    Body: { key: string; label: string; tone?: string; selector: Selector; priority?: number };
  }>('/v1/:site/admin/badges', adminScope, async (request, reply) => {
    try {
      const created = await collections.createBadge(request.params.site, request.body as never);
      search.invalidate(request.params.site);
      return reply.code(201).send({ ...created, reindexRequired: true });
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.delete<{ Params: { site: string; key: string } }>(
    '/v1/:site/admin/badges/:key',
    adminScope,
    async (request, reply) => {
      const removed = await collections.removeBadge(request.params.site, request.params.key);
      if (!removed) return reply.code(404).send({ error: 'no such badge' });
      search.invalidate(request.params.site);
      return { deleted: true, reindexRequired: true };
    },
  );

  // ---- collections and custom attributes ---------------------------------

  /**
   * Shopper-facing: the collections that may be browsed right now. Scheduled
   * and internal ones are built into the index but never listed here.
   */
  app.get<{ Params: { site: string } }>('/v1/:site/collections', searchScope, async (request, reply) => {
    const site = sites.get(request.params.site);
    if (!site) return reply.code(404).send({ error: `unknown site "${request.params.site}"` });
    return { collections: await collections.browsable(site.id) };
  });

  app.get<{ Params: { site: string } }>(
    '/v1/:site/admin/collections',
    adminScope,
    async (request) => ({ collections: await collections.list(request.params.site) }),
  );

  /**
   * Count what a rule would catch, before it is saved. The visual builder calls
   * this on every edit, which is what makes a rule trustworthy enough to save.
   */
  app.post<{ Params: { site: string }; Body: { selector: Selector } }>(
    '/v1/:site/admin/collections/preview',
    adminScope,
    async (request, reply) => {
      try {
        return await preview.preview(request.params.site, request.body?.selector);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  app.post<{ Params: { site: string }; Body: CollectionInput }>(
    '/v1/:site/admin/collections',
    adminScope,
    async (request, reply) => {
      const site = sites.get(request.params.site);
      if (!site) return reply.code(404).send({ error: `unknown site "${request.params.site}"` });
      try {
        const created = await collections.create(site.id, { ...request.body, author: actorOf(request) });
        await audit(db, site.id, actorOf(request), 'upsert', 'collection', created.slug, null, created);
        search.invalidate(site.id);
        return reply.code(201).send(created);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  app.post<{
    Params: { site: string; slug: string };
    Body: { members: { parentId: string; mode?: 'include' | 'exclude'; position?: number | null }[] };
  }>('/v1/:site/admin/collections/:slug/members', adminScope, async (request, reply) => {
    try {
      const applied = await collections.setMembers(
        request.params.site, request.params.slug, request.body?.members ?? [], actorOf(request),
      );
      search.invalidate(request.params.site);
      // Membership is stamped into the index at ingest, so a manual change
      // needs a reindex before shoppers see it. Say so rather than implying
      // the change is already live.
      return { applied, reindexRequired: true };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.delete<{ Params: { site: string; slug: string } }>(
    '/v1/:site/admin/collections/:slug',
    adminScope,
    async (request, reply) => {
      const removed = await collections.remove(request.params.site, request.params.slug);
      if (!removed) return reply.code(404).send({ error: 'no such collection' });
      await audit(db, request.params.site, actorOf(request), 'delete', 'collection',
        request.params.slug, null, null);
      search.invalidate(request.params.site);
      return { deleted: true, reindexRequired: true };
    },
  );

  app.get<{ Params: { site: string } }>(
    '/v1/:site/admin/attributes',
    adminScope,
    async (request) => ({
      attributes: (await collections.listAttributes(request.params.site)).map((a) => ({
        key: a.key, label: a.label, displayType: a.displayType, enabled: a.enabled,
        position: a.position,
        values: a.values.map((v) => ({
          value: v.value, hasRule: v.selector !== null,
          manualIncludes: v.includes.size, manualExcludes: v.excludes.size,
        })),
      })),
    }),
  );

  app.post<{ Params: { site: string }; Body: CustomAttributeInput }>(
    '/v1/:site/admin/attributes',
    adminScope,
    async (request, reply) => {
      const site = sites.get(request.params.site);
      if (!site) return reply.code(404).send({ error: `unknown site "${request.params.site}"` });
      try {
        const created = await collections.createAttribute(site.id, {
          ...request.body, author: actorOf(request),
        });
        await audit(db, site.id, actorOf(request), 'upsert', 'attribute', created.key, null, created);
        search.invalidate(site.id);
        return reply.code(201).send({ ...created, reindexRequired: true });
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  app.post<{
    Params: { site: string; key: string };
    Body: { value: string; parentIds: string[]; mode?: 'include' | 'exclude' };
  }>('/v1/:site/admin/attributes/:key/assign', adminScope, async (request, reply) => {
    try {
      const applied = await collections.assign(
        request.params.site, request.params.key, request.body.value,
        request.body.parentIds ?? [], request.body.mode ?? 'include', actorOf(request),
      );
      search.invalidate(request.params.site);
      return { applied, reindexRequired: true };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.delete<{ Params: { site: string; key: string } }>(
    '/v1/:site/admin/attributes/:key',
    adminScope,
    async (request, reply) => {
      const removed = await collections.removeAttribute(request.params.site, request.params.key);
      if (!removed) return reply.code(404).send({ error: 'no such attribute' });
      search.invalidate(request.params.site);
      return { deleted: true, reindexRequired: true };
    },
  );

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
      const result = await ingestRows(engine, site.id, sourceRows, {
        mapping,
        labels: await collections.plan(site.id),
      });
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

  /**
   * Webhook path: add or replace individual products in the live index.
   *
   * A single product changing must not require rebuilding the whole index, and
   * a discontinued line must be removable in seconds rather than at the next
   * nightly refresh.
   */
  app.post<{
    Params: { site: string };
    Body: { rows?: SourceRow[]; csv?: string; mapping?: IngestOptions['mapping'] };
  }>('/v1/:site/catalog/records', adminScope, async (request, reply) => {
    const site = sites.get(request.params.site);
    if (!site) return reply.code(404).send({ error: `unknown site "${request.params.site}"` });
    const { rows, csv, mapping } = request.body ?? {};
    if (!rows?.length && !csv) return reply.code(400).send({ error: 'provide rows[] or csv' });

    const { parseCsv } = await import('../ingest/pipeline.js');
    const { inferMapping, mergeMapping } = await import('../ingest/mapping.js');
    const { normalizeRows, toVariantDocs } = await import('../ingest/normalize.js');
    const { applyLabels } = await import('../merchandising/labels.js');

    const sourceRows = rows?.length ? rows : parseCsv(csv!);
    const resolved = mergeMapping(inferMapping(Object.keys(sourceRows[0] ?? {})), mapping);
    const { products, quality } = normalizeRows(site.id, sourceRows, resolved);
    // Merchandiser structure is reapplied here too, so a product arriving by
    // webhook lands in the same collections a full ingest would put it in.
    const { products: labelled } = applyLabels(products, await collections.plan(site.id));
    const docs = toVariantDocs(site.id, labelled);

    const started = Date.now();
    const upserted = await engine.upsertDocuments(site.id, docs);
    search.invalidate(site.id);
    autocomplete.invalidate(site.id);
    return {
      productsUpserted: products.length,
      variantsUpserted: upserted,
      durationMs: Date.now() - started,
      issues: summariseQuality(quality),
    };
  });

  app.delete<{ Params: { site: string }; Body: { skus: string[] } }>(
    '/v1/:site/catalog/records',
    adminScope,
    async (request, reply) => {
      const site = sites.get(request.params.site);
      if (!site) return reply.code(404).send({ error: `unknown site "${request.params.site}"` });
      const skus = request.body?.skus ?? [];
      if (!skus.length) return reply.code(400).send({ error: 'skus array is required' });
      const started = Date.now();
      const deleted = await engine.deleteBySku(site.id, skus);
      if (deleted > 0) {
        search.invalidate(site.id);
        autocomplete.invalidate(site.id);
      }
      return { requested: skus.length, deleted, durationMs: Date.now() - started };
    },
  );

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

/** Bounded day window, so a query string cannot ask for an unbounded scan. */
function days(raw: string | undefined, fallback = 30): number {
  const n = Number(raw ?? fallback);
  return Number.isFinite(n) ? Math.min(365, Math.max(1, Math.round(n))) : fallback;
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
