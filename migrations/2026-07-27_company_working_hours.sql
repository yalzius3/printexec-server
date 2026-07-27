-- Company working hours: the shop's default window for auto-scheduling.
--
-- Constrains when a print may be STARTED, never when it may finish — a long
-- print running unattended past closing is normal, and gating the finish would
-- reject most overnight work.
--
-- NULL on either column means round the clock, which is exactly how the packer
-- behaved before this existed. So an un-migrated or un-configured company keeps
-- today's behaviour and nothing needs backfilling.
--
-- Hours are the SHOP's local clock. No timezone is stored: the client sends its
-- own UTC offset with each plan, so a shop that relocates or a server that moves
-- region can't silently reinterpret the window.

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS work_start_hour        SMALLINT,
  ADD COLUMN IF NOT EXISTS work_latest_start_hour SMALLINT;

-- Hours are 0–23 when set. Both-or-neither: half a window is meaningless, and
-- letting one side be null would leave the packer guessing the other.
ALTER TABLE companies
  DROP CONSTRAINT IF EXISTS companies_work_hours_range_chk;
ALTER TABLE companies
  ADD CONSTRAINT companies_work_hours_range_chk CHECK (
    (work_start_hour IS NULL AND work_latest_start_hour IS NULL)
    OR (
      work_start_hour        BETWEEN 0 AND 23
      AND work_latest_start_hour BETWEEN 0 AND 23
    )
  );

COMMENT ON COLUMN companies.work_start_hour IS
  'Earliest local hour a print may be STARTED (0-23). NULL = round the clock.';
COMMENT ON COLUMN companies.work_latest_start_hour IS
  'Latest local hour a print may be STARTED (0-23, exclusive). NULL = round the clock. May be less than work_start_hour for a window that wraps midnight.';
