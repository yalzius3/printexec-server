-- ================================================================
-- AI USAGE BUDGET: a spend ledger for the "Ask" analyst (Lorelei).
--
-- One row per answered question, recording the real model cost in USD plus the
-- token split. The analyst meters a rolling-window budget off SUM(cost_usd):
-- by default about $2 every 14 days, GLOBAL across the deployment -- it guards
-- the owner's provider key, not per-tenant fairness. company_id is kept on
-- every row so AI_BUDGET_SCOPE=company can meter tenants separately with no
-- schema change.
--
-- cost_usd is NUMERIC(14,6): sub-cent precision, since a single cheap call can
-- cost a small fraction of a cent. Server-only table (all writes go through the
-- API), same posture as the other analytics/finance tables.
--
-- Until this migration is applied the cap is simply NOT enforced -- the service
-- fails open on the missing table (Postgres 42P01) and logs a warning, so
-- shipping the code before the migration never takes "Ask" down.
--
-- Idempotent: safe to re-run.
-- ================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.ai_usage_events (
  usage_id      UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID          NOT NULL REFERENCES public.companies(company_id) ON DELETE CASCADE,
  -- The model string the call was billed as (e.g. "anthropic/claude-sonnet-5").
  model         TEXT,
  input_tokens  INTEGER       NOT NULL DEFAULT 0 CHECK (input_tokens  >= 0),
  output_tokens INTEGER       NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  -- Real USD cost of the answer: provider-reported when available (OpenRouter
  -- usage.cost), otherwise a token-price estimate.
  cost_usd      NUMERIC(14,6) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Global rolling-window sum: WHERE created_at >= now() - <window>.
CREATE INDEX IF NOT EXISTS ai_usage_events_created_at_idx
  ON public.ai_usage_events (created_at);

-- Per-company rolling-window sum (AI_BUDGET_SCOPE=company).
CREATE INDEX IF NOT EXISTS ai_usage_events_company_created_at_idx
  ON public.ai_usage_events (company_id, created_at);

COMMIT;
