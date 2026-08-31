-- Merchandising a category, not only a search.
--
-- The visual merchandiser has always been able to preview a category — pick a
-- catcode, see the grid a shopper browsing it gets — but Save refused, because
-- a rule was keyed by the text somebody typed and a category page has none.
--
-- The consequence was worse than a missing feature: the screen let a
-- merchandiser drag products into the order they wanted and then told them it
-- could not keep any of it.
--
-- A rule now binds to either a query or a category. Everything else about it
-- is unchanged — the same pins, buries and hides, the same preview, the same
-- history and undo — because the only thing that ever differed was what makes
-- the rule fire.
ALTER TABLE query_rules ADD COLUMN IF NOT EXISTS category_id TEXT;
ALTER TABLE query_rules ALTER COLUMN query DROP NOT NULL;

-- One rule per category, mirroring the (query, match_type) uniqueness that
-- already stops two rules quietly fighting over the same trigger. Partial, so
-- the rows that carry a query are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS query_rules_category_idx
  ON query_rules (site_id, category_id) WHERE category_id IS NOT NULL;

-- A rule has to fire on something.
ALTER TABLE query_rules DROP CONSTRAINT IF EXISTS query_rules_trigger_present;
ALTER TABLE query_rules ADD CONSTRAINT query_rules_trigger_present
  CHECK (query IS NOT NULL OR category_id IS NOT NULL);
