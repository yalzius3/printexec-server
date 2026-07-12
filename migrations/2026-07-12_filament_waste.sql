-- ================================================================
-- FILAMENT WASTE: persist measured failed-print waste + book it.
--
-- Until now, waste from a failed print was ephemeral: SimpleJobsService
-- .markFailed subtracted the operator's measured grams from the spool's
-- remaining_grams, wrote a one-line note to order_history, and DELETED the
-- reservation rows. Nothing durable recorded "this order wasted 30g of PLA
-- costing 0.62", so the Assets "consumed" total silently blended good prints
-- and scrap, and Finance never saw the loss.
--
-- This migration installs the durable record + its ledger home:
--
--   1. filament_waste_events  -- one append-only row per wasted spool on a
--                                failed print. Cost basis is SNAPSHOTTED at
--                                event time (the spool's own price/g, with the
--                                material average as fallback) so later re-
--                                pricing or spool deletion never rewrites
--                                history -- the same discipline the finance
--                                documents use.
--   2. Filament Waste account -- a new system expense account (code 5100,
--                                subtype 'filament_waste') in the cost-of-sales
--                                family, added to the seeded chart of accounts
--                                and backfilled onto every existing tenant.
--   3. source_type 'waste'    -- journal_entries.source_type gains a 'waste'
--                                provenance value so the posting engine can tag
--                                the failed-print entry it books:
--                                  DR 5100 Filament Waste / CR 1200 Inventory
--                                the exact mirror of the COGS entry an invoice
--                                already posts (DR COGS / CR Inventory).
--
-- Wasted material is a DIRECT-MATERIAL LOSS (abnormal spoilage), not overhead
-- and not SG&A: it belongs in the P&L as its own visible expense line rather
-- than buried inside COGS. Crediting Inventory keeps it symmetric with the
-- existing production-consumption posting, so it adds no new contra logic and
-- no new balance risk.
--
-- Server-only table like the finance schema: RLS is ENABLED with no policies
-- as defense-in-depth. The API connects as the table owner (RLS never
-- restricts the owner) so every server read/write works; any accidental Data
-- API exposure returns zero rows.
--
-- Idempotent: safe to re-run.
-- ================================================================

BEGIN;

-- ---------------------------------------------------------------
-- 1. filament_waste_events
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.filament_waste_events (
  waste_id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         UUID          NOT NULL REFERENCES public.companies(company_id) ON DELETE CASCADE,
  -- Provenance links. All ON DELETE SET NULL so a purged order / piece / spool
  -- never destroys the loss record (material_type + cost are snapshotted below).
  order_id           UUID          REFERENCES public.orders(order_id) ON DELETE SET NULL,
  piece_id           UUID          REFERENCES public.order_pieces(piece_id) ON DELETE SET NULL,
  spool_asset_id     UUID          REFERENCES public.asset_instances(asset_id) ON DELETE SET NULL,
  -- Snapshot of the wasted material so per-material reporting survives the
  -- spool / reference being deleted or re-classified.
  material_type      TEXT,
  grams              NUMERIC(12,3) NOT NULL CHECK (grams > 0),
  -- Cost basis frozen at event time: the spool's OWN purchase_price/initial_grams
  -- when priced, else the material average. cost = ROUND(grams * unit, 2).
  unit_cost_per_gram NUMERIC(14,6) NOT NULL DEFAULT 0 CHECK (unit_cost_per_gram >= 0),
  cost               NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  -- Only measured Simple-mode failures are tracked today; the column is here so
  -- other sources (advanced/bed failures, purge) can be added without a reshape.
  source             TEXT          NOT NULL DEFAULT 'simple_failed'
                       CHECK (source IN ('simple_failed')),
  -- The DR Filament Waste / CR Inventory entry this loss booked (NULL when the
  -- spool had no cost basis, so there was nothing to post).
  journal_entry_id   UUID          REFERENCES public.journal_entries(entry_id) ON DELETE SET NULL,
  created_by         UUID          REFERENCES public.users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Assets overview aggregates by material within a period window.
CREATE INDEX IF NOT EXISTS idx_filament_waste_company_material
  ON public.filament_waste_events (company_id, material_type, created_at DESC);
-- Assets overview period scans + trend comparison.
CREATE INDEX IF NOT EXISTS idx_filament_waste_company_created
  ON public.filament_waste_events (company_id, created_at DESC);
-- Order-detail rollup.
CREATE INDEX IF NOT EXISTS idx_filament_waste_order
  ON public.filament_waste_events (order_id);
CREATE INDEX IF NOT EXISTS idx_filament_waste_journal_entry
  ON public.filament_waste_events (journal_entry_id);

ALTER TABLE public.filament_waste_events ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------
-- 2. Filament Waste system account (5100) -- re-seed + backfill
-- ---------------------------------------------------------------
-- Re-declare the default-CoA seed with the new 5100 row folded in. Identical to
-- 2026-07-08_finance_core.sql otherwise; ON CONFLICT (company_id, code) DO
-- NOTHING keeps every existing account (5100 is a new code, so it's the only
-- row that actually inserts on a re-seed of an already-seeded tenant).
CREATE OR REPLACE FUNCTION public.finance_seed_default_accounts(target_company UUID)
RETURNS VOID
LANGUAGE sql
AS $$
  INSERT INTO public.finance_accounts
    (company_id, code, name, account_type, account_subtype, is_system, description)
  VALUES
    (target_company, '1000', 'Cash',                   'asset',     'cash',                 TRUE,  'Physical cash on hand.'),
    (target_company, '1010', 'Bank',                   'asset',     'bank',                 TRUE,  'Primary bank account.'),
    (target_company, '1100', 'Accounts Receivable',    'asset',     'accounts_receivable',  TRUE,  'Amounts customers owe on open invoices.'),
    (target_company, '1200', 'Inventory',              'asset',     'inventory',            TRUE,  'Goods and materials held for production or sale.'),
    (target_company, '1300', 'Vendor Prepayments',     'asset',     'vendor_prepayments',   TRUE,  'Money paid to vendors not yet applied to a bill.'),
    (target_company, '1400', 'Input Tax Receivable',   'asset',     'input_tax_receivable', TRUE,  'Recoverable tax paid on purchases.'),
    (target_company, '1500', 'Equipment',              'asset',     'fixed_assets',         TRUE,  'Machinery and long-lived equipment.'),
    (target_company, '2000', 'Accounts Payable',       'liability', 'accounts_payable',     TRUE,  'Amounts owed to vendors on open bills.'),
    (target_company, '2100', 'Sales Tax Payable',      'liability', 'sales_tax_payable',    TRUE,  'Tax collected on sales, owed to the authority.'),
    (target_company, '2200', 'Customer Credits',       'liability', 'customer_credits',     TRUE,  'Money received from customers not yet applied to an invoice.'),
    (target_company, '3000', 'Owner''s Equity',        'equity',    'owner_equity',         TRUE,  'Owner contributions and drawings.'),
    (target_company, '3900', 'Retained Earnings',      'equity',    'retained_earnings',    TRUE,  'Accumulated results of prior periods.'),
    (target_company, '4000', 'Sales Revenue',          'revenue',   'sales',                TRUE,  'Income from goods and services sold.'),
    (target_company, '4900', 'Other Income',           'revenue',   'other_income',         TRUE,  'Income outside ordinary sales.'),
    (target_company, '5000', 'Cost of Goods Sold',     'expense',   'cogs',                 TRUE,  'Direct cost of goods and services delivered.'),
    (target_company, '5100', 'Filament Waste',         'expense',   'filament_waste',       TRUE,  'Cost of filament scrapped on failed prints (abnormal spoilage).'),
    (target_company, '6000', 'Operating Expenses',     'expense',   'operating_expenses',   TRUE,  'Default account for general spend.'),
    (target_company, '6100', 'Payroll',                'expense',   'payroll',              TRUE,  'Wages and salaries.'),
    (target_company, '6200', 'Utilities',              'expense',   'utilities',            TRUE,  'Electricity, water, internet.'),
    (target_company, '6300', 'Rent',                   'expense',   'rent',                 TRUE,  'Premises rental.'),
    (target_company, '6900', 'Other Expenses',         'expense',   'other_expenses',       TRUE,  'Spend that fits nowhere else.')
  ON CONFLICT (company_id, code) DO NOTHING;
$$;

-- Backfill the new 5100 account onto every existing tenant (no-op elsewhere).
DO $$
DECLARE
  comp RECORD;
BEGIN
  FOR comp IN SELECT company_id FROM public.companies ORDER BY company_id LOOP
    PERFORM public.finance_seed_default_accounts(comp.company_id);
  END LOOP;
END $$;

-- ---------------------------------------------------------------
-- 3. journal_entries.source_type -- allow 'waste'
-- ---------------------------------------------------------------
-- Additive: every existing row uses one of the original values, so widening the
-- allowed set can never fail. Drop the inline column check (Postgres names it
-- <table>_<column>_check) and any prior named copy, then re-add named.
ALTER TABLE public.journal_entries
  DROP CONSTRAINT IF EXISTS journal_entries_source_type_check;
ALTER TABLE public.journal_entries
  DROP CONSTRAINT IF EXISTS ck_journal_entries_source_type;
ALTER TABLE public.journal_entries
  ADD CONSTRAINT ck_journal_entries_source_type
  CHECK (source_type IN ('manual', 'invoice', 'bill', 'payment', 'expense', 'reversal', 'waste'));

COMMIT;
