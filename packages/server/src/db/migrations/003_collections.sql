-- Merchandiser-defined structures that cut across the catalogue taxonomy.
--
-- A product's category comes from the catalogue feed and describes what it IS.
-- A collection describes what it is FOR — "Farmhouse Kitchen", "Contractor
-- Favourites", "Black Friday" — and routinely spans categories that have
-- nothing else in common. A custom attribute is the same idea one level down:
-- a facet the merchandiser invents and applies to products regardless of which
-- category, or which source system, they came from.
--
-- Both are stored here, never in the catalogue feed, because the feed is
-- overwritten on every ingest and this is merchandiser-authored work.

CREATE TABLE IF NOT EXISTS collections (
  id            BIGSERIAL PRIMARY KEY,
  site_id       TEXT NOT NULL,
  slug          TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  -- 'marketing' collections are shopper-facing (a landing page, a campaign);
  -- 'internal' ones exist only to be filtered on or targeted by a rule.
  kind          TEXT NOT NULL DEFAULT 'marketing' CHECK (kind IN ('marketing', 'internal')),
  -- Optional parent, so marketing structures can nest independently of the
  -- product taxonomy: "Seasonal > Autumn" need not mirror any category tree.
  parent_id     BIGINT REFERENCES collections(id) ON DELETE SET NULL,
  -- Dynamic membership: a selector evaluated against every product at ingest.
  -- NULL means the collection is purely manual.
  selector      JSONB,
  -- Presentation, for collection landing pages.
  banner        JSONB,
  seo_text      TEXT,
  default_sort  TEXT,
  facet_set     TEXT[],
  enabled       BOOLEAN NOT NULL DEFAULT true,
  -- Scheduling, so a seasonal structure can be built ahead of time.
  starts_at     TIMESTAMPTZ,
  ends_at       TIMESTAMPTZ,
  position      INTEGER NOT NULL DEFAULT 0,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, slug)
);
CREATE INDEX IF NOT EXISTS collections_site_idx ON collections (site_id) WHERE enabled;
CREATE INDEX IF NOT EXISTS collections_parent_idx ON collections (parent_id);

-- Manual membership, and manual exclusions from a dynamic selector. Both are
-- keyed by parent product id, because a shopper adds a product to a collection,
-- not a variant.
CREATE TABLE IF NOT EXISTS collection_members (
  collection_id BIGINT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  parent_id     TEXT NOT NULL,
  -- 'include' adds a product the selector missed; 'exclude' removes one it
  -- caught. Exclusions always win.
  mode          TEXT NOT NULL DEFAULT 'include' CHECK (mode IN ('include', 'exclude')),
  -- Curated order within the collection; NULL means "wherever ranking puts it".
  position      INTEGER,
  added_by      TEXT,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, parent_id)
);
CREATE INDEX IF NOT EXISTS collection_members_parent_idx ON collection_members (parent_id);

-- Merchandiser-defined facets. These behave exactly like catalogue attributes
-- once applied — filterable, facetable, countable — but their values are
-- authored here rather than arriving in the feed.
CREATE TABLE IF NOT EXISTS custom_attributes (
  id            BIGSERIAL PRIMARY KEY,
  site_id       TEXT NOT NULL,
  key           TEXT NOT NULL,
  label         TEXT NOT NULL,
  display_type  TEXT NOT NULL DEFAULT 'checkbox'
                CHECK (display_type IN ('checkbox', 'swatch', 'grid', 'slider')),
  description   TEXT,
  -- Facet presentation, mirroring the built-in facet config.
  position      INTEGER NOT NULL DEFAULT 100,
  collapsed     BOOLEAN NOT NULL DEFAULT false,
  truncate_at   INTEGER NOT NULL DEFAULT 8,
  sort_by       TEXT NOT NULL DEFAULT 'count' CHECK (sort_by IN ('count', 'alpha', 'custom')),
  custom_order  TEXT[],
  enabled       BOOLEAN NOT NULL DEFAULT true,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, key)
);

-- A value of a custom attribute, and the products it applies to. Membership is
-- either a selector (dynamic) or an explicit product list (manual), or both.
CREATE TABLE IF NOT EXISTS custom_attribute_values (
  id            BIGSERIAL PRIMARY KEY,
  attribute_id  BIGINT NOT NULL REFERENCES custom_attributes(id) ON DELETE CASCADE,
  value         TEXT NOT NULL,
  selector      JSONB,
  position      INTEGER NOT NULL DEFAULT 0,
  UNIQUE (attribute_id, value)
);

CREATE TABLE IF NOT EXISTS custom_attribute_assignments (
  value_id      BIGINT NOT NULL REFERENCES custom_attribute_values(id) ON DELETE CASCADE,
  parent_id     TEXT NOT NULL,
  mode          TEXT NOT NULL DEFAULT 'include' CHECK (mode IN ('include', 'exclude')),
  added_by      TEXT,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (value_id, parent_id)
);
CREATE INDEX IF NOT EXISTS custom_assignments_parent_idx ON custom_attribute_assignments (parent_id);
