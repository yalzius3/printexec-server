-- ================================================================
-- INDEX DEDUPE -- scaling wave, phase 1b (after 2026-07-09_perf_indexes.sql)
--
-- The live schema turned out to carry base indexes that overlap the new set
-- (and a few pre-existing duplicates of each other). Every redundant index is
-- pure write-amplification: each INSERT/UPDATE on these hot tables maintains
-- it for zero read benefit, since a provably-equivalent-or-superset index
-- already answers every query it could serve.
--
-- RULE APPLIED (Tier A only): an index is dropped here ONLY IF another index
-- exists whose leading columns cover it -- a btree on (A) is fully served by
-- one on (A, B); an exact same-column duplicate keeps the UNIQUE/older copy.
-- Nothing "probably unused" is dropped: base single-column indexes whose
-- columns no current query filters on standalone (idx_pieces_status,
-- idx_customers_type, idx_printer_inst_brand, ...) are LEFT ALONE -- verify
-- with pg_stat_user_indexes.idx_scan after real traffic before touching them.
--
-- NEVER drop ex_order_piece_printer_schedule (GiST): it is the DB-level
-- printer double-booking guard (range overlap on scheduled/printing pieces).
--
-- Idempotent (IF EXISTS / IF NOT EXISTS). Runs as one transaction via
-- db:run-file. Rollback: recreate any index from 2026-07-09_perf_indexes.sql
-- or the base schema definition captured in the pg_indexes snapshot.
-- ================================================================

-- -- New indexes superseded by PRE-EXISTING base indexes ------------

-- idx_pieces_order (order_id) already exists -- exact duplicate.
DROP INDEX IF EXISTS idx_order_pieces_order_id;

-- idx_order_pieces_schedule_window (assigned_printer_id, scheduled_start_at,
-- scheduled_end_at) exists WITHOUT a partial predicate: it serves the busy/
-- overlap checks AND the printer-timeline queries that include done/failed
-- (which the partial cannot). The partial is strictly narrower -- drop it.
DROP INDEX IF EXISTS idx_order_pieces_printer_window;

-- idx_order_pieces_bed (bed_id) exists; bed_id is globally unique, so the
-- single-column index serves the company-scoped bed lookups just as well.
DROP INDEX IF EXISTS idx_order_pieces_company_bed;

-- idx_orders_customer (customer_id, full) exists -- serves everything the
-- partial (WHERE customer_id IS NOT NULL) does.
DROP INDEX IF EXISTS idx_orders_customer_id;

-- idx_print_beds_schedule (full, no predicate) exists -- same reasoning as
-- the order_pieces schedule window above.
DROP INDEX IF EXISTS idx_print_beds_printer_window;

-- idx_printer_inst_company (company_id) already exists -- exact duplicate.
DROP INDEX IF EXISTS idx_printer_instances_company;

-- -- Base indexes now shadowed by the NEW composites ----------------
-- A btree on (A) is fully covered by one on (A, B): the composite descends on
-- the leading column identically. Keeping both only taxes writes.

-- covered by idx_asset_history_company_created (company_id, created_at DESC)
DROP INDEX IF EXISTS idx_asset_history_company;

-- covered by idx_asset_instances_company_type (company_id, asset_type)
DROP INDEX IF EXISTS idx_asset_inst_company;

-- covered by idx_customer_interactions_customer_created (customer_id, created_at DESC)
DROP INDEX IF EXISTS idx_customer_interactions_customer_id;

-- covered by idx_customers_company_created (company_id, created_at DESC)
DROP INDEX IF EXISTS idx_customers_company;

-- exact duplicate of uq_customer_email_per_company (company_id, email);
-- the UNIQUE copy stays (it backs the 23505 conflict handling).
DROP INDEX IF EXISTS idx_customers_email;

-- covered by uq_piece_spool_asset (piece_id, spool_asset_id) and
-- uq_piece_spool_sequence (piece_id, sequence_order) -- both lead on piece_id.
DROP INDEX IF EXISTS idx_order_piece_spools_piece;

-- covered by idx_order_pieces_company_status (company_id, status)
DROP INDEX IF EXISTS idx_pieces_company;

-- covered by idx_order_pieces_schedule_window (leading assigned_printer_id)
DROP INDEX IF EXISTS idx_pieces_printer;

-- covered by idx_orders_company_created / idx_orders_company_status /
-- idx_orders_priority (all lead on company_id)
DROP INDEX IF EXISTS idx_orders_company;

-- covered by idx_orders_status_updated (status, last_updated_at)
DROP INDEX IF EXISTS idx_orders_status;

-- exact duplicate of uq_order_number_per_company (company_id, order_number):
-- the tenant-numbering migration re-created the same unique key under a new
-- name via IF NOT EXISTS. Uniqueness stays fully enforced by the base copy.
DROP INDEX IF EXISTS uq_orders_company_order_number;

-- covered by idx_print_beds_company_status (company_id, status)
DROP INDEX IF EXISTS idx_print_beds_company;

-- -- Nozzle window: partial -> full (mirror the printer pattern) ----
-- The partial (status IN scheduled/printing) serves the hot overlap checks but
-- NOT the nozzle timeline, which also reads done/failed blocks. A full 3-col
-- btree serves both -- exactly how idx_order_pieces_schedule_window works for
-- printers. Swap: create the full one first, then drop the partial.
CREATE INDEX IF NOT EXISTS idx_order_pieces_nozzle_schedule_window
  ON public.order_pieces (assigned_nozzle_asset_id, scheduled_start_at, scheduled_end_at);
DROP INDEX IF EXISTS idx_order_pieces_nozzle_window;
