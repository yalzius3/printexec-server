import { z } from "zod";

// ════════════════════════════════════════════════════════════════
// Analytics parameter schemas.
//
// Every registry tool validates its parameters through one of these BEFORE
// touching SQL — the same zod objects gate both transports (REST query params
// and AI tool-call arguments), so the model can never reach a query shape the
// dashboard couldn't. `coerce` on numerics because REST params arrive as
// strings.
// ════════════════════════════════════════════════════════════════

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (YYYY-MM-DD)");

export const periodParamsSchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional()
});
export type PeriodParams = z.infer<typeof periodParamsSchema>;

export const seriesParamsSchema = periodParamsSchema.extend({
  granularity: z.enum(["auto", "day", "week", "month"]).optional()
});
export type SeriesParams = z.infer<typeof seriesParamsSchema>;

export const limitedPeriodParamsSchema = periodParamsSchema.extend({
  limit: z.coerce.number().int().min(1).max(25).optional()
});
export type LimitedPeriodParams = z.infer<typeof limitedPeriodParamsSchema>;

export const runwayParamsSchema = z.object({
  threshold_days: z.coerce.number().int().min(1).max(365).optional()
});
export type RunwayParams = z.infer<typeof runwayParamsSchema>;

export const emptyParamsSchema = z.object({});

export const toolNameParamSchema = z.object({
  // Registry names are snake_case identifiers; reject anything else before the
  // registry lookup even runs.
  name: z.string().regex(/^[a-z][a-z0-9_]{1,64}$/)
});

export const askBodySchema = z.object({
  question: z.string().trim().min(1).max(2000),
  // Short rolling transcript so follow-up questions keep their context. The
  // server re-sends it to the model verbatim; it is never persisted.
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(8000)
      })
    )
    .max(12)
    .optional()
});
export type AskBody = z.infer<typeof askBodySchema>;
