-- What the engine actually showed.
--
-- Click-through needs a denominator, and until now there was none: the rollup
-- filled daily_product_stats.impressions with a literal 0, so every rate the
-- system could compute was 0/0. Clicks were being recorded and thrown away.
--
-- Recorded server-side, at the moment results are served, rather than by the
-- storefront. Three reasons: the server already knows exactly what it
-- returned; a client-side impression beacon is the first thing an ad blocker
-- stops, which would bias the denominator toward whoever does not run one; and
-- one row per product per day is a rounding error next to one event per
-- rendered card.
--
-- "Impression" here means served in a result page, not seen. That is the
-- denominator ranking wants: given that we put this product in front of
-- someone, did they take it.
CREATE TABLE IF NOT EXISTS daily_impressions (
  site_id       TEXT NOT NULL,
  day           DATE NOT NULL,
  sku           TEXT NOT NULL,
  impressions   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, day, sku)
);

CREATE INDEX IF NOT EXISTS daily_impressions_day_idx ON daily_impressions (site_id, day DESC);

-- Proposals somebody has already said no to.
--
-- Proposals are derived from behaviour on every read rather than stored, so
-- they come back every time the evidence still holds. Without a record of a
-- refusal the same rejected suggestion would be offered forever, and a list
-- that cannot be cleared stops being read.
CREATE TABLE IF NOT EXISTS autopilot_dismissals (
  site_id       TEXT NOT NULL,
  proposal_id   TEXT NOT NULL,
  actor         TEXT NOT NULL,
  dismissed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, proposal_id)
);
