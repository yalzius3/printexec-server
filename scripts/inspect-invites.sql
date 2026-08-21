-- ================================================================
-- READ-ONLY diagnostic for company_invites.
--
-- Nothing here writes, locks or alters anything — it is safe to run against
-- production, and safe to re-run. Every statement is a SELECT.
--
-- Run it either way:
--   · Supabase SQL editor — paste the whole file
--   · npm run db:run-file -- scripts/inspect-invites.sql   (needs .env)
--
-- It answers the three things that could not be settled from source, because
-- company_invites is not created by any migration in this repo:
--
--   Q1  Is expires_at timestamptz?   -> decides whether the two expiry
--                                       clocks can disagree (finding F8)
--   Q2  Is token UNIQUE?             -> decides how bad a duplicate would
--                                       have been (finding F7)
--   Q3  Are all stored tokens canonical ABCD-EFGH?
--                                    -> the blast radius of finding F1
-- ================================================================


-- ────────────────────────────────────────────────────────────────
-- Q1a. The column types.
--
-- THE ANSWER IS THIS ONE LINE. If expires_at reads
--   'timestamp with time zone'    -> F8 is a non-issue. The SQL comparison
--                                    in listInvites and the JS comparison in
--                                    redemption are looking at the same
--                                    instant, and they agree.
--   'timestamp without time zone' -> F8 IS REAL. createInvite writes an ISO
--                                    string ending in Z; Postgres drops the Z
--                                    when casting to a naive column, so the
--                                    stored value is a bare wall-clock time.
--                                    SQL then resolves it in the DATABASE
--                                    session's timezone while node-postgres
--                                    resolves it in the API PROCESS's
--                                    timezone. A code can sit in the owner's
--                                    list looking live while redemption calls
--                                    it expired.
--
-- created_at is shown alongside as a known-good control: the 2026-06-06
-- migration declares it TIMESTAMPTZ, so it is what a correct column looks
-- like in this output.
-- ────────────────────────────────────────────────────────────────
SELECT
  column_name,
  data_type,
  character_maximum_length AS max_len,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'company_invites'
ORDER BY ordinal_position;


-- ────────────────────────────────────────────────────────────────
-- Q1b. Corroborating evidence, in case the type above is ambiguous to read.
--
-- createInvite always writes expires_at = now + exactly 48 hours, and
-- created_at defaults to now(). So for every row:
--
--   window_actual = 48:00:00   -> the two columns are on the same clock.
--                                 expires_at is behaving as timestamptz.
--   window_actual = 45:00:00,
--   51:00:00, or any other
--   whole-hour offset from 48  -> expires_at is naive and is being resolved
--                                 in a non-UTC timezone. The offset you see
--                                 IS the bug, in hours.
--
-- Rows created before this diagnostic existed are still valid evidence —
-- the write path has not changed.
-- ────────────────────────────────────────────────────────────────
SELECT
  pg_typeof(expires_at)          AS expires_at_type,
  pg_typeof(created_at)          AS created_at_type,
  count(*)                       AS rows_with_this_window,
  (expires_at - created_at)      AS window_actual,
  (expires_at - created_at) = interval '48 hours' AS window_is_correct
FROM company_invites
GROUP BY 1, 2, 4, 5
ORDER BY rows_with_this_window DESC;


-- ────────────────────────────────────────────────────────────────
-- Q1c. The clocks themselves. If Q1b shows an offset, this names it.
-- ────────────────────────────────────────────────────────────────
SELECT
  current_setting('TimeZone') AS db_session_timezone,
  now()                       AS db_now,
  now() AT TIME ZONE 'UTC'    AS db_now_as_utc_walltime;


-- ────────────────────────────────────────────────────────────────
-- Q2. Constraints and indexes.
--
-- Looking for a UNIQUE or PRIMARY KEY on `token`. Without one, the collision
-- loop (fixed in d868afb) could have written a duplicate, and the redemption
-- lookup reads rows[0] with no ORDER BY — so a live code could have come back
-- "already used". With one, the same bug would have surfaced as a 500 on
-- invite creation instead. Either way it is fixed; this tells you which
-- symptom to go looking for in past reports.
-- ────────────────────────────────────────────────────────────────
SELECT conname AS constraint_name, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.company_invites'::regclass
ORDER BY conname;

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'company_invites'
ORDER BY indexname;


-- ────────────────────────────────────────────────────────────────
-- Q3. Are the stored tokens all in the canonical minted shape?
--
-- generateToken has emitted ABCD-EFGH from the alphabet [A-HJ-NP-Z2-9] since
-- the first commit, so every row SHOULD be canonical. If any row is not, the
-- canonicalizer shipped in d868afb would never match it and that invite is
-- unredeemable — worth knowing before someone reports it.
-- ────────────────────────────────────────────────────────────────
SELECT
  count(*)                                                   AS total_rows,
  count(*) FILTER (WHERE token ~ '^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$') AS canonical,
  count(*) FILTER (WHERE token !~ '^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$') AS NOT_canonical,
  count(*) FILTER (WHERE used_at IS NOT NULL)                AS ever_redeemed,
  count(*) FILTER (WHERE used_at IS NULL AND expires_at > now()) AS live_now
FROM company_invites;

-- Any non-canonical rows, named. Empty result = nothing to worry about.
SELECT token, length(token) AS len, created_at, used_at, expires_at
FROM company_invites
WHERE token !~ '^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$'
ORDER BY created_at DESC
LIMIT 50;

-- Duplicate tokens. Empty result = the collision loop never bit.
SELECT token, count(*) AS copies
FROM company_invites
GROUP BY token
HAVING count(*) > 1
ORDER BY copies DESC;


-- ────────────────────────────────────────────────────────────────
-- Context: has ANY invite ever actually been redeemed?
--
-- This matters for one shipped decision. The F2 ownership check reads
-- used_by, which is write-only everywhere else in the codebase — its only
-- writer is the redemption UPDATE, which could not have run while the
-- byte-exact match was rejecting every code. That read was therefore shipped
-- fail-open. If ever_redeemed below is 0, that caution was warranted.
-- ────────────────────────────────────────────────────────────────
SELECT
  count(*) FILTER (WHERE used_at IS NOT NULL) AS redeemed_all_time,
  min(used_at)                                AS first_redemption,
  max(used_at)                                AS latest_redemption
FROM company_invites;
