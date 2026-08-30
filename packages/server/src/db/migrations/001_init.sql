-- Compass Search: configuration + analytics store.
-- The retrieval index is disposable and rebuildable; this database is the
-- source of truth for everything a merchandiser creates.

CREATE TABLE IF NOT EXISTS sites (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id            BIGSERIAL PRIMARY KEY,
  site_id       TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  -- 'search' keys are safe to ship in a browser; 'admin' keys never are.
  scope         TEXT NOT NULL CHECK (scope IN ('search', 'admin')),
  key_hash      TEXT NOT NULL UNIQUE,
  label         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS api_keys_site_idx ON api_keys (site_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS ingest_runs (
  id            BIGSERIAL PRIMARY KEY,
  site_id       TEXT NOT NULL,
  index_name    TEXT NOT NULL,
  source        TEXT NOT NULL,
  products      INTEGER NOT NULL DEFAULT 0,
  variants      INTEGER NOT NULL DEFAULT 0,
  duration_ms   INTEGER NOT NULL DEFAULT 0,
  quality       JSONB NOT NULL DEFAULT '{}'::jsonb,
  mapping       JSONB NOT NULL DEFAULT '{}'::jsonb,
  status        TEXT NOT NULL DEFAULT 'ok',
  error         TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ingest_runs_site_idx ON ingest_runs (site_id, started_at DESC);

-- Append-only behavioural event log. Never updated, only aggregated.
CREATE TABLE IF NOT EXISTS events (
  id            BIGSERIAL PRIMARY KEY,
  site_id       TEXT NOT NULL,
  type          TEXT NOT NULL,
  shopper_id    TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  query         TEXT,
  normalised_query TEXT,
  position      INTEGER,
  sku           TEXT,
  parent_id     TEXT,
  category_id   TEXT,
  filters       JSONB,
  result_count  INTEGER,
  revenue       NUMERIC(12,2),
  quantity      INTEGER,
  analytics_tags TEXT[],
  ab_test_id    TEXT,
  ab_variant    TEXT
);
CREATE INDEX IF NOT EXISTS events_site_time_idx ON events (site_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS events_query_idx ON events (site_id, normalised_query) WHERE normalised_query IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_session_idx ON events (session_id, occurred_at);
CREATE INDEX IF NOT EXISTS events_type_idx ON events (site_id, type, occurred_at DESC);

-- Rolling aggregates. Phase 4 fills these; the columns exist from day one so
-- the event schema never has to change to support the dashboard.
CREATE TABLE IF NOT EXISTS daily_query_stats (
  site_id       TEXT NOT NULL,
  day           DATE NOT NULL,
  query         TEXT NOT NULL,
  searches      INTEGER NOT NULL DEFAULT 0,
  clicks        INTEGER NOT NULL DEFAULT 0,
  add_to_carts  INTEGER NOT NULL DEFAULT 0,
  purchases     INTEGER NOT NULL DEFAULT 0,
  revenue       NUMERIC(14,2) NOT NULL DEFAULT 0,
  zero_results  INTEGER NOT NULL DEFAULT 0,
  avg_results   NUMERIC(10,2),
  avg_click_position NUMERIC(6,2),
  PRIMARY KEY (site_id, day, query)
);

CREATE TABLE IF NOT EXISTS daily_product_stats (
  site_id       TEXT NOT NULL,
  day           DATE NOT NULL,
  sku           TEXT NOT NULL,
  impressions   INTEGER NOT NULL DEFAULT 0,
  clicks        INTEGER NOT NULL DEFAULT 0,
  add_to_carts  INTEGER NOT NULL DEFAULT 0,
  purchases     INTEGER NOT NULL DEFAULT 0,
  revenue       NUMERIC(14,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, day, sku)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id            BIGSERIAL PRIMARY KEY,
  site_id       TEXT,
  actor         TEXT NOT NULL,
  action        TEXT NOT NULL,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT,
  before        JSONB,
  after         JSONB,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_site_idx ON audit_log (site_id, occurred_at DESC);
