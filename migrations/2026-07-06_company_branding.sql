-- ================================================================
-- Company branding: logo, slogan, and about paragraph.
--
-- Backs the new Settings > Brand page. All three are optional/nullable — a
-- tenant that hasn't set any of them just shows nothing. logo_url stores the
-- path returned by the generic POST /uploads endpoint
-- ("/api/uploads/<companyId>/<filename>"); it is re-served WITHOUT auth via
-- GET /uploads/logo/:companyId (looked up server-side from this column, not
-- trusted from the client) because branding is meant to appear on
-- customer-facing surfaces later (invoices, public order-status pages,
-- branded emails), not just inside the authenticated app.
--
-- Additive + backward-compatible: plain nullable TEXT columns, no default.
-- getMe() fetches them best-effort (try/catch), so shipping the code before
-- applying this migration is safe. Safe to re-run.
-- ================================================================

BEGIN;

ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS logo_url TEXT;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS slogan TEXT;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS about_text TEXT;

COMMIT;
