-- ================================================================
-- PERFORMANCE INDEXES -- scaling wave, phase 1 (read-path hardening)
--
-- Every WHERE company_id = $1 list/rollup query currently seq-scans its table
-- per request: Postgres does NOT auto-index FK or plain columns, and the base
-- schema only carries PKs + a handful of unique constraints. Invisible at tens
-- of rows, this turns into O(table) work per request as tenants accumulate
-- data -- and the three background sweeps (time-state, order-emails, file-purge)
-- re-scan whole tables cross-tenant on a fixed cadence forever.
--
-- Each index below is matched to a specific query in the codebase (cited
-- inline). No behavior changes; reads get an access path, writes pay a small
-- per-index maintenance cost that is dwarfed by the read savings.
--
-- WHY NOT `CREATE INDEX CONCURRENTLY`: scripts/run-sql-file.mjs executes this
-- file as ONE implicit transaction (single client.query call), and CONCURRENTLY
-- is illegal inside a transaction. Plain CREATE INDEX takes a brief write-lock
-- on the table while building -- sub-second at current (pre-scale) table sizes,
-- and the single transaction makes the whole migration atomic. If this is ever
-- re-run against a table that has grown into the millions of rows, run that
-- statement manually with CONCURRENTLY outside the runner instead.
--
-- Idempotent: IF NOT EXISTS everywhere; conditional DO blocks guard the
-- print_beds table and the order_pieces.bed_id column, which ship in a
-- separate migration and may not exist yet on a given environment.
--
-- Rollback: DROP INDEX IF EXISTS <name>; for any index listed here.
-- ================================================================

-- -- order_pieces --------------------------------------------------
-- The hottest table in the system: the order-status rollup
-- (recomputeOrderStatusTx) aggregates `WHERE company_id AND order_id` on
-- nearly every mutation, and piece lists join/filter it constantly.

-- recomputeOrderStatusTx, listOrderPieces, per-order summaries, and every
-- `JOIN orders o ON o.order_id = op.order_id` (order_id is globally unique,
-- so the single-column index serves company-scoped lookups too).
CREATE INDEX IF NOT EXISTS idx_order_pieces_order_id
  ON public.order_pieces (order_id);

-- Jobs queue (listJobs: company + status ANY), findCandidates' unscheduled
-- capacity sum (company + status IN assigned/ready), customer-delete cascade.
CREATE INDEX IF NOT EXISTS idx_order_pieces_company_status
  ON public.order_pieces (company_id, status);

-- Printer overlap/busy checks -- schedule(), assign(), findCandidatesCore busy
-- windows: `assigned_printer_id = $ AND status IN ('scheduled','printing')
-- AND scheduled_end_at > $ AND scheduled_start_at < $`. Partial: only rows in
-- flight are indexed, so it stays tiny no matter how much history accumulates.
CREATE INDEX IF NOT EXISTS idx_order_pieces_printer_window
  ON public.order_pieces (assigned_printer_id, scheduled_start_at, scheduled_end_at)
  WHERE status IN ('scheduled', 'printing');

-- Nozzle overlap checks + nozzle timeline (same shape, keyed by nozzle).
CREATE INDEX IF NOT EXISTS idx_order_pieces_nozzle_window
  ON public.order_pieces (assigned_nozzle_asset_id, scheduled_start_at, scheduled_end_at)
  WHERE status IN ('scheduled', 'printing');

-- TimeStateService.advancePieces (every 60s, cross-tenant):
--   WHERE status = 'scheduled' AND scheduled_start_at <= now()
-- Without this the sweep is a full seq scan every minute, forever.
CREATE INDEX IF NOT EXISTS idx_order_pieces_sweep_start
  ON public.order_pieces (scheduled_start_at)
  WHERE status = 'scheduled';

-- TimeStateService.completeDuePieces (every 60s, cross-tenant):
--   WHERE status = 'printing' AND scheduled_end_at <= now()
CREATE INDEX IF NOT EXISTS idx_order_pieces_sweep_end
  ON public.order_pieces (scheduled_end_at)
  WHERE status = 'printing';

-- Bed child-piece lookups (propagatePieceStatus, reevaluateBedAfterPieceRemoval,
-- bedChildPieceIds, bed-scoped deletes). bed_id ships in the print_beds
-- migration -- guard the column.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'order_pieces' AND column_name = 'bed_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_order_pieces_company_bed
               ON public.order_pieces (company_id, bed_id)
               WHERE bed_id IS NOT NULL';
  END IF;
END $$;

-- -- print_beds (may not exist yet -- guarded) ----------------------
DO $$
BEGIN
  IF to_regclass('public.print_beds') IS NOT NULL THEN
    -- BedsService.list (company + status != disassembled) and status filters.
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_print_beds_company_status
               ON public.print_beds (company_id, status)';
    -- Bed/piece printer overlap checks (jobs.schedule, beds.schedule, busy unions).
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_print_beds_printer_window
               ON public.print_beds (assigned_printer_id, scheduled_start_at, scheduled_end_at)
               WHERE status IN (''scheduled'', ''printing'')';
    -- TimeStateService.advanceBeds / completeDueBeds (every 60s, cross-tenant).
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_print_beds_sweep_start
               ON public.print_beds (scheduled_start_at)
               WHERE status = ''scheduled''';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_print_beds_sweep_end
               ON public.print_beds (scheduled_end_at)
               WHERE status = ''printing''';
  END IF;
END $$;

-- -- orders --------------------------------------------------------
-- listOrders: WHERE company_id ORDER BY created_at DESC (filter + presorted).
CREATE INDEX IF NOT EXISTS idx_orders_company_created
  ON public.orders (company_id, created_at DESC);

-- Status filters + the customer-delete cascade's status NOT IN (...) updates.
CREATE INDEX IF NOT EXISTS idx_orders_company_status
  ON public.orders (company_id, status);

-- Customer cascades and rollups probe orders by customer
-- (deleteCustomer, order counts). Partial: most orders keep a customer, but
-- NULL rows (guest drafts) are never looked up this way.
CREATE INDEX IF NOT EXISTS idx_orders_customer_id
  ON public.orders (customer_id)
  WHERE customer_id IS NOT NULL;

-- OrderNotificationsService.findEligibleOrders (every 2 min, cross-tenant):
--   WHERE status = ANY('{ready_for_shipping,out_for_shipping,fulfilled}')
--   ORDER BY last_updated_at ASC LIMIT 100
-- 'fulfilled' accumulates forever, so without an index this sweep degrades
-- linearly with lifetime order volume. Also serves FilePurgeService's
-- status = 'fulfilled' scan.
CREATE INDEX IF NOT EXISTS idx_orders_status_updated
  ON public.orders (status, last_updated_at);

-- -- order_piece_spools --------------------------------------------
-- Spool-side probes: spool timeline, schedule() spool-overlap join,
-- splitSpool commitment check, AND the reserved-grams recalc trigger itself
-- (which recomputes per spool_asset_id on every reserve/release/consume).
-- piece_id lookups are already served by the uq_piece_spool_asset unique
-- constraint (piece_id leading).
CREATE INDEX IF NOT EXISTS idx_order_piece_spools_spool
  ON public.order_piece_spools (spool_asset_id);

-- -- asset_instances -----------------------------------------------
-- listAssets / listSpoolInventory / filamentPlanCore / listMaterialPricing:
-- WHERE company_id = $1 AND asset_type = '...'.
CREATE INDEX IF NOT EXISTS idx_asset_instances_company_type
  ON public.asset_instances (company_id, asset_type);

-- -- customers -----------------------------------------------------
-- listCustomers: WHERE company_id ORDER BY created_at DESC.
CREATE INDEX IF NOT EXISTS idx_customers_company_created
  ON public.customers (company_id, created_at DESC);

-- -- customer_interactions (append-only log, grows forever) --------
-- Per-customer timeline: WHERE company_id AND customer_id ORDER BY created_at
-- DESC (customer_id is globally unique, so it leads).
CREATE INDEX IF NOT EXISTS idx_customer_interactions_customer_created
  ON public.customer_interactions (customer_id, created_at DESC);

-- Global feed: WHERE company_id AND created_at >= now()-interval ORDER BY
-- created_at DESC LIMIT 100.
CREATE INDEX IF NOT EXISTS idx_customer_interactions_company_created
  ON public.customer_interactions (company_id, created_at DESC);

-- -- order_history (append-only log, grows forever) ----------------
-- listHistory: WHERE company_id AND created_at >= ... ORDER BY created_at
-- DESC LIMIT 500.
CREATE INDEX IF NOT EXISTS idx_order_history_company_created
  ON public.order_history (company_id, created_at DESC);

-- -- asset_history (append-only log, grows forever) ----------------
-- listAssetHistory: WHERE company_id AND created_at >= ... LIMIT 200.
CREATE INDEX IF NOT EXISTS idx_asset_history_company_created
  ON public.asset_history (company_id, created_at DESC);

-- -- users ---------------------------------------------------------
-- check-email (public, on the signup path) + setup's duplicate-email checks
-- all match on LOWER(email) -- a plain email index can't serve those.
CREATE INDEX IF NOT EXISTS idx_users_lower_email
  ON public.users (LOWER(email));

-- -- printer_instances ---------------------------------------------
-- Licensing resolver counts printers per company on (cached) license checks,
-- and listPrinters filters by company.
CREATE INDEX IF NOT EXISTS idx_printer_instances_company
  ON public.printer_instances (company_id);
