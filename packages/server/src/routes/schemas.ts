/**
 * Request schemas.
 *
 * Until now every handler read `request.body` through a TypeScript type, which
 * is a compile-time claim about a value that arrives at runtime from the
 * internet. The consequences were real: `{"q": 123}` returned a 500 carrying an
 * internal error message, and `{"hitsPerPage": 99999}` was accepted and did the
 * work.
 *
 * These schemas are the runtime half of that contract. Fastify compiles them
 * once at registration and rejects a bad request before the handler runs, so a
 * malformed body is a 400 that says what is wrong rather than a 500 that says
 * something the caller cannot act on.
 *
 * Three rules they follow throughout:
 *
 *   - **Bound anything that costs work.** Page size, page number, batch size
 *     and result limits all have ceilings, because an unbounded number here is
 *     an unauthenticated way to make the server do arbitrary work.
 *   - **Reject unknown properties on admin writes**, so a typo in a field name
 *     fails loudly instead of silently saving a record missing that field.
 *     Shopper-facing endpoints stay permissive: an older SDK sending a field a
 *     newer server dropped should keep working.
 *   - **Say what was wrong.** The error names the offending path.
 */
import type { FastifySchema } from 'fastify';

/**
 * Validator options, shared by the running server and the spec generator so
 * the document is produced under the same rules the server enforces.
 */
export const AJV_OPTIONS = {
  // Report every problem in one response. A caller fixing a request body should
  // not have to make N round trips to find N mistakes.
  allErrors: true,
  // Fastify's default strips unknown properties silently. For an admin write
  // that is the wrong failure: a misspelled field would save a record quietly
  // missing it. Schemas that care say additionalProperties:false and get a 400.
  removeAdditional: false,
  // Query strings and path segments are strings by construction, so the schemas
  // type them as strings and coercion buys nothing — while in a JSON body it
  // would quietly turn {"q": 123} into "123" rather than telling the caller
  // their client is wrong.
  coerceTypes: false,
  // A facet value is legitimately a string or a number.
  allowUnionTypes: true,
} as const;

/** Every route under /v1/:site takes the same site parameter. */
const siteParams = {
  type: 'object',
  required: ['site'],
  properties: { site: { type: 'string', minLength: 1, maxLength: 64 } },
} as const;

/** OR within a group, AND across groups: `{ material: ['PVC', 'MDF'] }`. */
const facetFilters = {
  type: 'object',
  maxProperties: 40,
  additionalProperties: {
    type: 'array',
    maxItems: 200,
    items: { type: ['string', 'number'], maxLength: 200 },
  },
} as const;

const labelFilters = {
  type: 'object',
  maxProperties: 40,
  additionalProperties: {
    type: 'array', maxItems: 200, items: { type: 'string', maxLength: 200 },
  },
} as const;

const stringArray = (maxItems: number, maxLength = 200) => ({
  type: 'array', maxItems, items: { type: 'string', maxLength },
}) as const;

/**
 * Shopper query. Deliberately not `additionalProperties: false` — a storefront
 * bundle outlives the server it was built against, and rejecting a field an
 * older SDK still sends would break the page rather than the request.
 */
export const searchBody = {
  type: 'object',
  properties: {
    q: { type: 'string', maxLength: 512 },
    categoryId: { type: 'string', maxLength: 256 },
    collection: { type: 'string', maxLength: 128 },
    filters: facetFilters,
    labelFilters,
    ranges: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        required: ['field'],
        properties: {
          field: { type: 'string', maxLength: 64 },
          min: { type: 'number' },
          max: { type: 'number' },
        },
      },
    },
    sort: { type: 'string', maxLength: 64 },
    // Bounded because both cost work: a page beyond the ranking window returns
    // nothing anyway, and a large page size is an unauthenticated way to ask
    // the server for arbitrary effort.
    page: { type: 'integer', minimum: 1, maximum: 500 },
    hitsPerPage: { type: 'integer', minimum: 1, maximum: 250 },
    facets: stringArray(40, 64),
    analyticsTags: stringArray(20, 64),
    shopperId: { type: 'string', maxLength: 128 },
    sessionId: { type: 'string', maxLength: 128 },
    explain: { type: 'boolean' },
    rescue: { type: 'boolean' },
    seo: { type: 'boolean' },
  },
} as const;

export const autocompleteBody = {
  type: 'object',
  properties: {
    q: { type: 'string', maxLength: 256 },
    limit: { type: 'integer', minimum: 1, maximum: 25 },
    shopperId: { type: 'string', maxLength: 128 },
    sessionId: { type: 'string', maxLength: 128 },
  },
} as const;

export const recommendBody = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: ['similar', 'bought_together', 'recently_viewed', 'trending', 'top_sellers'],
    },
    sku: { type: 'string', maxLength: 128 },
    parentId: { type: 'string', maxLength: 128 },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
    shopperId: { type: 'string', maxLength: 128 },
    sessionId: { type: 'string', maxLength: 128 },
  },
} as const;

/**
 * Shopper events. The batch is capped: this endpoint takes a public key, and
 * an uncapped array is a way to fill the collector from a browser.
 */
export const eventsBody = {
  type: 'object',
  required: ['events'],
  properties: {
    events: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: {
        type: 'object',
        required: ['type'],
        properties: {
          type: {
            type: 'string',
            enum: ['search', 'zero_result', 'click', 'product_view', 'add_to_cart',
              'purchase', 'facet_apply'],
          },
          timestamp: { type: 'string', maxLength: 40 },
          query: { type: 'string', maxLength: 512 },
          sku: { type: 'string', maxLength: 128 },
          parentId: { type: 'string', maxLength: 128 },
          position: { type: 'integer', minimum: 0, maximum: 100000 },
          quantity: { type: 'integer', minimum: 0, maximum: 100000 },
          revenue: { type: 'number', minimum: 0 },
          resultCount: { type: 'integer', minimum: 0 },
          shopperId: { type: 'string', maxLength: 128 },
          sessionId: { type: 'string', maxLength: 128 },
          rescueStrategy: { type: 'string', maxLength: 64 },
          effectiveQuery: { type: 'string', maxLength: 512 },
          analyticsTags: stringArray(20, 64),
          filters: facetFilters,
        },
      },
    },
  },
} as const;

/**
 * A merchandising rule.
 *
 * Recursive by nature — a clause may nest — so the depth is capped rather than
 * left to the evaluator to discover. `$ref` against the schema's own `$id`
 * keeps one definition for all three groups.
 */
export const selectorSchema = {
  $id: 'compass.selector',
  type: 'object',
  properties: {
    all: { type: 'array', maxItems: 40, items: { $ref: 'compass.condition' } },
    any: { type: 'array', maxItems: 40, items: { $ref: 'compass.condition' } },
    none: { type: 'array', maxItems: 40, items: { $ref: 'compass.condition' } },
  },
} as const;

export const conditionSchema = {
  $id: 'compass.condition',
  type: 'object',
  required: ['field', 'op'],
  properties: {
    field: { type: 'string', minLength: 1, maxLength: 128 },
    op: {
      type: 'string',
      enum: ['equals', 'not_equals', 'contains', 'not_contains', 'starts_with',
        'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'exists', 'missing'],
    },
    value: {},
  },
} as const;

const nullableSelector = { anyOf: [{ $ref: 'compass.selector' }, { type: 'null' }] } as const;

/** Admin writes reject unknown properties: a typo must fail, not save a gap. */
export const collectionBody = {
  type: 'object',
  required: ['slug', 'name'],
  additionalProperties: false,
  properties: {
    slug: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[a-z0-9][a-z0-9-]*$' },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    description: { type: ['string', 'null'], maxLength: 2000 },
    selector: nullableSelector,
    sort: { type: ['string', 'null'], maxLength: 64 },
    enabled: { type: 'boolean' },
    startsAt: { type: ['string', 'null'], maxLength: 40 },
    endsAt: { type: ['string', 'null'], maxLength: 40 },
  },
} as const;

export const attributeBody = {
  type: 'object',
  required: ['key', 'label'],
  additionalProperties: false,
  properties: {
    key: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z0-9][a-z0-9_]*$' },
    label: { type: 'string', minLength: 1, maxLength: 200 },
    displayType: { type: 'string', enum: ['checkbox', 'slider', 'swatch', 'grid'] },
    position: { type: 'integer', minimum: 0, maximum: 1000 },
    enabled: { type: 'boolean' },
    values: {
      type: 'array',
      maxItems: 200,
      items: {
        type: 'object',
        required: ['value'],
        additionalProperties: false,
        properties: {
          value: { type: 'string', minLength: 1, maxLength: 200 },
          selector: nullableSelector,
          position: { type: 'integer', minimum: 0, maximum: 1000 },
        },
      },
    },
  },
} as const;

export const badgeBody = {
  type: 'object',
  required: ['key', 'label'],
  additionalProperties: false,
  properties: {
    key: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z0-9][a-z0-9_]*$' },
    label: { type: 'string', minLength: 1, maxLength: 60 },
    tone: { type: 'string', enum: ['neutral', 'sale', 'new', 'scarcity', 'praise'] },
    selector: nullableSelector,
    priority: { type: 'integer', minimum: 0, maximum: 10000 },
    enabled: { type: 'boolean' },
    startsAt: { type: ['string', 'null'], maxLength: 40 },
    endsAt: { type: ['string', 'null'], maxLength: 40 },
  },
} as const;

export const previewBody = {
  type: 'object',
  required: ['selector'],
  additionalProperties: false,
  properties: { selector: { $ref: 'compass.selector' } },
} as const;

export const synonymBody = {
  type: 'object',
  required: ['terms'],
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['two_way', 'one_way'] },
    terms: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 128 } },
    replacements: { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 128 } },
    enabled: { type: 'boolean' },
  },
} as const;

export const redirectBody = {
  type: 'object',
  required: ['pattern', 'url'],
  additionalProperties: false,
  properties: {
    pattern: { type: 'string', minLength: 1, maxLength: 256 },
    matchType: { type: 'string', enum: ['exact', 'contains', 'regex'] },
    url: { type: 'string', minLength: 1, maxLength: 2048 },
    enabled: { type: 'boolean' },
  },
} as const;

export const membersBody = {
  type: 'object',
  required: ['members'],
  additionalProperties: false,
  properties: {
    members: {
      type: 'array',
      maxItems: 500,
      items: {
        type: 'object',
        required: ['parentId'],
        additionalProperties: false,
        properties: {
          parentId: { type: 'string', minLength: 1, maxLength: 128 },
          position: { type: 'integer', minimum: 0, maximum: 100000 },
          pinned: { type: 'boolean' },
        },
      },
    },
  },
} as const;

export const assignBody = {
  type: 'object',
  required: ['value', 'parentIds'],
  additionalProperties: false,
  properties: {
    value: { type: 'string', minLength: 1, maxLength: 200 },
    parentIds: { type: 'array', maxItems: 5000, items: { type: 'string', maxLength: 128 } },
  },
} as const;

export const deleteRecordsBody = {
  type: 'object',
  required: ['skus'],
  additionalProperties: false,
  properties: {
    skus: { type: 'array', minItems: 1, maxItems: 10000, items: { type: 'string', maxLength: 128 } },
  },
} as const;

/**
 * Catalogue ingest.
 *
 * The envelope is validated and bounded; the rows inside are not, on purpose.
 * A source row is whatever the customer's NetSuite export produces, and
 * rejecting an unrecognised column would mean rejecting the feed the mapping
 * layer exists to interpret.
 */
export const catalogIngestBody = {
  type: 'object',
  properties: {
    rows: { type: 'array', maxItems: 200000, items: { type: 'object' } },
    csv: { type: 'string' },
    mapping: { type: 'object' },
    source: { type: 'string', maxLength: 128 },
  },
} as const;

export const catalogUpdatesBody = {
  type: 'object',
  required: ['updates'],
  properties: {
    updates: {
      type: 'array',
      minItems: 1,
      maxItems: 50000,
      items: {
        type: 'object',
        required: ['sku'],
        additionalProperties: false,
        properties: {
          sku: { type: 'string', minLength: 1, maxLength: 128 },
          price: { type: 'number', minimum: 0 },
          salePrice: { type: 'number', minimum: 0 },
          inventory: { type: 'integer', minimum: 0 },
        },
      },
    },
  },
} as const;

export const rollupBody = {
  type: 'object',
  additionalProperties: false,
  properties: { days: { type: 'integer', minimum: 1, maximum: 365 } },
} as const;

/** Reports share a window/limit/format triple. */
export const reportQuery = {
  type: 'object',
  properties: {
    days: { type: 'string', pattern: '^[0-9]{1,4}$' },
    limit: { type: 'string', pattern: '^[0-9]{1,4}$' },
    format: { type: 'string', enum: ['json', 'csv'] },
  },
} as const;

export const queryDetailQuery = {
  type: 'object',
  required: ['q'],
  properties: {
    q: { type: 'string', minLength: 1, maxLength: 512 },
    days: { type: 'string', pattern: '^[0-9]{1,4}$' },
  },
} as const;

const idish = { type: 'string', minLength: 1, maxLength: 128 } as const;

/** Path segments beyond :site, by the name each route gives them. */
export const KEY_PARAM = { key: idish };
export const SLUG_PARAM = { slug: idish };
export const ID_PARAM = { id: { type: 'string', pattern: '^[0-9]{1,19}$' } };

/** Attach the site parameter to every schema, so no route has to remember. */
export function forSite(
  schema: FastifySchema = {},
  extraParams: Record<string, unknown> = {},
): FastifySchema {
  return {
    ...schema,
    params: {
      ...siteParams,
      required: ['site', ...Object.keys(extraParams)],
      properties: { ...siteParams.properties, ...extraParams },
    },
  };
}

export const SHARED_SCHEMAS = [selectorSchema, conditionSchema];
