-- Automated customer messages: a per-company master switch for the AUTOMATIC
-- senders (the order shipping-stage sweep and the auto-emailed customer invoice).
--
-- Scope is deliberately "tenant → their customers, without a human pressing
-- send". It does NOT cover:
--   · PrintExec's own billing / licence / subscription-invoice mail to the owner
--     — a tenant silencing their own renewal notice is a support ticket waiting
--     to happen, not a feature.
--   · Operator-triggered sends (the invoice nudge/resend button). Those are a
--     human pressing send; "automated messages off" has nothing to say about them.
--
-- DEFAULT true so every existing company keeps today's behaviour and nothing
-- needs backfilling. NOT NULL so the senders never have to reason about a third,
-- "unset" state.
--
-- Turning the switch OFF does not queue anything up: the sweeps settle each
-- missed stage with a 'skipped' row in order_emails / invoice_emails, exactly as
-- they already do for "customer has no email on file". That is what makes
-- re-enabling safe — without it, flipping the switch back on would blast every
-- customer whose order moved while it was off.

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS automated_messages_enabled BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN companies.automated_messages_enabled IS
  'Master switch for AUTOMATIC customer messages (order shipping-stage emails, auto-emailed customer invoices). false = the automatic senders skip this company; missed stages are settled as skipped, never queued. Does not affect PrintExec billing mail to the owner, nor operator-triggered sends.';
