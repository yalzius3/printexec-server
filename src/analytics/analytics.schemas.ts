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

// ── Presentation artifacts ───────────────────────────────────────
// Arguments of the AI's presentation tools (present_chart / present_table /
// compose_report). These never touch SQL — the model calls them with data it
// already fetched through registry tools, the server validates the shape here
// and forwards the artifact to the client for rendering. Bounds are UI bounds:
// what fits legibly in the Lorelei dock.

const artifactTitle = z.string().trim().min(1).max(90);
const artifactNote = z.string().trim().max(280).optional();

export const chartArtifactSchema = z
  .object({
    chart: z.enum(["bar", "line", "donut"]),
    title: artifactTitle,
    /** Short unit suffix rendered next to values ("EGP", "g", "hours"). */
    unit: z.string().trim().max(14).optional(),
    labels: z.array(z.string().trim().min(1).max(44)).min(1).max(62),
    series: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(44),
          values: z.array(z.number().finite()).min(1).max(62)
        })
      )
      .min(1)
      .max(2),
    note: artifactNote
  })
  .superRefine((v, ctx) => {
    for (const s of v.series) {
      if (s.values.length !== v.labels.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `series "${s.name}" has ${s.values.length} values but there are ${v.labels.length} labels — they must match 1:1`
        });
      }
    }
    if (v.chart !== "bar" && v.series.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${v.chart} charts take exactly one series (bar charts may compare two)`
      });
    }
  });
export type ChartArtifact = z.infer<typeof chartArtifactSchema>;

export const tableArtifactSchema = z
  .object({
    title: artifactTitle,
    columns: z.array(z.string().trim().min(1).max(40)).min(2).max(7),
    rows: z.array(z.array(z.union([z.string().max(160), z.number(), z.null()]))).min(1).max(40),
    note: artifactNote
  })
  .superRefine((v, ctx) => {
    v.rows.forEach((row, i) => {
      if (row.length !== v.columns.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `row ${i + 1} has ${row.length} cells but there are ${v.columns.length} columns`
        });
      }
    });
  });
export type TableArtifact = z.infer<typeof tableArtifactSchema>;

export const reportArtifactSchema = z.object({
  title: artifactTitle,
  subtitle: z.string().trim().max(140).optional(),
  sections: z
    .array(
      z.object({
        heading: z.string().trim().min(1).max(90),
        /** Markdown-lite: paragraphs, **bold**, `code`, "- " lists. */
        body: z.string().trim().min(1).max(5000)
      })
    )
    .min(1)
    .max(12)
});
export type ReportArtifact = z.infer<typeof reportArtifactSchema>;
