-- Measuring whether a merchandising change helped.
--
-- Every rule in this system — hand-made or proposed by the autopilot — has so
-- far been applied on faith. Nobody could say whether pinning three beams to
-- the top of "beam" sold more beams, because there was nothing to compare it
-- against. The columns to record which variant a shopper saw have been on the
-- events table since the first migration; nothing ever filled them.
--
-- The unit under test is a query rule, because that is the unit a merchandiser
-- creates. Control is the rule switched off, so the comparison is "this change
-- versus no change" rather than two speculative changes against each other.
CREATE TABLE IF NOT EXISTS experiments (
  id            BIGSERIAL PRIMARY KEY,
  site_id       TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  -- What the merchandiser expects to happen, in their words. Recorded before
  -- the result is known, which is the only time it can be recorded honestly.
  hypothesis    TEXT,
  -- The rule being tested. Deleting the rule ends the experiment with it:
  -- results about a rule that no longer exists cannot be acted on.
  rule_id       BIGINT NOT NULL REFERENCES query_rules(id) ON DELETE CASCADE,
  -- Share of sessions that see the rule, 1..99. Never 0 or 100: an experiment
  -- with no control measures nothing, and one with no exposure tests nothing.
  exposure      INTEGER NOT NULL DEFAULT 50 CHECK (exposure BETWEEN 1 AND 99),
  status        TEXT NOT NULL DEFAULT 'running'
                CHECK (status IN ('running', 'stopped', 'adopted', 'discarded')),
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at      TIMESTAMPTZ,
  -- Why it ended, so a stopped experiment is not a mystery six weeks later.
  outcome_note  TEXT,
  created_by    TEXT,
  UNIQUE (site_id, rule_id, started_at)
);

-- One running experiment per rule. Two would assign the same session to both
-- and neither result would mean anything.
CREATE UNIQUE INDEX IF NOT EXISTS experiments_one_running_per_rule
  ON experiments (rule_id) WHERE status = 'running';

CREATE INDEX IF NOT EXISTS experiments_site_idx ON experiments (site_id, status);

-- Which variant produced each event. Indexed together because every question
-- asked of this table is "for experiment X, per variant, how many".
CREATE INDEX IF NOT EXISTS events_ab_idx
  ON events (site_id, ab_test_id, ab_variant) WHERE ab_test_id IS NOT NULL;
