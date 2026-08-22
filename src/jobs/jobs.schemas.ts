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
  // ── The Filter popover's four fields ────────────────────────────────────
  // These used to be applied ONLY on the client, over rows it had already
  // fetched. That was survivable while the client held every row, and became
  // dangerous the moment anything else had to answer "which pieces does the
  // queue currently mean?" — above all GET /queue/ids, whose answer feeds bulk
  // delete. A select-all that returned pieces an active filter was hiding would
  // let an operator delete work they could not see. The server has to know the
  // same four narrowings the popover offers.
  order_reference: z.string().trim().min(1).max(64).optional(),
  customer_name: z.string().trim().min(1).max(200).optional(),
  technology: z.string().trim().min(1).max(32).optional(),
  /** Inclusive: keep pieces due on or before this date. Undated pieces are KEPT,
   *  matching the client predicate, which only compares when a deadline exists. */
  deadline_by: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
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
  // Nullable/optional because a resin printer has no nozzle at all. The service
  // still requires one for FDM work.
  nozzle_asset_id: uuid.nullable().optional(),
  slicer_print_time_minutes: z.number().int().positive().max(100_000),
  slicer_file_url: fileUrl.nullable().optional(),
  slicer_filament_used_grams: z.number().positive().max(100_000).nullable().optional(),
  // ── Resin (MSLA/SLA) ──────────────────────────────────────────────────────
  // Resin's counterparts of grams + spool: the volume the print draws and the
  // physical tank it draws from.
  slicer_resin_used_ml: z.number().positive().max(100_000).nullable().optional(),
  resin_tank_id: uuid.nullable().optional(),
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
  // Slicer metadata parsed client-side when a slicer file is attached inline.
  // When present it drives the readiness recompute (assigned ⇄ ready) the same
  // way the assign flow does — the metadata, not the file, gates the lifecycle.
  slicer_print_time_minutes: z.number().int().positive().max(100_000).optional(),
  slicer_filament_used_grams: z.number().positive().max(100_000).optional(),
  // Resin's quantity. Absent here originally, and because the schema is strict a
  // resin piece could not send it at all — it could only send a print time, which
  // then failed the grams-only readiness test and DEMOTED a ready resin piece
  // back to 'assigned'. Every technology must be able to state its own unit on
  // any endpoint that recomputes readiness from it.
  slicer_resin_used_ml: z.number().positive().max(100_000).optional(),
}).strict().refine(
  (v) =>
    v.slicer_file_url !== undefined ||
    v.stl_file_url !== undefined ||
    v.slicer_print_time_minutes !== undefined ||
    v.slicer_filament_used_grams !== undefined ||
    v.slicer_resin_used_ml !== undefined,
  { message: "Provide at least one of slicer_file_url, stl_file_url, or slicer metadata." }
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
// POST /api/jobs/schedule-batch
// Re-time MANY pieces in one request.
//
// Why this exists rather than the client looping the single-piece route:
// moving a selection of 200 blocks along the timeline is one operator gesture,
// and as 200 requests it is 200 round trips through the Cloudflare Pages proxy,
// 200 order rollups (an aggregate over every piece in the order — the O(N²)
// shape auto-schedule already had to fix), and no way to report which ones
// landed. One request, one rollup per touched order, one per-item report.
//
// Capped at 500 to match ASSIGN_CHUNK on the client and to keep the handler's
// wall-clock bounded — each item still goes through the full guarded
// scheduleCommit, which is ~10 queries. The client chunks above that.
//
// ORDER IS SIGNIFICANT and the caller owns it: a set shifted later must be
// written last-block-first or it collides with itself (see the client's
// bulkMove.commitOrder). The handler defends against a caller that got this
// wrong by retrying conflicts once at the end, but it does not re-sort — it
// cannot know which conflicts were transient without the caller's intent.
// ────────────────────────────────────────────────────────────
export const scheduleBatchSchema = z.object({
  items: z.array(
    z.object({
      piece_id: z.string().uuid(),
      start_at: z.string().datetime({ offset: true }),
    }).strict()
  ).min(1).max(500),
}).strict();
export type ScheduleBatchInput = z.infer<typeof scheduleBatchSchema>;

// ────────────────────────────────────────────────────────────
// POST /api/jobs/unschedule-batch
// Pull many pieces off the board at once. Capped higher than the schedule
// batch because the write is genuinely set-based (two UPDATEs, not one guarded
// commit per piece) — the cost here is the per-order rollup, not the rows.
// ────────────────────────────────────────────────────────────
export const unscheduleBatchSchema = z.object({
  piece_ids: z.array(z.string().uuid()).min(1).max(1000),
}).strict();
export type UnscheduleBatchInput = z.infer<typeof unscheduleBatchSchema>;

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

/**
 * GET /api/jobs/queue/ids — the queue filter, plus an optional effective-stage
 * narrowing.
 *
 * `stage` is deliberately a free string rather than an enum: an effective stage
 * is a JobStatus OR a fulfilment_status OR a post_process_state, three separate
 * vocabularies the client already unions in `effectiveStage`. Pinning an enum
 * here would silently drop stages whenever one of those three grows a value, and
 * a select-all that quietly returns fewer ids than the operator can see is worse
 * than one that returns none. It is only ever compared, never interpolated.
 */
export const queueIdsQuerySchema = listJobsQuerySchema
  .extend({ stage: z.string().trim().min(1).max(40).optional() })
  .strict();
export type QueueIdsQuery = z.infer<typeof queueIdsQuerySchema>;

// ────────────────────────────────────────────────────────────
// Queue ordering
// ────────────────────────────────────────────────────────────
/**
 * The eight sort keys the Jobs queue offers, plus `post_process_wait`.
 *
 * `post_process_wait` is not a user-pickable option: viewing a wash/cure bucket
 * OVERRIDES the operator's chosen sort with longest-waiting-first, so that a
 * stale "Name A–Z" cannot hide the part that has been sitting on the bench since
 * yesterday. The client decides when that applies; the server just needs a name
 * for it.
 */
export const QUEUE_SORT_KEYS = [
  "urgency", "deadline", "order", "piece_name",
  "customer", "status", "printer", "time",
  "post_process_wait",
] as const;
export type QueueSortKey = (typeof QUEUE_SORT_KEYS)[number];
export const queueSortKeySchema = z.enum(QUEUE_SORT_KEYS);

export const queueSortQuerySchema = listJobsQuerySchema.extend({
  sort: queueSortKeySchema.optional(),
  order: z.enum(["asc", "desc"]).optional(),
}).strict();
export type QueueSortQuery = z.infer<typeof queueSortQuerySchema>;
