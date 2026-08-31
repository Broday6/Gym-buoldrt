/**
 * OpenAPI, generated from the routes themselves.
 *
 * §4.13 asks for a spec "kept current", and the only spec that stays current is
 * one nobody has to remember to update. This walks Fastify's own route table at
 * boot — the same schemas the server validates against, the same role guards it
 * enforces — so the document cannot describe an API the server does not have.
 *
 * Prose lives here rather than in the route registrations: one place to read
 * what the API offers, and route files that stay about behaviour. A route with
 * no entry in DOCS is a test failure, in both directions — add an endpoint and
 * the suite tells you to describe it; delete one and it tells you to stop
 * describing it.
 */
import type { FastifyInstance, FastifySchema } from 'fastify';
import type { KeyScope } from './auth.js';

export interface RouteRecord {
  method: string;
  url: string;
  schema?: FastifySchema;
  role?: KeyScope;
}

/** Summary and tag per endpoint, keyed by "METHOD /path". */
const DOCS: Record<string, { tag: string; summary: string }> = {
  'GET /health': { tag: 'Operations', summary: 'Liveness, dependency checks and cache statistics' },
  'GET /health/ready': { tag: 'Operations', summary: 'Readiness for a load balancer; 503 until documents are indexed' },
  'GET /metrics': { tag: 'Operations', summary: 'Per-route request counts, error counts and latency percentiles' },
  'GET /openapi.json': { tag: 'Operations', summary: 'This document' },
  'GET /v1/sites': { tag: 'Discovery', summary: 'Configured sites and the sort options they expose' },
  'GET /v1/:site/whoami': { tag: 'Discovery', summary: 'The role this API key holds, and what it may do' },

  'POST /v1/:site/search': { tag: 'Search', summary: 'Full-text search with facets, ranked by the tie-breaking cascade' },
  'POST /v1/:site/browse': { tag: 'Search', summary: 'Category or collection browse; the same pipeline without a query' },
  'POST /v1/:site/autocomplete': { tag: 'Search', summary: 'Suggestions, products, categories and brands for a prefix' },
  'GET /v1/:site/directory': { tag: 'Search', summary: 'Category tree and published collections, for navigation' },
  'GET /v1/:site/collections': { tag: 'Search', summary: 'Published collections a shopper may browse' },
  'GET /v1/:site/sitemap.xml': { tag: 'Search', summary: 'Landing pages worth ranking; filter permutations are deliberately absent' },
  'POST /v1/:site/recommend': { tag: 'Search', summary: 'A recommendation rail; degrades to top sellers rather than returning nothing' },
  'POST /v1/:site/events': { tag: 'Search', summary: 'Record shopper events: clicks, views, carts, purchases' },

  'GET /v1/:site/analytics/overview': { tag: 'Analytics', summary: 'Headline metrics for a window: volume, quality, engagement, revenue' },
  'GET /v1/:site/analytics/queries': { tag: 'Analytics', summary: 'Top queries by volume, with click-through and revenue' },
  'GET /v1/:site/analytics/problems': { tag: 'Analytics', summary: 'Queries that failed or went unclicked — the merchandising to-do list' },
  'GET /v1/:site/analytics/trending': { tag: 'Analytics', summary: 'Queries rising fastest against the previous window' },
  'GET /v1/:site/analytics/facets': { tag: 'Analytics', summary: 'Which filters shoppers actually use' },
  'GET /v1/:site/analytics/timeseries': { tag: 'Analytics', summary: 'Daily series for the dashboard chart' },
  'GET /v1/:site/analytics/clicked': { tag: 'Analytics', summary: 'What shoppers clicked and bought for one query' },
  'POST /v1/:site/analytics/rollup': { tag: 'Analytics', summary: 'Recompute the daily aggregates for a window' },

  'GET /v1/:site/admin/collections': { tag: 'Merchandising', summary: 'Every collection, including disabled and scheduled ones' },
  'POST /v1/:site/admin/collections': { tag: 'Merchandising', summary: 'Create or update a collection from a rule' },
  'DELETE /v1/:site/admin/collections/:slug': { tag: 'Merchandising', summary: 'Delete a collection' },
  'POST /v1/:site/admin/collections/preview': { tag: 'Merchandising', summary: 'Count and sample what a rule would match, before saving it' },
  'POST /v1/:site/admin/collections/:slug/members': { tag: 'Merchandising', summary: 'Pin and order hand-picked products within a collection' },
  'GET /v1/:site/admin/attributes': { tag: 'Merchandising', summary: 'Merchandiser-defined filters and their values' },
  'POST /v1/:site/admin/attributes': { tag: 'Merchandising', summary: 'Create or update a custom attribute and its rule-driven values' },
  'DELETE /v1/:site/admin/attributes/:key': { tag: 'Merchandising', summary: 'Delete a custom attribute' },
  'POST /v1/:site/admin/attributes/:key/assign': { tag: 'Merchandising', summary: 'Hand-assign products to a custom attribute value' },
  'GET /v1/:site/admin/badges': { tag: 'Merchandising', summary: 'Every badge definition' },
  'POST /v1/:site/admin/badges': { tag: 'Merchandising', summary: 'Create or update a badge and the rule that places it' },
  'DELETE /v1/:site/admin/badges/:key': { tag: 'Merchandising', summary: 'Delete a badge' },
  'GET /v1/:site/history': { tag: 'Merchandising', summary: 'Who changed what, when, and what it was before' },
  'POST /v1/:site/history/:id/revert': { tag: 'Merchandising', summary: 'Undo one change; recorded as a change of its own' },
  'GET /v1/:site/synonyms': { tag: 'Vocabulary', summary: 'Synonym rules' },
  'POST /v1/:site/synonyms': { tag: 'Vocabulary', summary: 'Create a one-way or two-way synonym' },
  'DELETE /v1/:site/synonyms/:id': { tag: 'Vocabulary', summary: 'Delete a synonym' },
  'GET /v1/:site/redirects': { tag: 'Vocabulary', summary: 'Query redirects' },
  'POST /v1/:site/redirects': { tag: 'Vocabulary', summary: 'Create a query redirect' },
  'DELETE /v1/:site/redirects/:id': { tag: 'Vocabulary', summary: 'Delete a redirect' },

  'POST /v1/:site/catalog/batch': { tag: 'Catalog', summary: 'Full reindex from rows or CSV, into a new index promoted on success' },
  'POST /v1/:site/catalog/updates': { tag: 'Catalog', summary: 'Price and inventory deltas against the live index' },
  'POST /v1/:site/catalog/records': { tag: 'Catalog', summary: 'Add or replace individual products without a full reindex' },
  'DELETE /v1/:site/catalog/records': { tag: 'Catalog', summary: 'Remove products from the live index' },
  'GET /v1/:site/catalog/status': { tag: 'Catalog', summary: 'Document counts, last ingest run and its data-quality report' },
};

const TAG_DESCRIPTIONS: Record<string, string> = {
  Operations: 'Health, metrics and this document. No authentication.',
  Discovery: 'What exists, and what this key may do with it.',
  Search: 'The shopper-facing API. A search-scoped key is safe to ship in a storefront bundle.',
  Analytics: 'Reports over recorded shopper behaviour.',
  Merchandising: 'Collections, custom attributes and badges — all driven by the same rule language.',
  Vocabulary: 'Synonyms and redirects: teaching the engine what shoppers call things.',
  Catalog: 'Ingest. These endpoints change what is searchable.',
};

/** Endpoints that take no key at all. */
const PUBLIC = new Set(['GET /health', 'GET /health/ready', 'GET /metrics',
  'GET /v1/sites', 'GET /openapi.json']);

export const routeKey = (method: string, url: string) => `${method} ${url}`;

/** Which routes are documented but not registered, and vice versa. */
export function reconcile(routes: RouteRecord[]): { undocumented: string[]; stale: string[] } {
  const live = new Set(routes.map((r) => routeKey(r.method, r.url)));
  return {
    undocumented: [...live].filter((k) => !DOCS[k]).sort(),
    stale: Object.keys(DOCS).filter((k) => !live.has(k)).sort(),
  };
}

/**
 * Record every route as Fastify registers it.
 *
 * HEAD and OPTIONS are Fastify's own additions, and the static file mounts are
 * assets rather than API — neither belongs in an API description.
 */
export function trackRoutes(app: FastifyInstance): RouteRecord[] {
  const routes: RouteRecord[] = [];
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      if (route.url.includes('*') || route.url.startsWith('/demo/') || route.url.startsWith('/admin/')) continue;
      routes.push({
        method,
        url: route.url,
        schema: route.schema,
        role: (route.config as { role?: KeyScope } | undefined)?.role,
      });
    }
  });
  return routes;
}

const ERROR_SCHEMA = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    details: {
      type: 'array',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, message: { type: 'string' } },
      },
    },
  },
} as const;

/** Fastify path params are `:site`; OpenAPI wants `{site}`. */
const toOpenApiPath = (url: string) => url.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

/**
 * Fastify resolves shared schemas by `$id`; OpenAPI resolves them by JSON
 * pointer into `components.schemas`. Same definitions, different addressing —
 * so the ids are rewritten on the way out rather than duplicated at the source.
 */
function derefIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(derefIds);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) =>
      k === '$ref' && typeof v === 'string' && v.startsWith('compass.')
        ? [k, `#/components/schemas/${v.slice('compass.'.length)}`]
        : [k, derefIds(v)]));
  }
  return value;
}

export function buildSpec(routes: RouteRecord[], version: string, shared: { $id: string }[] = []): object {
  const paths: Record<string, Record<string, unknown>> = {};
  const usedTags = new Set<string>();

  for (const route of routes.slice().sort((a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method))) {
    const key = routeKey(route.method, route.url);
    const doc = DOCS[key];
    if (!doc) continue;
    usedTags.add(doc.tag);

    const schema = (route.schema ?? {}) as {
      body?: object;
      params?: { properties?: Record<string, object>; required?: string[] };
      querystring?: { properties?: Record<string, object>; required?: string[] };
    };

    const parameters = [
      ...Object.entries(schema.params?.properties ?? {}).map(([name, s]) => ({
        name, in: 'path', required: true, schema: s,
      })),
      ...Object.entries(schema.querystring?.properties ?? {}).map(([name, s]) => ({
        name, in: 'query',
        required: (schema.querystring?.required ?? []).includes(name),
        schema: s,
      })),
    ];

    const isPublic = PUBLIC.has(key);
    const operation: Record<string, unknown> = {
      tags: [doc.tag],
      summary: doc.summary,
      operationId: `${route.method.toLowerCase()}${toOpenApiPath(route.url)
        .replace(/[^A-Za-z0-9]+(.)/g, (_, c: string) => c.toUpperCase())
        .replace(/[^A-Za-z0-9]/g, '')}`,
      ...(parameters.length ? { parameters } : {}),
      ...(schema.body
        ? { requestBody: { required: true, content: { 'application/json': { schema: schema.body } } } }
        : {}),
      responses: {
        '200': { description: 'Success' },
        ...(schema.body
          ? { '400': { description: 'The request did not satisfy the schema; `details` names each problem', content: { 'application/json': { schema: ERROR_SCHEMA } } } }
          : {}),
        ...(isPublic ? {} : {
          '401': { description: 'Missing or invalid API key', content: { 'application/json': { schema: ERROR_SCHEMA } } },
          '403': { description: `Key role is below "${route.role ?? 'search'}", or the key belongs to another site`, content: { 'application/json': { schema: ERROR_SCHEMA } } },
        }),
        '429': { description: 'Rate limited; retry after the `Retry-After` header' },
      },
      ...(isPublic
        ? { security: [] }
        : {
            security: [{ apiKey: [] }],
            'x-required-role': route.role ?? 'search',
          }),
    };

    const path = toOpenApiPath(route.url);
    paths[path] ??= {};
    paths[path]![route.method.toLowerCase()] = operation;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Compass Search',
      version,
      description:
        'Self-hosted e-commerce search, merchandising and product discovery.\n\n' +
        'Authentication is a single `x-compass-key` header. Keys carry one of four ' +
        'ordered roles — search, analyst, merchandiser, admin — and each endpoint ' +
        'names the least role that may call it in `x-required-role`. A `ck_search_…` ' +
        'key is designed to ship inside a storefront bundle; every other role must ' +
        'stay server-side.\n\n' +
        'This document is generated from the running server\'s route table and ' +
        'validation schemas, so it cannot describe an API the server does not have.',
    },
    tags: [...usedTags].sort().map((name) => ({ name, description: TAG_DESCRIPTIONS[name] ?? '' })),
    components: {
      securitySchemes: {
        apiKey: { type: 'apiKey', in: 'header', name: 'x-compass-key' },
      },
      schemas: Object.fromEntries(shared.map((schema) => {
        const { $id, ...rest } = schema as { $id: string } & Record<string, unknown>;
        return [$id.slice('compass.'.length), derefIds(rest)];
      })),
    },
    security: [{ apiKey: [] }],
    paths: derefIds(paths) as object,
  };
}
