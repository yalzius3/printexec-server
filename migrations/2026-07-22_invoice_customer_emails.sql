-- ════════════════════════════════════════════════════════════════
-- CUSTOMER INVOICE EMAIL LOG  (the shop bills its customer)
--
-- Records every invoice the system emails to a tenant's customer. The row
-- doubles as the idempotency guard, exactly like order_emails: an invoice is
-- eligible only while it has no settled row for the email type, so issuing —
-- or re-issuing after a void, or two sweeps overlapping — can never bill the
-- same customer twice for the same document.
--
-- email_type:
--   'invoice_issued' the automatic send, fired the moment the invoice is issued
--                    (an issued invoice is a posted accounting document — that
--                    is the one event that means "this is now really owed").
--   'invoice_resend' an explicit, operator-initiated resend. Deliberately a
--                    SEPARATE type so a resend neither consumes nor is blocked
--                    by the automatic slot; the service deletes the prior
--                    resend row first, so repeat resends stay possible while
--                    the automatic send stays exactly-once.
--
-- status:
--   'sent'    delivered through the configured transport
--   'dry_run' composed + logged only (EMAIL_ENABLED != 'true') — the default
--   'skipped' no deliverable recipient (no customer / no email / deleted), or a
--             suppressed pre-existing invoice (see the backfill below)
--   transport FAILURES are intentionally NOT recorded, so the invoice stays
--   eligible and is retried on the next sweep (mirrors order_emails).
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.invoice_emails (
  email_id        UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID         NOT NULL,
  invoice_id      UUID         NOT NULL
                               REFERENCES public.invoices(invoice_id) ON DELETE CASCADE,
  customer_id     UUID,
  email_type      TEXT         NOT NULL DEFAULT 'invoice_issued',
  recipient_email TEXT,
  subject         TEXT,
  body            TEXT,
  status          TEXT         NOT NULL
                               CHECK (status IN ('sent', 'dry_run', 'skipped', 'failed')),
  error           TEXT,
  -- The invoice's status at send time, for the audit trail.
  invoice_status  TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- One settled email of each type per invoice. The inserter uses ON CONFLICT DO
-- NOTHING so a double-send race collapses to a no-op. Failures are never
-- inserted, so they don't occupy the slot and the invoice remains retryable.
CREATE UNIQUE INDEX IF NOT EXISTS invoice_emails_unique_type
  ON public.invoice_emails (company_id, invoice_id, email_type);

CREATE INDEX IF NOT EXISTS invoice_emails_invoice_idx
  ON public.invoice_emails (company_id, invoice_id);

-- ── Suppress the pre-existing backlog ────────────────────────────
-- Invoices already issued when this feature ships were issued BEFORE the
-- customer ever expected an email; sweeping them now would mail out every
-- historical bill a shop has ever posted — including ones already paid — which
-- is the single worst failure mode this feature has. Seed a 'skipped' row for
-- each, so ONLY invoices issued AFTER this migration send anything.
--
-- Deliberately covers 'paid' and 'void' too: a void invoice can never be
-- issued again (voiding is terminal), and a paid one is settled business.
--
-- To (re)send one of these historical invoices deliberately, use the Resend
-- action in the invoice window — it writes the separate 'invoice_resend' type
-- and is not blocked by these rows.
--
-- Idempotent: re-running the migration is a no-op thanks to the unique index.
INSERT INTO public.invoice_emails
  (company_id, invoice_id, customer_id, email_type, status, invoice_status, error)
SELECT i.company_id, i.invoice_id, i.customer_id, 'invoice_issued', 'skipped', i.status,
       'backfilled at feature launch — invoice issued before invoice email existed'
  FROM public.invoices i
 WHERE i.status <> 'draft'
ON CONFLICT (company_id, invoice_id, email_type) DO NOTHING;
