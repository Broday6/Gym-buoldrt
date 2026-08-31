-- Query merchandising.
--
-- Everything merchandisable so far bound to a *product set*: a collection is a
-- rule over the catalogue. This binds to a *query* — "when someone searches
-- beams, these three go first" — which is the half the console was missing and
-- the one §9 asks for.
--
-- Separate tables for the trigger and its consequences because one rule has
-- many: a term is typically pinned, buried and hidden all at once, and folding
-- them into a JSON column would make "which rules touch this product?"
-- unanswerable.
CREATE TABLE IF NOT EXISTS query_rules (
  id            BIGSERIAL PRIMARY KEY,
  site_id       TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  -- The text a shopper types. Stored normalised so "Beams" and " beams "
  -- resolve to the same rule.
  query         TEXT NOT NULL,
  match_type    TEXT NOT NULL DEFAULT 'exact' CHECK (match_type IN ('exact', 'phrase', 'contains')),
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  -- A campaign runs for a weekend and stops on its own.
  starts_at     TIMESTAMPTZ,
  ends_at       TIMESTAMPTZ,
  -- Ordering when several rules match the same query; higher wins.
  priority      INTEGER NOT NULL DEFAULT 100,
  note          TEXT,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, query, match_type)
);
CREATE INDEX IF NOT EXISTS query_rules_site_idx ON query_rules (site_id) WHERE enabled;

CREATE TABLE IF NOT EXISTS query_rule_actions (
  rule_id       BIGINT NOT NULL REFERENCES query_rules(id) ON DELETE CASCADE,
  parent_id     TEXT NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('pin', 'bury', 'hide')),
  -- 1-based slot, for pins only. Null for bury and hide, which have no slot.
  position      INTEGER,
  PRIMARY KEY (rule_id, parent_id)
);
