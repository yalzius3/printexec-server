-- ════════════════════════════════════════════════════════════════
-- CUSTOMER AUTO-EMAIL LOG  (order completion notifications)
--
-- Records every customer-facing email the system composes for an order. Today
-- the only type is 'order_completion' — sent once when an order first reaches a
-- "done or above" status (completed / ready_for_shipping / out_for_shipping /
-- fulfilled). The row doubles as the idempotency guard: OrderNotificationsService
-- only emails orders that have no settled row yet, so a customer is never
-- emailed twice for the same order no matter how often it re-enters those
-- statuses (or how often the sweep runs).
--
-- status:
--   'sent'    delivered through the configured transport
--   'dry_run' composed + logged only (EMAIL_ENABLED != 'true') — the default
--   'skipped' no deliverable recipient (no customer / no email / deleted), or a
--             suppressed historical order (see the backfill below)
--   transport FAILURES are intentionally NOT recorded, so the order stays
--   eligible and is retried on the next sweep (mirrors FilePurgeService, which
--   leaves its DB pointers intact when a Storage delete fails).
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.order_emails (
  email_id        UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID         NOT NULL,
  order_id        UUID         NOT NULL
                               REFERENCES public.orders(order_id) ON DELETE CASCADE,
  customer_id     UUID,
  email_type      TEXT         NOT NULL DEFAULT 'order_completion',
  recipient_email TEXT,
  subject         TEXT,
  body            TEXT,
  status          TEXT         NOT NULL
                               CHECK (status IN ('sent', 'dry_run', 'skipped', 'failed')),
  error           TEXT,
  order_status    TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- One settled email of each type per order. The inserter uses ON CONFLICT DO
-- NOTHING so a double-send race collapses to a no-op. Failures are never
-- inserted, so they don't occupy the slot and the order remains retryable.
CREATE UNIQUE INDEX IF NOT EXISTS order_emails_unique_type
  ON public.order_emails (company_id, order_id, email_type);

CREATE INDEX IF NOT EXISTS order_emails_order_idx
  ON public.order_emails (company_id, order_id);

-- ── Suppress the pre-existing backlog ────────────────────────────
-- Orders already at a "done or above" status when this feature ships reached it
-- BEFORE notifications existed; emailing them now would blast stale "your order
-- is ready" messages to customers whose orders finished weeks ago. Seed a
-- 'skipped' row for each so ONLY orders that reach those statuses AFTER this
-- migration produce a real email. (Idempotent: re-running the migration is a
-- no-op thanks to the unique index.)
INSERT INTO public.order_emails (company_id, order_id, customer_id, email_type, status, order_status, error)
SELECT o.company_id, o.order_id, o.customer_id, 'order_completion', 'skipped', o.status,
       'backfilled at feature launch — order completed before auto-email existed'
  FROM public.orders o
 WHERE o.status IN ('completed', 'ready_for_shipping', 'out_for_shipping', 'fulfilled')
ON CONFLICT (company_id, order_id, email_type) DO NOTHING;
