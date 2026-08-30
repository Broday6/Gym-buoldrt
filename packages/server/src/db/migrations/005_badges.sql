-- Product badges: "New", "Best Seller", "Only 3 left", "25% off".
--
-- Badges are the cheapest merchandising lever there is — they change what a
-- shopper notices without changing what ranks — and every competitor ships
-- them. They reuse the same selector language as collections, so a merchandiser
-- who can write one can write the other.

CREATE TABLE IF NOT EXISTS badges (
  id            BIGSERIAL PRIMARY KEY,
  site_id       TEXT NOT NULL,
  key           TEXT NOT NULL,
  label         TEXT NOT NULL,
  -- Presentation only; the storefront maps these to its own styling.
  tone          TEXT NOT NULL DEFAULT 'neutral'
                CHECK (tone IN ('neutral', 'sale', 'new', 'scarcity', 'praise')),
  selector      JSONB,
  -- Lower wins when several badges match; a card shows at most `maxPerCard`.
  priority      INTEGER NOT NULL DEFAULT 100,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  starts_at     TIMESTAMPTZ,
  ends_at       TIMESTAMPTZ,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, key)
);
CREATE INDEX IF NOT EXISTS badges_site_idx ON badges (site_id, priority) WHERE enabled;
