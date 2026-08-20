-- ================================================================
-- BATCH RUNS -- long operations that cannot be one HTTP request
--
-- Committing a fleet-wide auto-schedule for a 10,000-piece backlog is roughly
-- 100,000 sequential statements: every placement goes through the guarded
-- schedule(), which is ten-odd queries of preconditions and resource-conflict
-- checks, and that guard is the thing that must not be skipped. Even at a
-- millisecond each that is minutes of work, and production reaches this API
-- through the Cloudflare Pages proxy, which will not hold a request open that
-- long. There is no request-shaped answer to this.
--
-- So the request STARTS a run and returns its id; the work continues in the
-- API process and reports into this table; the client polls. That also buys the
-- two things the operator actually needs on an action of this size: a count
-- that moves, and a way to stop it.
--
-- WHAT THIS IS NOT: a job queue. There is no worker pool, no retry, no
-- cross-process dispatch. The row is a progress record for work running in the
-- process that created it. If that process restarts mid-run the row is swept to
-- 'failed' on the next boot (see RunsService), because a run that stopped
-- silently is the one outcome worse than a run that failed loudly -- the
-- placements it already committed are real and the operator has to know the
-- rest are not coming.
--
-- FAILING OPEN: the service probes for this table and falls back to running
-- synchronously when it is absent. An un-applied migration must not take
-- auto-schedule down; it should only cost the progress bar.
-- ================================================================

CREATE TABLE IF NOT EXISTS public.batch_runs (
  run_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES public.companies(company_id) ON DELETE CASCADE,
  -- What kind of work this is. Kept as text rather than an enum so adding a
  -- second kind (a bulk assign, an import) is a code change, not a migration.
  kind              text NOT NULL,
  status            text NOT NULL DEFAULT 'running',

  -- Progress. `total` is 0 until the executor has worked out the size of the
  -- job, which for a pack means after the candidates are loaded and ordered.
  total             integer NOT NULL DEFAULT 0,
  processed         integer NOT NULL DEFAULT 0,
  succeeded         integer NOT NULL DEFAULT 0,
  failed            integer NOT NULL DEFAULT 0,

  -- Set by the cancel endpoint; read by the executor between items. Cancelling
  -- STOPS a run, it does not undo one: everything already committed stays
  -- committed, which is why the counts above have to survive the cancel.
  cancel_requested  boolean NOT NULL DEFAULT false,

  input             jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The finished plan, in the same shape the synchronous route returns, so the
  -- client renders one thing either way.
  result            jsonb,
  error             text,

  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- Bumped on every progress write. A 'running' row whose heartbeat is old is
  -- a run whose process died.
  heartbeat_at      timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,

  CONSTRAINT chk_batch_runs_status
    CHECK (status IN ('running', 'done', 'failed', 'cancelled')),
  CONSTRAINT chk_batch_runs_counts
    CHECK (processed >= 0 AND succeeded >= 0 AND failed >= 0 AND total >= 0),
  -- A finished run has an end time; a running one does not. Keeps "is it still
  -- going?" answerable from the row alone.
  CONSTRAINT chk_batch_runs_finished
    CHECK ((status = 'running') = (finished_at IS NULL))
);

-- The only read pattern: this tenant's runs, newest first (the poll fetches one
-- by id, which the primary key already serves).
CREATE INDEX IF NOT EXISTS idx_batch_runs_company_created
  ON public.batch_runs (company_id, created_at DESC);

-- The startup sweep looks for exactly this: rows still marked running.
-- Partial, so it stays tiny -- finished runs are the overwhelming majority.
CREATE INDEX IF NOT EXISTS idx_batch_runs_running
  ON public.batch_runs (heartbeat_at)
  WHERE status = 'running';
