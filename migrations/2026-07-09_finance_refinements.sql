-- ================================================================
-- FINANCE REFINEMENTS
--
--   1. finance_settings.default_tax_rate_id -- the tenant's default sales-tax
--      rate, pre-filled on new invoice lines and overridable per line.
--   2. Trimmed default chart of accounts -- new tenants are seeded ONLY the
--      accounts the posting engine resolves by subtype (12 hooks), instead of
--      the original 20. Everything else is theirs to add from the Accounts tab.
--      Existing tenants keep whatever they already have (accounts are now
--      user-deletable, so they can prune the extras themselves).
--   3. A seeded "VAT" rate (14%) set as each tenant's default.
--
-- Idempotent; safe to re-run. Applies going forward only -- no account or rate
-- is ever removed from a tenant that already has one.
-- ================================================================

BEGIN;

-- ---------------------------------------------------------------
-- 1. finance_settings.default_tax_rate_id
-- ---------------------------------------------------------------
ALTER TABLE public.finance_settings
  ADD COLUMN IF NOT EXISTS default_tax_rate_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_finance_settings_default_tax_rate'
  ) THEN
    ALTER TABLE public.finance_settings
      ADD CONSTRAINT fk_finance_settings_default_tax_rate
      FOREIGN KEY (default_tax_rate_id)
      REFERENCES public.tax_rates(tax_rate_id)
      ON DELETE SET NULL
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

-- ---------------------------------------------------------------
-- 2. Trimmed default chart of accounts
-- ---------------------------------------------------------------
-- Only the twelve accounts the posting engine locates by account_subtype are
-- seeded now (cash, bank, accounts_receivable, inventory, vendor_prepayments,
-- input_tax_receivable, accounts_payable, sales_tax_payable, customer_credits,
-- sales, cogs, operating_expenses). cogs + inventory are hooks because issuing
-- an order-derived invoice auto-books COGS (DR cogs / CR inventory).
--
-- ON CONFLICT (company_id, code) DO NOTHING protects tenants seeded with the
-- older 20-account chart and any custom accounts -- nothing is removed. If a
-- hook is ever deleted, systemAccount() re-runs this to restore it.
CREATE OR REPLACE FUNCTION public.finance_seed_default_accounts(target_company UUID)
RETURNS VOID
LANGUAGE sql
AS $$
  INSERT INTO public.finance_accounts
    (company_id, code, name, account_type, account_subtype, is_system, description)
  VALUES
    (target_company, '1000', 'Cash',                 'asset',     'cash',                 TRUE, 'Physical cash on hand.'),
    (target_company, '1010', 'Bank',                 'asset',     'bank',                 TRUE, 'Primary bank account.'),
    (target_company, '1100', 'Accounts Receivable',  'asset',     'accounts_receivable',  TRUE, 'Amounts customers owe on open invoices.'),
    (target_company, '1200', 'Inventory',            'asset',     'inventory',            TRUE, 'Value of materials on hand; drawn down as cost of goods sold.'),
    (target_company, '1300', 'Vendor Prepayments',   'asset',     'vendor_prepayments',   TRUE, 'Money paid to vendors not yet applied to a bill.'),
    (target_company, '1400', 'Input Tax Receivable', 'asset',     'input_tax_receivable', TRUE, 'Recoverable tax paid on purchases.'),
    (target_company, '2000', 'Accounts Payable',     'liability', 'accounts_payable',     TRUE, 'Amounts owed to vendors on open bills.'),
    (target_company, '2100', 'Sales Tax Payable',    'liability', 'sales_tax_payable',    TRUE, 'Tax collected on sales, owed to the authority.'),
    (target_company, '2200', 'Customer Credits',     'liability', 'customer_credits',     TRUE, 'Money received from customers not yet applied to an invoice.'),
    (target_company, '4000', 'Sales Revenue',        'revenue',   'sales',                TRUE, 'Income from goods and services sold.'),
    (target_company, '5000', 'Cost of Goods Sold',   'expense',   'cogs',                 TRUE, 'Direct cost of orders delivered (auto-booked when an order invoice is issued).'),
    (target_company, '6000', 'Operating Expenses',   'expense',   'operating_expenses',   TRUE, 'Default account for general spend.')
  ON CONFLICT (company_id, code) DO NOTHING;
$$;

-- ---------------------------------------------------------------
-- 3. Company default tax rate (VAT 14%)
-- ---------------------------------------------------------------
-- Idempotent: the rate is de-duplicated on the per-company unique name, and the
-- default is only filled when the tenant has not already chosen one -- a tenant
-- who set their own default or renamed VAT is never overridden.
CREATE OR REPLACE FUNCTION public.finance_seed_default_tax(target_company UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  vat_id UUID;
BEGIN
  INSERT INTO public.tax_rates (company_id, name, rate_pct)
  VALUES (target_company, 'VAT', 14)
  ON CONFLICT (company_id, name) DO NOTHING;

  SELECT tax_rate_id INTO vat_id
  FROM public.tax_rates
  WHERE company_id = target_company AND name = 'VAT'
  LIMIT 1;

  UPDATE public.finance_settings
  SET default_tax_rate_id = vat_id
  WHERE company_id = target_company
    AND default_tax_rate_id IS NULL
    AND vat_id IS NOT NULL;
END;
$$;

-- Extend the per-tenant finance bootstrap to also seed the default tax rate.
CREATE OR REPLACE FUNCTION public.companies_seed_finance()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM public.finance_seed_default_accounts(NEW.company_id);
  INSERT INTO public.finance_settings (company_id)
  VALUES (NEW.company_id)
  ON CONFLICT (company_id) DO NOTHING;
  PERFORM public.finance_seed_default_tax(NEW.company_id);
  RETURN NEW;
END;
$$;

-- Backfill existing tenants: settings row + VAT default. Accounts are left
-- exactly as they are.
DO $$
DECLARE
  comp RECORD;
BEGIN
  FOR comp IN SELECT company_id FROM public.companies ORDER BY company_id LOOP
    INSERT INTO public.finance_settings (company_id)
    VALUES (comp.company_id)
    ON CONFLICT (company_id) DO NOTHING;
    PERFORM public.finance_seed_default_tax(comp.company_id);
  END LOOP;
END $$;

COMMIT;
