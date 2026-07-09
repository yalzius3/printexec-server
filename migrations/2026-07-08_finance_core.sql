-- ================================================================
-- FINANCE CORE: conventional double-entry accounting infrastructure.
--
-- This migration installs the complete conventional finance layer --
-- deliberately industry-agnostic (no filament/printer coupling):
--
--   1. finance_accounts       -- per-tenant chart of accounts (CoA), seeded
--                               with a conventional default set. System
--                               accounts carry a stable account_subtype the
--                               posting engine locates them by.
--   2. journal_entries/lines  -- the double-entry general ledger. A deferred
--                               constraint trigger guarantees every posted
--                               entry balances (sum of debit = sum of credit) at commit,
--                               and posted rows are immutable at the DB level.
--   3. vendors                -- AP counterparties (customers already exist).
--   4. tax_rates              -- named percentage rates for document lines.
--   5. invoices/invoice_lines -- accounts receivable. Optional link to an
--                               order (generic ERP flow: order -> invoice).
--   6. bills/bill_lines       -- accounts payable.
--   7. payments               -- money in/out of a cash/bank account, plus
--      payment_applications     the many-to-many settlement of invoices/bills.
--   8. expenses               -- direct (bill-less) spend.
--   9. finance_doc_sequences  -- atomic per-(company, doc type, year) counters
--                               minting INV-2026-00001-style numbers, same
--                               mechanism as order_number_sequences.
--  10. finance_settings       -- per-tenant knobs (currency label, lock date).
--
-- Ledger conventions used by the application posting engine:
--   * Documents post journal entries on issue/record; the entry id is stored
--     back on the document (journal_entry_id) for provenance.
--   * Voiding never deletes or edits a posted entry: the service posts a
--     dated reversal entry (reverses_entry_id) and flips the DOCUMENT status
--     to 'void'. Ledger history is append-only.
--   * Money is NUMERIC(14,2); quantities NUMERIC(12,3); unit prices
--     NUMERIC(14,4) (rounding happens at the line-amount level).
--
-- All finance tables are server-only (every client call goes through the
-- API), so they are not surfaced to the Data API. RLS is still ENABLED with
-- no policies as defense-in-depth -- the API connects as the table owner,
-- which RLS does not restrict, while any accidental PostgREST exposure
-- would return zero rows. Same posture as company_memberships.
--
-- Idempotent: safe to re-run.
-- ================================================================

BEGIN;

-- ---------------------------------------------------------------
-- 1. finance_accounts -- chart of accounts
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.finance_accounts (
  account_id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID        NOT NULL REFERENCES public.companies(company_id) ON DELETE CASCADE,
  -- Business-facing ledger code ("1000"); unique per tenant, drives ordering.
  code              TEXT        NOT NULL,
  name              TEXT        NOT NULL,
  account_type      TEXT        NOT NULL
                      CHECK (account_type IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
  -- Stable role tag for accounts the posting engine must find (e.g. which
  -- account is "the" A/R). NULL for ordinary user-created accounts.
  account_subtype   TEXT,
  -- Seeded accounts the engine depends on; the API refuses to delete these.
  is_system         BOOLEAN     NOT NULL DEFAULT FALSE,
  is_active         BOOLEAN     NOT NULL DEFAULT TRUE,
  description       TEXT,
  -- Optional hierarchy (e.g. "6100 Payroll" under "6000 Operating Expenses").
  parent_account_id UUID        REFERENCES public.finance_accounts(account_id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_finance_accounts_company_code UNIQUE (company_id, code)
);

CREATE INDEX IF NOT EXISTS idx_finance_accounts_company
  ON public.finance_accounts (company_id, account_type);
CREATE INDEX IF NOT EXISTS idx_finance_accounts_parent
  ON public.finance_accounts (parent_account_id);
-- The posting engine resolves system accounts by subtype; keep that lookup
-- indexed (partial: subtype is NULL for ordinary accounts).
CREATE INDEX IF NOT EXISTS idx_finance_accounts_subtype
  ON public.finance_accounts (company_id, account_subtype)
  WHERE account_subtype IS NOT NULL;

-- ---------------------------------------------------------------
-- 2. journal_entries + journal_lines -- the general ledger
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.journal_entries (
  entry_id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         UUID        NOT NULL REFERENCES public.companies(company_id) ON DELETE CASCADE,
  -- Minted business number: JE-2026-00001. Unique per tenant.
  entry_number       TEXT        NOT NULL,
  entry_date         DATE        NOT NULL DEFAULT CURRENT_DATE,
  memo               TEXT,
  -- 'draft' entries are editable scratch work; 'posted' entries are the
  -- immutable ledger. Voiding a document posts a REVERSAL entry instead of
  -- ever flipping an entry back.
  status             TEXT        NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft', 'posted')),
  -- Provenance: which document produced this entry ('manual' for hand-keyed).
  source_type        TEXT        NOT NULL DEFAULT 'manual'
                       CHECK (source_type IN ('manual', 'invoice', 'bill', 'payment', 'expense', 'reversal')),
  source_id          UUID,
  -- Set on reversal entries: the posted entry this one cancels out.
  -- Cross-row references inside the finance schema are DEFERRABLE INITIALLY
  -- DEFERRED throughout: a whole-tenant teardown deletes everything in one
  -- cascading statement, and the checks must wait until that statement's
  -- final state. Ordinary dangling references still fail at commit.
  reverses_entry_id  UUID        REFERENCES public.journal_entries(entry_id) DEFERRABLE INITIALLY DEFERRED,
  posted_at          TIMESTAMPTZ,
  created_by         UUID        REFERENCES public.users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_journal_entries_company_number UNIQUE (company_id, entry_number),
  -- Lets child lines carry a composite FK so a line can never point at an
  -- entry belonging to a different tenant.
  CONSTRAINT uq_journal_entries_entry_company UNIQUE (entry_id, company_id)
);

CREATE INDEX IF NOT EXISTS idx_journal_entries_company_date
  ON public.journal_entries (company_id, entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_journal_entries_source
  ON public.journal_entries (company_id, source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_journal_entries_reverses
  ON public.journal_entries (reverses_entry_id);

CREATE TABLE IF NOT EXISTS public.journal_lines (
  line_id     UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id    UUID          NOT NULL,
  -- Denormalised tenant key: reporting sums lines without joining the header,
  -- and the composite FK below keeps it honest.
  company_id  UUID          NOT NULL,
  account_id  UUID          NOT NULL REFERENCES public.finance_accounts(account_id) DEFERRABLE INITIALLY DEFERRED,
  -- Exactly one side of the entry line is set, and it is positive.
  debit       NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit      NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  description TEXT,
  position    INTEGER       NOT NULL DEFAULT 0,
  CONSTRAINT ck_journal_lines_one_side
    CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)),
  CONSTRAINT fk_journal_lines_entry
    FOREIGN KEY (entry_id, company_id)
    REFERENCES public.journal_entries(entry_id, company_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_journal_lines_entry
  ON public.journal_lines (entry_id);
CREATE INDEX IF NOT EXISTS idx_journal_lines_company_account
  ON public.journal_lines (company_id, account_id);

-- Balance guarantee: at COMMIT every posted entry must balance. A deferred
-- constraint trigger sees the final state of the transaction, so multi-line
-- inserts/edits are free to be momentarily unbalanced mid-transaction.
CREATE OR REPLACE FUNCTION public.journal_assert_balanced()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_entry UUID;
  entry_status TEXT;
  side_diff    NUMERIC;
  line_count   BIGINT;
BEGIN
  target_entry := COALESCE(NEW.entry_id, OLD.entry_id);

  SELECT status INTO entry_status
  FROM public.journal_entries
  WHERE entry_id = target_entry;

  -- Entry gone (cascade delete in this same transaction): nothing to assert.
  IF entry_status IS NULL OR entry_status <> 'posted' THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM(debit - credit), 0), COUNT(*)
  INTO side_diff, line_count
  FROM public.journal_lines
  WHERE entry_id = target_entry;

  IF line_count < 2 THEN
    RAISE EXCEPTION 'Posted journal entry % must have at least two lines.', target_entry;
  END IF;

  IF side_diff <> 0 THEN
    RAISE EXCEPTION 'Posted journal entry % does not balance (debit - credit = %).', target_entry, side_diff;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_journal_lines_balanced ON public.journal_lines;
CREATE CONSTRAINT TRIGGER trg_journal_lines_balanced
  AFTER INSERT OR UPDATE OR DELETE ON public.journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.journal_assert_balanced();

-- The same assertion when an entry flips draft -> posted with its lines
-- already in place (the common path used by the posting engine).
CREATE OR REPLACE FUNCTION public.journal_assert_balanced_on_post()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  side_diff  NUMERIC;
  line_count BIGINT;
BEGIN
  IF NEW.status = 'posted' THEN
    SELECT COALESCE(SUM(debit - credit), 0), COUNT(*)
    INTO side_diff, line_count
    FROM public.journal_lines
    WHERE entry_id = NEW.entry_id;

    IF line_count < 2 THEN
      RAISE EXCEPTION 'Posted journal entry % must have at least two lines.', NEW.entry_id;
    END IF;

    IF side_diff <> 0 THEN
      RAISE EXCEPTION 'Posted journal entry % does not balance (debit - credit = %).', NEW.entry_id, side_diff;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_journal_entries_post_balanced ON public.journal_entries;
CREATE CONSTRAINT TRIGGER trg_journal_entries_post_balanced
  AFTER INSERT OR UPDATE OF status ON public.journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.journal_assert_balanced_on_post();

-- Ledger immutability: posted entries and their lines cannot be edited or
-- deleted. The one allowed escape is a full tenant teardown -- when the parent
-- row is already gone in this transaction (companies -> entries cascade), the
-- guard steps aside so ON DELETE CASCADE can finish.
CREATE OR REPLACE FUNCTION public.journal_lines_block_posted_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  entry_status TEXT;
BEGIN
  SELECT status INTO entry_status
  FROM public.journal_entries
  WHERE entry_id = OLD.entry_id;

  IF entry_status = 'posted' THEN
    RAISE EXCEPTION 'Journal lines of a posted entry are immutable (entry %).', OLD.entry_id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_journal_lines_immutable ON public.journal_lines;
CREATE TRIGGER trg_journal_lines_immutable
  BEFORE UPDATE OR DELETE ON public.journal_lines
  FOR EACH ROW
  EXECUTE FUNCTION public.journal_lines_block_posted_mutation();

CREATE OR REPLACE FUNCTION public.journal_entries_block_posted_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Allow the tenant-teardown cascade (company row already deleted in this
    -- transaction); block direct deletes of posted history.
    IF OLD.status = 'posted'
       AND EXISTS (SELECT 1 FROM public.companies WHERE company_id = OLD.company_id) THEN
      RAISE EXCEPTION 'Posted journal entries cannot be deleted -- post a reversal instead (entry %).', OLD.entry_id;
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE: a posted entry's accounting substance is frozen. Memo stays
  -- editable (annotation, not accounting data).
  IF OLD.status = 'posted' THEN
    IF NEW.status <> 'posted'
       OR NEW.entry_date IS DISTINCT FROM OLD.entry_date
       OR NEW.entry_number IS DISTINCT FROM OLD.entry_number
       OR NEW.source_type IS DISTINCT FROM OLD.source_type
       OR NEW.source_id IS DISTINCT FROM OLD.source_id
       OR NEW.reverses_entry_id IS DISTINCT FROM OLD.reverses_entry_id
       OR NEW.company_id IS DISTINCT FROM OLD.company_id THEN
      RAISE EXCEPTION 'Posted journal entries are immutable -- post a reversal instead (entry %).', OLD.entry_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_journal_entries_immutable ON public.journal_entries;
CREATE TRIGGER trg_journal_entries_immutable
  BEFORE UPDATE OR DELETE ON public.journal_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.journal_entries_block_posted_mutation();

-- ---------------------------------------------------------------
-- 3. vendors -- AP counterparties
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.vendors (
  vendor_id     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID        NOT NULL REFERENCES public.companies(company_id) ON DELETE CASCADE,
  name          TEXT        NOT NULL,
  email         TEXT,
  phone         TEXT,
  tax_id        TEXT,
  address_line1 TEXT,
  address_line2 TEXT,
  city          TEXT,
  country_code  TEXT,
  notes         TEXT,
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendors_company
  ON public.vendors (company_id, is_active);

-- ---------------------------------------------------------------
-- 4. tax_rates
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tax_rates (
  tax_rate_id UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID          NOT NULL REFERENCES public.companies(company_id) ON DELETE CASCADE,
  name        TEXT          NOT NULL,
  rate_pct    NUMERIC(6,3)  NOT NULL CHECK (rate_pct >= 0 AND rate_pct <= 100),
  is_active   BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT uq_tax_rates_company_name UNIQUE (company_id, name)
);

CREATE INDEX IF NOT EXISTS idx_tax_rates_company
  ON public.tax_rates (company_id, is_active);

-- ---------------------------------------------------------------
-- 5. invoices + invoice_lines -- accounts receivable
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.invoices (
  invoice_id        UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID          NOT NULL REFERENCES public.companies(company_id) ON DELETE CASCADE,
  invoice_number    TEXT          NOT NULL,
  -- The CRM link survives customer soft/hard deletion via the name snapshot.
  customer_id       UUID          REFERENCES public.customers(customer_id) ON DELETE SET NULL,
  counterparty_name TEXT,
  -- Generic ERP provenance: which order this invoice bills (optional).
  order_id          UUID          REFERENCES public.orders(order_id) ON DELETE SET NULL,
  -- draft -> open (posted to the ledger) -> partial -> paid; void ends the line.
  status            TEXT          NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'open', 'partial', 'paid', 'void')),
  issue_date        DATE          NOT NULL DEFAULT CURRENT_DATE,
  due_date          DATE,
  currency          TEXT,
  subtotal          NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_total         NUMERIC(14,2) NOT NULL DEFAULT 0,
  total             NUMERIC(14,2) NOT NULL DEFAULT 0,
  amount_paid       NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  balance_due       NUMERIC(14,2) GENERATED ALWAYS AS (total - amount_paid) STORED,
  memo              TEXT,
  terms             TEXT,
  journal_entry_id  UUID          REFERENCES public.journal_entries(entry_id) DEFERRABLE INITIALLY DEFERRED,
  created_by        UUID          REFERENCES public.users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT uq_invoices_company_number UNIQUE (company_id, invoice_number),
  CONSTRAINT uq_invoices_invoice_company UNIQUE (invoice_id, company_id),
  CONSTRAINT ck_invoices_paid_within_total CHECK (amount_paid <= total)
);

CREATE INDEX IF NOT EXISTS idx_invoices_company_status
  ON public.invoices (company_id, status, issue_date DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_customer
  ON public.invoices (customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_order
  ON public.invoices (order_id);
CREATE INDEX IF NOT EXISTS idx_invoices_journal_entry
  ON public.invoices (journal_entry_id);
-- Aging report scans open receivables only.
CREATE INDEX IF NOT EXISTS idx_invoices_open
  ON public.invoices (company_id, due_date)
  WHERE status IN ('open', 'partial');

CREATE TABLE IF NOT EXISTS public.invoice_lines (
  line_id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id         UUID          NOT NULL,
  company_id         UUID          NOT NULL,
  description        TEXT          NOT NULL,
  quantity           NUMERIC(12,3) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price         NUMERIC(14,4) NOT NULL DEFAULT 0,
  amount             NUMERIC(14,2) GENERATED ALWAYS AS (ROUND(quantity * unit_price, 2)) STORED,
  -- Which revenue account this line credits; NULL = the tenant's system
  -- sales account, resolved at posting time.
  revenue_account_id UUID          REFERENCES public.finance_accounts(account_id) DEFERRABLE INITIALLY DEFERRED,
  tax_rate_id        UUID          REFERENCES public.tax_rates(tax_rate_id) DEFERRABLE INITIALLY DEFERRED,
  -- Snapshot of the applied rate so historic documents survive rate edits.
  tax_pct            NUMERIC(6,3)  NOT NULL DEFAULT 0 CHECK (tax_pct >= 0),
  tax_amount         NUMERIC(14,2) NOT NULL DEFAULT 0,
  position           INTEGER       NOT NULL DEFAULT 0,
  CONSTRAINT fk_invoice_lines_invoice
    FOREIGN KEY (invoice_id, company_id)
    REFERENCES public.invoices(invoice_id, company_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoice
  ON public.invoice_lines (invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_lines_revenue_account
  ON public.invoice_lines (revenue_account_id);
CREATE INDEX IF NOT EXISTS idx_invoice_lines_tax_rate
  ON public.invoice_lines (tax_rate_id);

-- ---------------------------------------------------------------
-- 6. bills + bill_lines -- accounts payable
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bills (
  bill_id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID          NOT NULL REFERENCES public.companies(company_id) ON DELETE CASCADE,
  bill_number      TEXT          NOT NULL,
  -- The vendor's own reference on their document (their invoice number).
  vendor_reference TEXT,
  vendor_id        UUID          REFERENCES public.vendors(vendor_id) ON DELETE SET NULL,
  vendor_name      TEXT,
  status           TEXT          NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'open', 'partial', 'paid', 'void')),
  issue_date       DATE          NOT NULL DEFAULT CURRENT_DATE,
  due_date         DATE,
  currency         TEXT,
  subtotal         NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_total        NUMERIC(14,2) NOT NULL DEFAULT 0,
  total            NUMERIC(14,2) NOT NULL DEFAULT 0,
  amount_paid      NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  balance_due      NUMERIC(14,2) GENERATED ALWAYS AS (total - amount_paid) STORED,
  memo             TEXT,
  journal_entry_id UUID          REFERENCES public.journal_entries(entry_id) DEFERRABLE INITIALLY DEFERRED,
  created_by       UUID          REFERENCES public.users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT uq_bills_company_number UNIQUE (company_id, bill_number),
  CONSTRAINT uq_bills_bill_company UNIQUE (bill_id, company_id),
  CONSTRAINT ck_bills_paid_within_total CHECK (amount_paid <= total)
);

CREATE INDEX IF NOT EXISTS idx_bills_company_status
  ON public.bills (company_id, status, issue_date DESC);
CREATE INDEX IF NOT EXISTS idx_bills_vendor
  ON public.bills (vendor_id);
CREATE INDEX IF NOT EXISTS idx_bills_journal_entry
  ON public.bills (journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_bills_open
  ON public.bills (company_id, due_date)
  WHERE status IN ('open', 'partial');

CREATE TABLE IF NOT EXISTS public.bill_lines (
  line_id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id            UUID          NOT NULL,
  company_id         UUID          NOT NULL,
  description        TEXT          NOT NULL,
  quantity           NUMERIC(12,3) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price         NUMERIC(14,4) NOT NULL DEFAULT 0,
  amount             NUMERIC(14,2) GENERATED ALWAYS AS (ROUND(quantity * unit_price, 2)) STORED,
  -- Which expense/asset account this line debits; NULL = the tenant's system
  -- operating-expenses account, resolved at posting time.
  expense_account_id UUID          REFERENCES public.finance_accounts(account_id) DEFERRABLE INITIALLY DEFERRED,
  tax_rate_id        UUID          REFERENCES public.tax_rates(tax_rate_id) DEFERRABLE INITIALLY DEFERRED,
  tax_pct            NUMERIC(6,3)  NOT NULL DEFAULT 0 CHECK (tax_pct >= 0),
  tax_amount         NUMERIC(14,2) NOT NULL DEFAULT 0,
  position           INTEGER       NOT NULL DEFAULT 0,
  CONSTRAINT fk_bill_lines_bill
    FOREIGN KEY (bill_id, company_id)
    REFERENCES public.bills(bill_id, company_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_bill_lines_bill
  ON public.bill_lines (bill_id);
CREATE INDEX IF NOT EXISTS idx_bill_lines_expense_account
  ON public.bill_lines (expense_account_id);
CREATE INDEX IF NOT EXISTS idx_bill_lines_tax_rate
  ON public.bill_lines (tax_rate_id);

-- ---------------------------------------------------------------
-- 7. payments + payment_applications
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payments (
  payment_id         UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         UUID          NOT NULL REFERENCES public.companies(company_id) ON DELETE CASCADE,
  payment_number     TEXT          NOT NULL,
  -- 'in' = money received (settles invoices); 'out' = money disbursed
  -- (settles bills). The unapplied remainder posts to customer credits /
  -- vendor prepayments so the ledger always balances.
  direction          TEXT          NOT NULL CHECK (direction IN ('in', 'out')),
  method             TEXT          NOT NULL DEFAULT 'cash'
                       CHECK (method IN ('cash', 'bank_transfer', 'card', 'cheque', 'other')),
  payment_date       DATE          NOT NULL DEFAULT CURRENT_DATE,
  amount             NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  -- The cash/bank ledger account the money lands in / leaves from.
  deposit_account_id UUID          NOT NULL REFERENCES public.finance_accounts(account_id) DEFERRABLE INITIALLY DEFERRED,
  customer_id        UUID          REFERENCES public.customers(customer_id) ON DELETE SET NULL,
  vendor_id          UUID          REFERENCES public.vendors(vendor_id) ON DELETE SET NULL,
  counterparty_name  TEXT,
  reference          TEXT,
  memo               TEXT,
  status             TEXT          NOT NULL DEFAULT 'recorded'
                       CHECK (status IN ('recorded', 'void')),
  journal_entry_id   UUID          REFERENCES public.journal_entries(entry_id) DEFERRABLE INITIALLY DEFERRED,
  created_by         UUID          REFERENCES public.users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT uq_payments_company_number UNIQUE (company_id, payment_number),
  CONSTRAINT uq_payments_payment_company UNIQUE (payment_id, company_id)
);

CREATE INDEX IF NOT EXISTS idx_payments_company_date
  ON public.payments (company_id, payment_date DESC);
CREATE INDEX IF NOT EXISTS idx_payments_customer
  ON public.payments (customer_id);
CREATE INDEX IF NOT EXISTS idx_payments_vendor
  ON public.payments (vendor_id);
CREATE INDEX IF NOT EXISTS idx_payments_deposit_account
  ON public.payments (deposit_account_id);
CREATE INDEX IF NOT EXISTS idx_payments_journal_entry
  ON public.payments (journal_entry_id);

CREATE TABLE IF NOT EXISTS public.payment_applications (
  application_id UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID          NOT NULL,
  payment_id     UUID          NOT NULL,
  invoice_id     UUID,
  bill_id        UUID,
  amount         NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
  -- An application settles exactly one document.
  CONSTRAINT ck_payment_applications_one_target
    CHECK ((invoice_id IS NULL) <> (bill_id IS NULL)),
  CONSTRAINT fk_payment_applications_payment
    FOREIGN KEY (payment_id, company_id)
    REFERENCES public.payments(payment_id, company_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_payment_applications_invoice
    FOREIGN KEY (invoice_id, company_id)
    REFERENCES public.invoices(invoice_id, company_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_payment_applications_bill
    FOREIGN KEY (bill_id, company_id)
    REFERENCES public.bills(bill_id, company_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS idx_payment_applications_payment
  ON public.payment_applications (payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_applications_invoice
  ON public.payment_applications (invoice_id);
CREATE INDEX IF NOT EXISTS idx_payment_applications_bill
  ON public.payment_applications (bill_id);

-- ---------------------------------------------------------------
-- 8. expenses -- direct spend without a bill
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.expenses (
  expense_id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            UUID          NOT NULL REFERENCES public.companies(company_id) ON DELETE CASCADE,
  expense_number        TEXT          NOT NULL,
  vendor_id             UUID          REFERENCES public.vendors(vendor_id) ON DELETE SET NULL,
  vendor_name           TEXT,
  expense_date          DATE          NOT NULL DEFAULT CURRENT_DATE,
  amount                NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  -- What the money was spent on (an expense/asset account) ...
  category_account_id   UUID          NOT NULL REFERENCES public.finance_accounts(account_id) DEFERRABLE INITIALLY DEFERRED,
  -- ... and which cash/bank account paid for it.
  paid_from_account_id  UUID          NOT NULL REFERENCES public.finance_accounts(account_id) DEFERRABLE INITIALLY DEFERRED,
  description           TEXT,
  reference             TEXT,
  status                TEXT          NOT NULL DEFAULT 'recorded'
                          CHECK (status IN ('recorded', 'void')),
  journal_entry_id      UUID          REFERENCES public.journal_entries(entry_id) DEFERRABLE INITIALLY DEFERRED,
  created_by            UUID          REFERENCES public.users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT uq_expenses_company_number UNIQUE (company_id, expense_number)
);

CREATE INDEX IF NOT EXISTS idx_expenses_company_date
  ON public.expenses (company_id, expense_date DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_vendor
  ON public.expenses (vendor_id);
CREATE INDEX IF NOT EXISTS idx_expenses_category_account
  ON public.expenses (category_account_id);
CREATE INDEX IF NOT EXISTS idx_expenses_paid_from_account
  ON public.expenses (paid_from_account_id);
CREATE INDEX IF NOT EXISTS idx_expenses_journal_entry
  ON public.expenses (journal_entry_id);

-- ---------------------------------------------------------------
-- 9. finance_doc_sequences -- atomic document numbering
-- ---------------------------------------------------------------
-- Same mechanism as order_number_sequences: one counter row per
-- (company, doc type, year), bumped with INSERT ... ON CONFLICT DO UPDATE
-- ... RETURNING so concurrent creations can never mint the same number.
CREATE TABLE IF NOT EXISTS public.finance_doc_sequences (
  company_id UUID    NOT NULL REFERENCES public.companies(company_id) ON DELETE CASCADE,
  doc_type   TEXT    NOT NULL CHECK (doc_type IN ('invoice', 'bill', 'payment', 'expense', 'journal')),
  year       INTEGER NOT NULL,
  last_value BIGINT  NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, doc_type, year)
);

-- ---------------------------------------------------------------
-- 10. finance_settings -- per-tenant configuration
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.finance_settings (
  company_id       UUID        PRIMARY KEY REFERENCES public.companies(company_id) ON DELETE CASCADE,
  -- Display label only -- the app is single-currency per tenant today.
  currency_code    TEXT        NOT NULL DEFAULT 'USD',
  -- Books-closed date: the API refuses postings dated on/before this.
  lock_date        DATE,
  default_terms    TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------
-- 11. Default chart of accounts -- seed function + triggers + backfill
-- ---------------------------------------------------------------
-- The conventional small-business CoA every tenant starts with. Subtypes
-- marked here are the stable hooks the posting engine resolves:
--   cash / bank                  -- payment deposit accounts
--   accounts_receivable          -- invoice postings
--   accounts_payable             -- bill postings
--   sales_tax_payable            -- output tax on invoices
--   input_tax_receivable         -- input tax on bills
--   customer_credits             -- unapplied money-in remainder
--   vendor_prepayments           -- unapplied money-out remainder
--   sales                        -- default invoice-line revenue
--   operating_expenses           -- default bill-line expense
-- ON CONFLICT (company_id, code) DO NOTHING keeps re-runs and partial seeds
-- safe: user-created accounts are never touched.
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
    (target_company, '6000', 'Operating Expenses',     'expense',   'operating_expenses',   TRUE,  'Default account for general spend.'),
    (target_company, '6100', 'Payroll',                'expense',   'payroll',              TRUE,  'Wages and salaries.'),
    (target_company, '6200', 'Utilities',              'expense',   'utilities',            TRUE,  'Electricity, water, internet.'),
    (target_company, '6300', 'Rent',                   'expense',   'rent',                 TRUE,  'Premises rental.'),
    (target_company, '6900', 'Other Expenses',         'expense',   'other_expenses',       TRUE,  'Spend that fits nowhere else.')
  ON CONFLICT (company_id, code) DO NOTHING;
$$;

-- Every new tenant gets its CoA (and a settings row) the moment the company
-- row lands, so the finance module works with zero setup.
CREATE OR REPLACE FUNCTION public.companies_seed_finance()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM public.finance_seed_default_accounts(NEW.company_id);
  INSERT INTO public.finance_settings (company_id)
  VALUES (NEW.company_id)
  ON CONFLICT (company_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_companies_seed_finance ON public.companies;
CREATE TRIGGER trg_companies_seed_finance
  AFTER INSERT ON public.companies
  FOR EACH ROW
  EXECUTE FUNCTION public.companies_seed_finance();

-- Backfill every existing tenant exactly once (ON CONFLICT paths make
-- re-runs no-ops).
DO $$
DECLARE
  comp RECORD;
BEGIN
  FOR comp IN SELECT company_id FROM public.companies ORDER BY company_id LOOP
    PERFORM public.finance_seed_default_accounts(comp.company_id);
    INSERT INTO public.finance_settings (company_id)
    VALUES (comp.company_id)
    ON CONFLICT (company_id) DO NOTHING;
  END LOOP;
END $$;

-- ---------------------------------------------------------------
-- 12. RLS posture -- server-only tables, deny-all as defense-in-depth
-- ---------------------------------------------------------------
-- The API connects as the table owner (RLS never restricts the owner), and
-- no policies exist, so any anon/authenticated access through the Data API
-- yields nothing even if these tables were ever exposed.
ALTER TABLE public.finance_accounts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journal_entries       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journal_lines         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendors               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax_rates             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_lines         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bills                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bill_lines            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_applications  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expenses              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_doc_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_settings      ENABLE ROW LEVEL SECURITY;

COMMIT;
