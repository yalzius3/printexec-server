-- ================================================================
-- ORPHANED BED CLEANUP: one-time removal of plates that hold nothing.
--
-- ── WHAT WENT WRONG ─────────────────────────────────────────────────────────
-- reevaluateBedAfterPieceRemoval has always had the right rule: a plate whose
-- pieces are ALL gone is deleted, a plate that loses only SOME of them is
-- dismantled. The dismantle branch detaches every remaining piece — and
-- `order_pieces.bed_id` is the ONLY reference to a plate that exists anywhere
-- in this schema. So the moment a plate was dismantled it became unreachable by
-- the very function that would later delete it: deleting the rest of its pieces
-- afterwards could no longer see the plate they used to sit on, and the row
-- stood for good, invisible.
--
-- Invisible, because every reader already excludes it: BedsService.list filters
-- `status != 'disassembled'`, the client's displayBeds filters it again,
-- QueueGantt skips it, and risk.ts treats it as terminal. The row was not an
-- archive — nothing could read it — it was a leak.
--
-- The code fix (src/common/cascade.ts, deleteEmptyBedTx) makes this
-- structurally impossible from now on: a dismantle removes the plate itself.
-- THE APPLICATION DOES NOT NEED THIS FILE TO WORK — the fix is pure code and is
-- already correct against the current schema. This is only the backlog those
-- releases left behind, and it is safe to apply before or after the deploy.
--
-- ── WHY THIS IS SAFE TO DELETE ──────────────────────────────────────────────
-- Checked against the live database before writing this:
--   · `order_pieces.bed_id` is the only column in the entire database that can
--     hold a reference to a bed. There is no FK to print_beds from anywhere,
--     and no other table names one. A plate with no pieces is referenced by
--     NOTHING.
--   · Every row this targets carries no plate G-code and no STL, so there are
--     no bytes to reclaim and none to strand.
--   · Every row this targets never ran: print_started_at, print_completed_at
--     and actual_print_time_minutes are all NULL. Nothing here is the record of
--     a print that happened.
--
-- ── THE GUARDS, AND WHY EACH ONE IS THERE ───────────────────────────────────
-- The predicate is deliberately narrower than "empty":
--   · NOT EXISTS (…pieces…)  — never touch a plate that still holds work.
--   · status = 'disassembled' — the only status this leak produces. A 'done' or
--     'failed' plate emptied by recordOutcome is REAL history and is left
--     alone; that path deliberately keeps its row (see the bed-outcome work).
--     'cancelled' plates keep their pieces, so they cannot be empty anyway.
--   · never ran                — belt and braces on top of the status guard: if
--     a plate somehow reached 'disassembled' after printing, its timings are
--     evidence and it survives.
-- Getting this wrong deletes someone's production record, so it fails toward
-- keeping the row in every ambiguous case.
--
-- Idempotent: re-running deletes nothing further.
-- ================================================================

BEGIN;

-- Show what is about to go, so the run is auditable in the transcript rather
-- than being a bare row count. Run the file with `npm run db:run-file`.
SELECT bed_id, bed_name, status, created_at
  FROM print_beds pb
 WHERE pb.status = 'disassembled'
   AND pb.print_started_at IS NULL
   AND pb.print_completed_at IS NULL
   AND pb.actual_print_time_minutes IS NULL
   AND NOT EXISTS (
         SELECT 1 FROM order_pieces op
          WHERE op.company_id = pb.company_id
            AND op.bed_id = pb.bed_id
       )
 ORDER BY created_at;

DELETE FROM print_beds pb
 WHERE pb.status = 'disassembled'
   AND pb.print_started_at IS NULL
   AND pb.print_completed_at IS NULL
   AND pb.actual_print_time_minutes IS NULL
   AND NOT EXISTS (
         SELECT 1 FROM order_pieces op
          WHERE op.company_id = pb.company_id
            AND op.bed_id = pb.bed_id
       );

COMMIT;
