-- Scheduled job leases.
--
-- The analytics rollup and the index rebuild existed as commands nothing ran,
-- so the dashboard went stale a day after anyone last ran one by hand. They now
-- run inside the API process — which means several instances behind a load
-- balancer would each try to run them.
--
-- The primary key is the whole mechanism: claiming a slot is an insert that
-- either wins or conflicts, so exactly one instance runs a job per day. There
-- is no lock to leak and nothing to clean up if an instance dies mid-run.
CREATE TABLE IF NOT EXISTS scheduled_runs (
  job           TEXT NOT NULL,
  site_id       TEXT NOT NULL,
  day           DATE NOT NULL,
  claimed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (job, site_id, day)
);
