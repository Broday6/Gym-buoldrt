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
import type { HistoryService } from '../services/history.js';
import type { SearchEngine } from '../engine/types.js';
import type { SearchService } from '../services/search.js';
import type { EventCollector } from '../events/collector.js';
import type { Db } from '../db/pool.js';
import { SiteNotFoundError, SORT_OPTIONS, type SiteRegistry } from '../config/sites.js';
import { ingestRows, summariseQuality, type IngestOptions } from '../ingest/pipeline.js';
import {
  ROLE_SUMMARY, requireScope, roleCovers,
  type AuthOptions, type KeyIdentity, type KeyScope,
} from './auth.js';
import * as S from './schemas.js';
import { seoConfigFor, sitemapXml } from '../services/seo.js';
import { buildSpec, trackRoutes } from './openapi.js';
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
  history: HistoryService;
  sites: SiteRegistry;
  collector: EventCollector;
  db: Db;
  auth: AuthOptions;
  scheduler?: { status: () => Record<string, { at: string; result: string; ok: boolean }> };
}

/** Reported in the generated spec, so a consumer can tell versions apart. */
const VERSION = process.env.npm_package_version ?? '0.1.0';

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const {
    engine, search, autocomplete, synonyms, redirects, collections, analytics, recommend,
    preview, history, sites, collector, db, auth, scheduler,
  } = deps;
  // Roles are ordered, so each guard names the *least* privilege that endpoint
  // needs and everything above it is admitted automatically.
  const searchScope = { preHandler: requireScope('search', auth), role: 'search' as const };
  const analystScope = { preHandler: requireScope('analyst', auth), role: 'analyst' as const };
  const merchScope = { preHandler: requireScope('merchandiser', auth), role: 'merchandiser' as const };
  const adminScope = { preHandler: requireScope('admin', auth), role: 'admin' as const };

  // Shared rule fragments, registered once so the selector definition has a
  // single home rather than a copy inside every schema that accepts a rule.
  for (const schema of S.SHARED_SCHEMAS) app.addSchema(schema);

  /**
   * Route options: the role guard, plus the schema that has to hold before the
   * handler runs. Written as one call so a new endpoint cannot pick up
   * authentication and forget validation.
   */
  const guard = (
    scope: { preHandler: ReturnType<typeof requireScope>; role: KeyScope },
    schema: Parameters<typeof S.forSite>[0] = {},
    extraParams: Parameters<typeof S.forSite>[1] = {},
  ) => ({
    preHandler: scope.preHandler,
    schema: S.forSite(schema, extraParams),
    // Carried through to the generated spec, so the documented role and the
    // enforced role are the same value rather than two that agree by habit.
    config: { role: scope.role },
  });

  // Recorded as Fastify registers each route, so the spec below is the route
  // table itself rather than a description of it.
  const registered = trackRoutes(app);

  app.get('/openapi.json', async (_request, reply) =>
    reply.header('cache-control', 'public, max-age=300')
      .send(buildSpec(registered, VERSION, [...S.SHARED_SCHEMAS])));

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
      // A scheduled job that stops working is otherwise invisible until someone
      // notices the dashboard has not moved for a week.
      scheduled: scheduler?.status() ?? {},
    };
  });

  app.get('/v1/sites', async () => ({
    sites: sites.list().map((s) => ({ id: s.id, name: s.name, currency: s.currency })),
    sortOptions: SORT_OPTIONS,
  }));

  /**
   * What this key can do.
   *
   * The console asks on load and hides what the role cannot use. Showing a
   * merchandiser buttons that will 403 is worse than not showing them: they
   * look like bugs.
   */
  app.get<{ Params: { site: string } }>('/v1/:site/whoami', guard(searchScope, {}), async (request) => {
    const identity = (request as typeof request & { identity?: KeyIdentity }).identity;
    const role: KeyScope = identity?.scope ?? 'admin';
    return {
      site: request.params.site,
      role,
      description: ROLE_SUMMARY[role],
      can: {
        search: roleCovers(role, 'search'),
        analytics: roleCovers(role, 'analyst'),
        merchandise: roleCovers(role, 'merchandiser'),
        administer: roleCovers(role, 'admin'),
      },
    };
  });

  app.post<{ Params: { site: string }; Body: SearchRequest }>(
    '/v1/:site/search',
    guard(searchScope, { body: S.searchBody }),
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
    guard(searchScope, { body: S.searchBody }),
    async (request, reply) => {
      const site = sites.get(request.params.site);
      if (!site) return reply.code(404).send({ error: `unknown site "${request.params.site}"` });
      const body = request.body ?? {};
      if (!body.categoryId && !body.collection) {
        return reply.code(400).send({ error: 'browse needs a categoryId or a collection' });
      }
      return search.seoFor(site, body, await search.browse(site, body));
    },
  );

  app.post<{ Params: { site: string }; Body: AutocompleteRequest }>(
    '/v1/:site/autocomplete',
    guard(searchScope, { body: S.autocompleteBody }),
    async (request, reply) => {
      const site = sites.get(request.params.site);
      if (!site) return reply.code(404).send({ error: `unknown site "${request.params.site}"` });
      return autocomplete.complete(site, request.body ?? { q: '' });
    },
  );

  /**
   * Sitemap of the pages worth ranking.
   *
   * Categories and enabled collections only. Filter permutations are
   * deliberately absent: listing them would ask a crawler to spend its budget
   * on exactly the URLs the canonical rules tell it to ignore.
   */
  app.get<{ Params: { site: string } }>(
    '/v1/:site/sitemap.xml',
    guard(searchScope, {}),
    async (request, reply) => {
      const site = sites.get(request.params.site);
      if (!site) return reply.code(404).send({ error: `unknown site "${request.params.site}"` });
      const directory = await engine.directory(site.id);
      // Browsable, not merely defined: a scheduled or disabled collection is
      // not a page, and a sitemap that lists one asks a crawler to 404.
      const published = await collections.browsable(site.id).catch(() => []);
      const entries = [
        ...directory.categories.map((c) => ({
          kind: 'category' as const, id: c.id, products: c.products,
        })),
        ...published.map((c: { slug: string }) =>
          ({ kind: 'collection' as const, id: c.slug, products: 1 })),
      ];
      return reply
        .type('application/xml')
        .header('cache-control', 'public, max-age=3600')
        .send(sitemapXml(entries, seoConfigFor(site.id)));
    },
  );

  app.get<{ Params: { site: string } }>('/v1/:site/directory', guard(searchScope, {}), async (request, reply) => {
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
    guard(searchScope, { body: S.recommendBody }),
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
    guard(analystScope, { querystring: S.reportQuery }),
    async (request) => analytics.overview(request.params.site, days(request.query.days)),
  );

  app.get<{ Params: { site: string }; Querystring: { days?: string; limit?: string; format?: string } }>(
    '/v1/:site/analytics/queries',
    guard(analystScope, { querystring: S.reportQuery }),
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
    guard(analystScope, { querystring: S.reportQuery }),
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
    guard(analystScope, { querystring: S.reportQuery }),
    async (request) => analytics.trending(request.params.site, days(request.query.days, 7)),
  );

  app.get<{ Params: { site: string }; Querystring: { days?: string } }>(
    '/v1/:site/analytics/facets',
    guard(analystScope, { querystring: S.reportQuery }),
    async (request) => ({
      facets: await analytics.facetUsage(request.params.site, days(request.query.days)),
    }),
  );

  app.get<{ Params: { site: string }; Querystring: { days?: string } }>(
    '/v1/:site/analytics/timeseries',
    guard(analystScope, { querystring: S.reportQuery }),
    async (request) => ({
      points: await analytics.timeseries(request.params.site, days(request.query.days)),
    }),
  );

  app.get<{ Params: { site: string }; Querystring: { q: string; days?: string } }>(
    '/v1/:site/analytics/clicked',
    guard(analystScope, { querystring: S.queryDetailQuery }),
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
    guard(merchScope, { body: S.rollupBody }),
    async (request) => analytics.rollup(request.params.site, request.body?.days ?? 30),
  );

  // ---- badges ------------------------------------------------------------

  app.get<{ Params: { site: string } }>('/v1/:site/admin/badges', guard(merchScope, {}), async (request) => ({
    badges: (await collections.listBadges(request.params.site)).map((b) => ({
      key: b.key, label: b.label, tone: b.tone, priority: b.priority, enabled: b.enabled,
    })),
  }));

  app.post<{
    Params: { site: string };
    Body: { key: string; label: string; tone?: string; selector: Selector; priority?: number };
  }>('/v1/:site/admin/badges', guard(merchScope, { body: S.badgeBody }), async (request, reply) => {
    try {
      const badgeNamed = async (key: string) =>
        (await collections.listBadges(request.params.site)).find((b) => b.key === key) ?? null;
      const before = await badgeNamed(request.body.key);
      const created = await collections.createBadge(request.params.site, request.body as never);
      // Badges were the one merchandising surface with no audit trail — a
      // change nobody could see the history of, or undo. Both sides are read
      // back from storage so the diff compares like with like: the request body
      // and the stored record do not have the same shape, and a diff between
      // them invents changes to fields nobody touched.
      await audit(db, request.params.site, actorOf(request), 'upsert', 'badge',
        created.key, before, await badgeNamed(created.key));
      search.invalidate(request.params.site);
      return reply.code(201).send({ ...created, reindexRequired: true });
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.delete<{ Params: { site: string; key: string } }>(
    '/v1/:site/admin/badges/:key',
    guard(merchScope, {}, S.KEY_PARAM),
    async (request, reply) => {
      const before = (await collections.listBadges(request.params.site))
        .find((b) => b.key === request.params.key) ?? null;
      const removed = await collections.removeBadge(request.params.site, request.params.key);
      if (!removed) return reply.code(404).send({ error: 'no such badge' });
      await audit(db, request.params.site, actorOf(request), 'delete', 'badge',
        request.params.key, before, null);
      search.invalidate(request.params.site);
      return { deleted: true, reindexRequired: true };
    },
  );

  // ---- collections and custom attributes ---------------------------------

  /**
   * Shopper-facing: the collections that may be browsed right now. Scheduled
   * and internal ones are built into the index but never listed here.
   */
  app.get<{ Params: { site: string } }>('/v1/:site/collections', guard(searchScope, {}), async (request, reply) => {
    const site = sites.get(request.params.site);
    if (!site) return reply.code(404).send({ error: `unknown site "${request.params.site}"` });
    return { collections: await collections.browsable(site.id) };
  });

  app.get<{ Params: { site: string } }>(
    '/v1/:site/admin/collections',
    guard(merchScope, {}),
    async (request) => ({ collections: await collections.list(request.params.site) }),
  );

  /**
   * Count what a rule would catch, before it is saved. The visual builder calls
   * this on every edit, which is what makes a rule trustworthy enough to save.
   */
  app.post<{ Params: { site: string }; Body: { selector: Selector } }>(
    '/v1/:site/admin/collections/preview',
    guard(merchScope, { body: S.previewBody }),
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
    guard(merchScope, { body: S.collectionBody }),
    async (request, reply) => {
      const site = sites.get(request.params.site);
      if (!site) return reply.code(404).send({ error: `unknown site "${request.params.site}"` });
      try {
        // Read the prior state first. Without it the log records that something
        // changed but not what it was, which is the half that makes an undo
        // possible.
        const before = await collections.get(site.id, request.body.slug ?? '');
        const created = await collections.create(site.id, { ...request.body, author: actorOf(request) });
        await audit(db, site.id, actorOf(request), 'upsert', 'collection', created.slug,
          before, created);
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
  }>('/v1/:site/admin/collections/:slug/members', guard(merchScope, { body: S.membersBody }, S.SLUG_PARAM), async (request, reply) => {
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
    guard(merchScope, {}, S.SLUG_PARAM),
    async (request, reply) => {
      const before = await collections.get(request.params.site, request.params.slug);
      const removed = await collections.remove(request.params.site, request.params.slug);
      if (!removed) return reply.code(404).send({ error: 'no such collection' });
      await audit(db, request.params.site, actorOf(request), 'delete', 'collection',
        request.params.slug, before, null);
      search.invalidate(request.params.site);
      return { deleted: true, reindexRequired: true };
    },
  );

  app.get<{ Params: { site: string } }>(
    '/v1/:site/admin/attributes',
    guard(merchScope, {}),
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
    guard(merchScope, { body: S.attributeBody }),
    async (request, reply) => {
      const site = sites.get(request.params.site);
      if (!site) return reply.code(404).send({ error: `unknown site "${request.params.site}"` });
      try {
        const attributeNamed = async (key: string) =>
          (await collections.listAttributes(site.id)).find((a) => a.key === key) ?? null;
        const before = await attributeNamed(request.body.key);
        const created = await collections.createAttribute(site.id, {
          ...request.body, author: actorOf(request),
        });
        await audit(db, site.id, actorOf(request), 'upsert', 'attribute', created.key,
          before, await attributeNamed(created.key));
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
  }>('/v1/:site/admin/attributes/:key/assign', guard(merchScope, { body: S.assignBody }, S.KEY_PARAM), async (request, reply) => {
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
    guard(merchScope, {}, S.KEY_PARAM),
    async (request, reply) => {
      const before = (await collections.listAttributes(request.params.site))
        .find((a) => a.key === request.params.key) ?? null;
      const removed = await collections.removeAttribute(request.params.site, request.params.key);
      if (!removed) return reply.code(404).send({ error: 'no such attribute' });
      await audit(db, request.params.site, actorOf(request), 'delete', 'attribute',
        request.params.key, before, null);
      search.invalidate(request.params.site);
      return { deleted: true, reindexRequired: true };
    },
  );

  // ---- synonyms ----------------------------------------------------------

  // ---- history -------------------------------------------------------------

  app.get<{ Params: { site: string }; Querystring: { limit?: string } }>(
    '/v1/:site/history',
    guard(analystScope, { querystring: S.reportQuery }),
    async (request) => ({
      entries: await history.list(request.params.site, Number(request.query.limit ?? 100)),
    }),
  );

  app.post<{ Params: { site: string; id: string } }>(
    '/v1/:site/history/:id/revert',
    guard(merchScope, {}, S.ID_PARAM),
    async (request, reply) => {
      try {
        const result = await history.revert(
          request.params.site, Number(request.params.id), actorOf(request),
        );
        search.invalidate(request.params.site);
        return result;
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  app.get<{ Params: { site: string } }>('/v1/:site/synonyms', guard(merchScope, {}), async (request) => ({
    synonyms: await synonyms.list(request.params.site),
  }));

  app.post<{
    Params: { site: string };
    Body: { kind: SynonymKind; fromTerms?: string[]; terms: string[]; note?: string };
  }>('/v1/:site/synonyms', guard(merchScope, { body: S.synonymBody }), async (request, reply) => {
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
    guard(merchScope, {}, S.ID_PARAM),
    async (request, reply) => {
      const before = (await synonyms.list(request.params.site))
        .find((r) => String(r.id) === request.params.id) ?? null;
      const removed = await synonyms.remove(request.params.site, Number(request.params.id));
      if (!removed) return reply.code(404).send({ error: 'no such synonym' });
      await audit(db, request.params.site, actorOf(request), 'delete', 'synonym',
        request.params.id, before, null);
      search.invalidate(request.params.site);
      return { deleted: true };
    },
  );

  // ---- redirects ---------------------------------------------------------

  app.get<{ Params: { site: string } }>('/v1/:site/redirects', guard(merchScope, {}), async (request) => ({
    redirects: await redirects.list(request.params.site),
  }));

  app.post<{
    Params: { site: string };
    Body: { pattern: string; matchType: MatchType; url: string; label?: string; priority?: number };
  }>('/v1/:site/redirects', guard(merchScope, { body: S.redirectBody }), async (request, reply) => {
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
    guard(merchScope, {}, S.ID_PARAM),
    async (request, reply) => {
      const before = (await redirects.list(request.params.site))
        .find((r) => String(r.id) === request.params.id) ?? null;
      const removed = await redirects.remove(request.params.site, Number(request.params.id));
      if (!removed) return reply.code(404).send({ error: 'no such redirect' });
      await audit(db, request.params.site, actorOf(request), 'delete', 'redirect',
        request.params.id, before, null);
      search.invalidate(request.params.site);
      return { deleted: true };
    },
  );

  app.post<{ Params: { site: string }; Body: EventBatch }>(
    '/v1/:site/events',
    guard(searchScope, { body: S.eventsBody }),
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
  }>('/v1/:site/catalog/batch', guard(adminScope, { body: S.catalogIngestBody }), async (request, reply) => {
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
  }>('/v1/:site/catalog/updates', guard(adminScope, { body: S.catalogUpdatesBody }), async (request, reply) => {
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
  }>('/v1/:site/catalog/records', guard(adminScope, { body: S.catalogIngestBody }), async (request, reply) => {
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
    guard(adminScope, { body: S.deleteRecordsBody }),
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

  app.get<{ Params: { site: string } }>('/v1/:site/catalog/status', guard(analystScope, {}), async (request, reply) => {
    const site = sites.get(request.params.site);
    if (!site) return reply.code(404).send({ error: `unknown site "${request.params.site}"` });
    const { rows } = await db.query(
      `SELECT index_name, source, products, variants, duration_ms, quality, status, error, started_at
       FROM ingest_runs WHERE site_id = $1 ORDER BY started_at DESC LIMIT 10`,
      [site.id],
    );
    return { site: site.id, documents: await engine.documentCount(site.id), runs: rows };
  });

  /**
   * Who made an admin change.
   *
   * The header is a display name for the audit trail, not an identity claim —
   * authority comes from the key's role, which the guard has already checked.
   */
  function actorOf(request: { headers: Record<string, unknown> }): string {
    const header = request.headers['x-compass-actor'];
    return (Array.isArray(header) ? header[0] : (header as string)) || 'api';
  }

  app.setErrorHandler(async (error: unknown, request, reply) => {
    if (error instanceof SiteNotFoundError) {
      return reply.code(404).send({ error: error.message });
    }
    const err = error as {
      message?: string;
      statusCode?: number;
      validation?: { instancePath?: string; message?: string; params?: unknown }[];
      validationContext?: string;
    };

    // A schema failure is the caller's to fix, so say precisely what is wrong
    // and where — every problem at once, rather than one per round trip.
    if (err.validation) {
      const where = err.validationContext ?? 'request';
      const details = err.validation.map((v) => ({
        path: `${where}${v.instancePath ?? ''}`,
        message: v.message ?? 'is invalid',
      }));
      return reply.code(400).send({
        error: `invalid ${where}: ${details.map((d) => `${d.path} ${d.message}`).join('; ')}`,
        details,
      });
    }

    const status = err.statusCode ?? 500;
    const message = err.message ?? 'internal error';
    if (status >= 500) {
      // The detail goes to the log, not to the caller. An internal message is
      // no use to a client and can describe the shape of the code that failed.
      request.log.error({ err: message, url: request.url }, 'request failed');
      return reply.code(status).send({ error: 'internal error' });
    }
    request.log.warn({ err: message, url: request.url }, 'request rejected');
    return reply.code(status).send({ error: message });
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
