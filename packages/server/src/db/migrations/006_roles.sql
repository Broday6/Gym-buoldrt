-- Admin roles.
--
-- The spec calls for Admin, Merchandiser and Analyst. Until now there were two
-- values and any admin key could do anything — tolerable while the only admin
-- surface was the API, blocking once a console existed.
--
-- The column keeps its name and its original two values keep their meaning, so
-- every key issued before this migration keeps working with exactly the access
-- it had.
ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_scope_check;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_scope_check
  CHECK (scope IN ('search', 'analyst', 'merchandiser', 'admin'));

-- Who last used a key, so an operator rotating credentials can tell which ones
-- are still in service and which are safe to revoke.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

-- A rotation supersedes rather than deletes: the old key stays revokable and
-- the chain of what replaced what is auditable.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS replaced_by BIGINT REFERENCES api_keys(id);
