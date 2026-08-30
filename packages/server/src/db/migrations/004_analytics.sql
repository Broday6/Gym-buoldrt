-- Analytics aggregation support.
--
-- Events are append-only and get large fast; the dashboard reads aggregates.
-- Rollups are idempotent per (site, day) so a re-run repairs rather than
-- double-counts, which matters because the first thing anyone does after a
-- reporting bug is re-run the job.

ALTER TABLE daily_query_stats ADD COLUMN IF NOT EXISTS sessions INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_query_stats ADD COLUMN IF NOT EXISTS rescued INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_product_stats ADD COLUMN IF NOT EXISTS avg_click_position NUMERIC(6,2);

-- Which facet values shoppers actually use, so a merchandiser can retire the
-- ones nobody touches and promote the ones they do.
CREATE TABLE IF NOT EXISTS daily_facet_stats (
  site_id       TEXT NOT NULL,
  day           DATE NOT NULL,
  field         TEXT NOT NULL,
  value         TEXT NOT NULL,
  applications  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, day, field, value)
);

-- Records which days have been rolled up, so the job knows where to resume.
CREATE TABLE IF NOT EXISTS rollup_runs (
  site_id       TEXT NOT NULL,
  day           DATE NOT NULL,
  events_seen   INTEGER NOT NULL DEFAULT 0,
  ran_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, day)
);

-- `occurred_at::date` is not immutable (it depends on the session time zone),
-- so the rollup ranges on the timestamp itself and uses this index.
CREATE INDEX IF NOT EXISTS events_site_occurred_idx ON events (site_id, occurred_at);
CREATE INDEX IF NOT EXISTS daily_query_stats_day_idx ON daily_query_stats (site_id, day DESC);
