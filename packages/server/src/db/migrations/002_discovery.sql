-- Phase 2: synonyms, redirects and rescue logging.

CREATE TABLE IF NOT EXISTS synonyms (
  id            BIGSERIAL PRIMARY KEY,
  site_id       TEXT NOT NULL,
  -- two_way: every term is interchangeable with every other.
  -- one_way:  each `from` term expands to the `to` terms, never the reverse.
  kind          TEXT NOT NULL CHECK (kind IN ('two_way', 'one_way')),
  -- two_way uses `terms`; one_way uses `from_terms` -> `terms`.
  from_terms    TEXT[] NOT NULL DEFAULT '{}',
  terms         TEXT[] NOT NULL,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  note          TEXT,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS synonyms_site_idx ON synonyms (site_id) WHERE enabled;

CREATE TABLE IF NOT EXISTS redirects (
  id            BIGSERIAL PRIMARY KEY,
  site_id       TEXT NOT NULL,
  pattern       TEXT NOT NULL,
  match_type    TEXT NOT NULL CHECK (match_type IN ('exact', 'contains', 'starts_with', 'regex')),
  url           TEXT NOT NULL,
  label         TEXT,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  -- Higher priority wins when several redirects match one query.
  priority      INTEGER NOT NULL DEFAULT 0,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS redirects_site_idx ON redirects (site_id, priority DESC) WHERE enabled;

-- Which rescue path saved a query that would otherwise have returned nothing.
ALTER TABLE events ADD COLUMN IF NOT EXISTS rescue_strategy TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS effective_query TEXT;
CREATE INDEX IF NOT EXISTS events_rescue_idx ON events (site_id, rescue_strategy)
  WHERE rescue_strategy IS NOT NULL;
