import { z } from "zod";

export const redeemGrantSchema = z.object({
  code: z.string().trim().min(4).max(40)
});

// Tenant: start checkout for (today: record intent to buy) a self-serve plan.
export const checkoutSchema = z.object({
  plan_code: z.string().trim().min(1).max(40)
});

// Admin step-up: exchange PLATFORM_ADMIN_SECRET for a short-lived session.
export const adminUnlockSchema = z.object({
  secret: z.string().min(1).max(500)
});

// Admin: per-company custom plan overrides (cap and/or pricing) layered on top
// of the assigned catalogue plan. `clear: true` wipes every override back to
// the plan's own terms. Omitted fields are left untouched, so a partial edit
// (e.g. bumping just the cap) doesn't blank the pricing.
export const customPlanSchema = z.object({
  company_id: z.string().uuid(),
  clear: z.boolean().optional(),
  max_printers: z.coerce.number().int().min(0).max(1_000_000).nullable().optional(),
  price_model: z.enum(["flat", "per_printer", "bundle"]).nullable().optional(),
  price_amount: z.coerce.number().min(0).max(10_000_000).nullable().optional(),
  bundle_size: z.coerce.number().int().min(1).max(1_000_000).nullable().optional(),
  billing_basis: z.enum(["cap", "actual"]).optional(),
  label: z.string().trim().max(120).nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional()
});

// Admin: manually put a company on a plan (Enterprise deals, early customers,
// support fixes). current_period_end null/omitted = access until changed.
export const assignPlanSchema = z.object({
  company_id: z.string().uuid(),
  plan_code: z.string().trim().min(1).max(40),
  current_period_end: z.string().datetime({ offset: true }).nullable().optional(),
  status: z.enum(["active", "canceled"]).optional(),
  // Optional discount applied to the invoice this assignment issues.
  discount_code: z.string().trim().min(3).max(40).optional()
});

// Admin: stop a company's trial right now. Trials get no grace, so this drops
// the company straight into read-only until they subscribe.
export const endTrialSchema = z.object({
  company_id: z.string().uuid()
});

// Admin: set (or lift, with hold=null) a moderation hold on a company.
//   grace     → nag + block printer adds   suspended → read-only
//   banned    → full lockout
export const setHoldSchema = z.object({
  company_id: z.string().uuid(),
  hold: z.enum(["grace", "suspended", "banned"]).nullable(),
  reason: z.string().trim().max(500).optional()
});

// Admin: soft-delete / restore a company. reason is optional context.
export const companyRefSchema = z.object({
  company_id: z.string().uuid(),
  reason: z.string().trim().max(500).optional()
});

// Admin: send an in-app message to one company (shown as a dismissible banner).
export const sendMessageSchema = z.object({
  company_id: z.string().uuid(),
  body: z.string().trim().min(1).max(2000)
});

export const createGrantSchema = z.object({
  plan_code: z.string().trim().min(1).max(40),
  note: z.string().trim().max(500).optional(),
  expires_at: z.string().datetime({ offset: true }).nullable().optional(),
  // Bulk minting: how many codes to create in one go (default 1).
  count: z.number().int().min(1).max(50).optional()
});

// ── Bulk admin operations ───────────────────────────────────────────────────
// Every bulk endpoint takes an explicit id list (never "all matching") so the
// blast radius is exactly what the admin selected on screen.
const companyIds = z.array(z.string().uuid()).min(1).max(200);

// Bulk: put many companies on a plan at once (same semantics as /assign).
export const bulkAssignSchema = z.object({
  company_ids: companyIds,
  plan_code: z.string().trim().min(1).max(40),
  current_period_end: z.string().datetime({ offset: true }).nullable().optional(),
  status: z.enum(["active", "canceled"]).optional(),
  // Optional discount applied to each invoice this assignment issues.
  discount_code: z.string().trim().min(3).max(40).optional()
});

// Bulk: set or lift (hold=null) a moderation hold on many companies.
export const bulkHoldSchema = z.object({
  company_ids: companyIds,
  hold: z.enum(["grace", "suspended", "banned"]).nullable(),
  reason: z.string().trim().max(500).optional()
});

// Bulk: push each selected company's period end out by N days. Only rows that
// HAVE a period end and aren't canceled/revoked are touched — indefinite
// access can't be "extended" and a canceled plan needs /assign, not more days.
export const bulkExtendSchema = z.object({
  company_ids: companyIds,
  days: z.number().int().min(1).max(365)
});

// Bulk: end every selected company's trial right now (non-trials are skipped).
export const bulkEndTrialSchema = z.object({
  company_ids: companyIds
});

// Bulk: send the same in-app message to many companies.
export const bulkMessageSchema = z.object({
  company_ids: companyIds,
  body: z.string().trim().min(1).max(2000)
});

// Admin-composed email to the owner(s) of the selected companies. Subject and
// body may use {{company}}, {{plan}}, {{owner_email}}, {{period_end}} and
// {{days_left}} — substituted per company before sending.
export const adminEmailSchema = z.object({
  company_ids: companyIds,
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(5000)
});

// ── Discount codes ──────────────────────────────────────────────────────────
// percent → N% off (0–100); fixed → N USD off. plan_code null = any plan.
// Codes are stored uppercase and matched case-insensitively.
export const createDiscountSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(3)
      .max(40)
      .regex(/^[A-Za-z0-9][A-Za-z0-9-_]*$/, "Use letters, numbers, - or _ only."),
    kind: z.enum(["percent", "fixed"]),
    value: z.number().min(0).max(100000),
    plan_code: z.string().trim().min(1).max(40).nullable().optional(),
    description: z.string().trim().max(300).optional(),
    max_redemptions: z.number().int().min(1).max(100000).nullable().optional(),
    expires_at: z.string().datetime({ offset: true }).nullable().optional()
  })
  .refine((d) => d.kind !== "percent" || d.value <= 100, {
    message: "A percent discount can't exceed 100.",
    path: ["value"]
  });

// Flip a code on/off without losing it or its redemption history.
export const setDiscountActiveSchema = z.object({
  discount_id: z.string().uuid(),
  active: z.boolean()
});
