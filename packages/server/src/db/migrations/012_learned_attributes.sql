-- What the last ingest inferred, so a merchandiser can check its work.
--
-- Recovering an attribute from a product's own text is the difference between
-- half a catalogue being filterable and all of it, but it is still the system
-- writing product data the source did not send. Kept beside the data-quality
-- report rather than folded into it: quality records what the feed got wrong,
-- this records what we did about it, and conflating the two would make it
-- impossible to tell a clean feed from a heavily repaired one.
ALTER TABLE ingest_runs ADD COLUMN IF NOT EXISTS learned jsonb;
