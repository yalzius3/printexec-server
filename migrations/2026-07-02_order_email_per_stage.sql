-- ════════════════════════════════════════════════════════════════
-- PER-STAGE ORDER SHIPPING EMAILS — idempotency backfill.
--
-- OrderNotificationsService moves from ONE 'order_completion' email per order to
-- ONE email per shipping STAGE. The email_type now encodes the stage
-- ('order_ready_for_shipping', 'order_out_for_shipping', 'order_fulfilled'), so
-- the existing unique index (company_id, order_id, email_type) already admits one
-- settled row per (order, stage) — NO schema change is needed.
--
-- WHY THIS BACKFILL (apply BEFORE/with the deploy): the old suppression rows use
-- email_type='order_completion', which no longer matches the per-stage lookups.
-- Without seeding, the very next sweep would email every order CURRENTLY sitting
-- at a shipping stage — for every stage it has already passed. This seeds a
-- 'skipped' row for each already-reached stage so ONLY stages entered AFTER this
-- migration produce a real email.
--
-- Fulfilment is forward-only (ready_for_shipping -> out_for_shipping -> fulfilled),
-- so "already reached" = every stage at or below the order's current stage.
-- Orders still at 'completed' (or earlier) are intentionally left untouched: they
-- have not entered a shipping stage yet, so their future ready/out/fulfilled
-- transitions are genuine new events that SHOULD notify.
--
-- Idempotent: ON CONFLICT DO NOTHING against the unique index. Safe to re-run.
-- ════════════════════════════════════════════════════════════════

WITH stage_rank(stage, rnk) AS (
  VALUES ('ready_for_shipping', 1),
         ('out_for_shipping',   2),
         ('fulfilled',          3)
)
INSERT INTO public.order_emails
  (company_id, order_id, customer_id, email_type, status, order_status, error)
SELECT o.company_id, o.order_id, o.customer_id,
       'order_' || passed.stage, 'skipped', passed.stage,
       'backfilled at per-stage launch — stage reached before per-stage emails existed'
  FROM public.orders o
  JOIN stage_rank cur    ON cur.stage = o.status
  JOIN stage_rank passed ON passed.rnk <= cur.rnk
 WHERE o.status IN ('ready_for_shipping', 'out_for_shipping', 'fulfilled')
ON CONFLICT (company_id, order_id, email_type) DO NOTHING;
