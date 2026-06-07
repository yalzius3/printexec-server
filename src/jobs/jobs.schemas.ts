import { z } from "zod";

// ────────────────────────────────────────────────────────────
// Shared validators
// ────────────────────────────────────────────────────────────
const uuid = z.string().uuid();

// Status enum mirrors `order_pieces.status` exactly (8 values per
// db_changes_phase1.sql). Kept here as the canonical list so callers can rely
// on string types instead of magic literals. Lifecycle:
//   pending → assigned → (ready) → scheduled → printing → done|failed
//   * → cancelled
// 'ready' is reachable when a piece has printer + nozzle + slicer_file_url
// but is not yet placed on the timeline. v1 doesn't actively transition into
// 'ready', but rows in that state must be readable so the type system must
// include it.
export const JOB_STATUSES = [
  "pending",
  "assigned",
  "ready",
  "scheduled",
  "printing",
  "done",
  "failed",
  "cancelled",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const jobStatusSchema = z.enum(JOB_STATUSES);

// ────────────────────────────────────────────────────────────
// Query: GET /api/jobs/queue
// ────────────────────────────────────────────────────────────
export const listJobsQuerySchema = z.object({
  // status accepts a single value or a CSV (matches the front-end multi-select)
  status: z.union([jobStatusSchema, z.string()]).optional(),
  order_id: uuid.optional(),
  printer_id: uuid.optional(),
  search: z.string().trim().min(1).max(120).optional(),
}).strict();
export type ListJobsQuery = z.infer<typeof listJobsQuerySchema>;

// ────────────────────────────────────────────────────────────
// POST /api/jobs/:pieceId/candidates
// ────────────────────────────────────────────────────────────
/**
 * Time horizon: how far the capacity check looks ahead.
 *   - "day"      → 24 working hours from now (1 working day)
 *   - "week"     → 7 working days
 *   - "month"    → 30 working days
 *   - "deadline" → all working days until the order's deadline (default)
 */
export const TIME_HORIZONS = ["day", "week", "month", "deadline"] as const;
export type TimeHorizon = (typeof TIME_HORIZONS)[number];
export const timeHorizonSchema = z.enum(TIME_HORIZONS);

export const findCandidatesSchema = z.object({
  threshold_minutes: z.number().int().min(0).max(1440).optional(),
  time_horizon: timeHorizonSchema.optional(),
}).strict();
export type FindCandidatesInput = z.infer<typeof findCandidatesSchema>;

// ────────────────────────────────────────────────────────────
// POST /api/jobs/:pieceId/assign
// The only automated rejection in the system: slicer_print_time_minutes
// must fit within the printer's free-time pool before the order deadline.
// ────────────────────────────────────────────────────────────
// URL field that accepts both absolute URLs and our internal upload paths
// (e.g. "/api/uploads/<companyId>/<file>"). Plain z.string().url() rejects the
// latter, which is what the upload endpoint actually returns.
const fileUrl = z
  .string()
  .min(1)
  .refine((v) => /^(https?:\/\/|\/)/.test(v), "Must be a URL or absolute path.");

export const assignJobSchema = z.object({
  printer_id: uuid,
  nozzle_asset_id: uuid,
  slicer_print_time_minutes: z.number().int().positive().max(100_000),
  slicer_file_url: fileUrl.nullable().optional(),
  slicer_filament_used_grams: z.number().positive().max(100_000).nullable().optional(),
  // STL is the source mesh file — distinct from the slicer file. Optional;
  // operators often have it from order intake. Stored on order_pieces.stl_file_url.
  stl_file_url: fileUrl.nullable().optional(),
  // Per-color slicer demand for MULTICOLOR pieces, keyed by the color slot's
  // sequence_order. Written to order_piece_color_slots.slicer_grams; their sum
  // is the piece total (slicer_filament_used_grams). Omitted for single-color.
  color_slot_grams: z.array(z.object({
    sequence_order: z.number().int().positive().max(64),
    grams: z.number().positive().max(100_000),
  })).max(16).optional(),
}).strict();
export type AssignJobInput = z.infer<typeof assignJobSchema>;

// ────────────────────────────────────────────────────────────
// PATCH-style endpoint: attach or replace either of the two files
// outside the assignment flow.
// ────────────────────────────────────────────────────────────
export const updatePieceFilesSchema = z.object({
  slicer_file_url: fileUrl.nullable().optional(),
  stl_file_url: fileUrl.nullable().optional(),
}).strict().refine(
  (v) => v.slicer_file_url !== undefined || v.stl_file_url !== undefined,
  { message: "Provide at least one of slicer_file_url or stl_file_url." }
);
export type UpdatePieceFilesInput = z.infer<typeof updatePieceFilesSchema>;

// ────────────────────────────────────────────────────────────
// POST /api/jobs/:pieceId/schedule
// End time is computed from slicer_print_time_minutes, so the operator
// only picks the start.
// ────────────────────────────────────────────────────────────
export const scheduleJobSchema = z.object({
  start_at: z.string().datetime({ offset: true }),
}).strict();
export type ScheduleJobInput = z.infer<typeof scheduleJobSchema>;

// ────────────────────────────────────────────────────────────
// POST /api/jobs/:pieceId/restore
// Brings a cancelled piece back to life.
//   - to: "pending"  → cleared of all assignment fields (start fresh)
//   - to: "assigned" → keeps printer / nozzle / slicer, status = 'assigned'
//                      (only valid if the piece has an assignment cached)
// ────────────────────────────────────────────────────────────
export const restoreJobSchema = z.object({
  to: z.enum(["pending", "assigned"]),
}).strict();
export type RestoreJobInput = z.infer<typeof restoreJobSchema>;

// ────────────────────────────────────────────────────────────
// POST /api/jobs/:pieceId/complete
// ────────────────────────────────────────────────────────────
export const completeJobSchema = z.object({
  outcome: z.enum(["done", "failed"]),
  actual_print_time_minutes: z.number().int().positive().max(100_000).optional(),
  actual_filament_used_grams: z.number().positive().max(100_000).optional(),
}).strict();
export type CompleteJobInput = z.infer<typeof completeJobSchema>;

// ────────────────────────────────────────────────────────────
// POST /api/jobs/:pieceId/reserve-spools
// Bind physical spool instance(s) to the piece and reserve their grams.
// Empty/omitted allocations → the server auto-plans (single best-fit, or
// combine across spools).
// ────────────────────────────────────────────────────────────
export const reserveSpoolsSchema = z.object({
  allocations: z.array(z.object({
    spool_asset_id: z.string().uuid(),
    grams: z.number().positive().max(100_000),
    // For multicolor pieces, ties this allocation to its color slot (and the
    // order_piece_spools row gets this sequence_order). Omitted for single-color.
    sequence_order: z.number().int().positive().max(64).optional(),
  })).max(20).optional(),
}).strict();
export type ReserveSpoolsInput = z.infer<typeof reserveSpoolsSchema>;

// ────────────────────────────────────────────────────────────
// GET /api/jobs/timeline
// ────────────────────────────────────────────────────────────
export const timelineQuerySchema = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
}).strict().refine(
  (v) => new Date(v.from).getTime() < new Date(v.to).getTime(),
  { message: "`from` must be before `to`" }
);
export type TimelineQuery = z.infer<typeof timelineQuerySchema>;
