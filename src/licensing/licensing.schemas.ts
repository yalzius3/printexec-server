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

export const createGrantSchema = z.object({
  plan_code: z.string().trim().min(1).max(40),
  note: z.string().trim().max(500).optional(),
  expires_at: z.string().datetime({ offset: true }).nullable().optional()
});
