import { z } from "zod";

export const redeemGrantSchema = z.object({
  code: z.string().trim().min(4).max(40)
});

// Admin: manually put a company on a plan (Enterprise deals, early customers,
// support fixes). current_period_end null/omitted = access until changed.
export const assignPlanSchema = z.object({
  company_id: z.string().uuid(),
  plan_code: z.string().trim().min(1).max(40),
  current_period_end: z.string().datetime({ offset: true }).nullable().optional(),
  status: z.enum(["active", "canceled"]).optional()
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
  expires_at: z.string().datetime({ offset: true }).nullable().optional()
});
