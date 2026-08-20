import { Body, Controller, Get, Post } from "@nestjs/common";
import { z } from "zod";
import { CompanyId } from "../common/company-id.decorator";
import { UserId } from "../common/user-id.decorator";
import { RequirePermission } from "../auth/permission.decorator";
import { parseWithSchema } from "../common/zod";
import { SimpleJobsService } from "./simple-jobs.service";

const assignSchema = z.object({
  piece_ids: z.array(z.string().uuid()).min(1).max(500),
  printer_id: z.string().uuid(),
  // Optional: the operator picked a specific nozzle. When omitted the service
  // resolves a sensible default for the printer.
  nozzle_asset_id: z.string().uuid().optional(),
  // Optional: the bulk picker's explicit picks — one nozzle per distinct
  // requirement across the batch. The service matches each piece to whichever
  // of these fits its own nozzle need (falling back to auto-resolution).
  nozzle_asset_ids: z.array(z.string().uuid()).max(50).optional(),
  // Resin's counterpart of nozzle_asset_id: pour this batch from a specific
  // tank. Omitted = the service resolves the emptiest tank that still covers
  // the job, which is the one-click default.
  resin_tank_id: z.string().uuid().optional(),
});

const availabilitySchema = z.object({
  horizon: z.enum(["day", "week", "month", "deadline"]).default("week"),
  deadline: z.string().max(40).optional(),
  // The piece ids being assigned — used to show only the printers compatible
  // with ALL of them (technology + multicolor; offline omitted).
  //
  // In a BODY, and that is the whole reason this route is a POST rather than
  // the GET it reads like. These ids used to travel as a comma-separated query
  // string, where each one costs 39 bytes (36 for the uuid, 3 for the escaped
  // comma). The request LINE counts against Node's 16 KiB header budget, so a
  // selection of about 300 pieces produced a 431 from the runtime before any
  // handler ran, and ten thousand reset the socket outright. Nothing was wrong
  // with the query itself — the service reads these with a single = ANY(...).
  piece_ids: z.array(z.string().uuid()).max(20_000).optional(),
  // Alternatively a bed id — requirements come from the bed row instead.
  bed: z.string().uuid().optional(),
});

// Bulk-unassign below-printing work: individual pieces and/or whole printers
// (every below-printing piece on them). At least one target required.
const bulkUnassignSchema = z
  .object({
    printer_ids: z.array(z.string().uuid()).max(500).default([]),
    piece_ids: z.array(z.string().uuid()).max(1000).default([]),
  })
  .refine((v) => v.printer_ids.length > 0 || v.piece_ids.length > 0, {
    message: "Select at least one piece or printer to unassign.",
  });

// Mark a printing/done piece as a failed run: record the wasted material, then
// re-queue the piece to 'assigned' or 'pending'.
const markFailedSchema = z.object({
  piece_id: z.string().uuid(),
  requeue_to: z.enum(["assigned", "pending"]),
  // FDM: grams per reserved spool.
  spool_waste: z
    .array(
      z.object({
        spool_asset_id: z.string().uuid(),
        grams: z.number().nonnegative().max(10_000_000),
      })
    )
    .max(50)
    .default([]),
  // Resin: one volume, because a resin job draws from one tank. OMITTED means
  // "the whole planned draw was lost", which is the usual outcome — the service
  // treats absent and 0 differently on purpose, so an operator can also record a
  // failure that wasted nothing (an aborted print that never exposed).
  resin_waste_ml: z.number().nonnegative().max(10_000_000).optional(),
  // Why it failed, in the operator's words. Optional so recording the loss is
  // never blocked by not having the words yet; capped because it is one line of
  // an audit entry, not a report. Trimmed to "" is treated as absent.
  failure_reason: z.string().trim().max(500).optional(),
});

// Send a printing/done piece back to production with NOTHING wasted — the
// deliberate correction, as opposed to markFailed's recorded loss.
const sendBackSchema = z.object({
  piece_id: z.string().uuid(),
  requeue_to: z.enum(["assigned", "pending"]),
});

// Bulk-attach slicer files to already-assigned pieces (the bulk g-code drop).
const attachSlicerSchema = z.object({
  items: z
    .array(
      z.object({
        piece_id: z.string().uuid(),
        // Nullable: in headers-only storage mode a text g-code is parsed
        // locally and never uploaded, so there's no URL — only the metadata.
        slicer_file_url: z.string().min(1).max(1000).nullable(),
        slicer_print_time_minutes: z.number().int().positive().max(10_000_000).optional(),
        slicer_filament_used_grams: z.number().nonnegative().max(10_000_000).optional(),
        // Resin's counterparts — the volume a print draws and the tank it draws
        // from. Both are needed for a resin piece to reach 'ready'.
        slicer_resin_used_ml: z.number().nonnegative().max(10_000_000).optional(),
        resin_tank_id: z.string().uuid().optional(),
      })
    )
    .min(1)
    .max(500),
});

// Auto-schedule: the items to pack (pieces and/or beds), in queue order —
// deadline still outranks the given order inside the service.
const autoScheduleSchema = z.object({
  items: z
    .array(z.object({ id: z.string().uuid(), is_bed: z.boolean().optional() }))
    .min(1)
    .max(200),
  // Simulate the pack and return the plan WITHOUT committing anything: no
  // schedule() calls, no spool reservations, no nozzle swaps. Lets the operator
  // review "12 placed, 2 late, 1 skipped" before agreeing to it — a heuristic
  // that rearranges the whole shop floor shouldn't fire on a single blind click.
  dry_run: z.boolean().optional().default(false),
  // Turnaround left clear on either side of every placement, on printers,
  // nozzles and spools alike. Defaults to the 5 min the packer has always
  // enforced; the review step can override it per run, including to 0 for
  // genuinely back-to-back work. Capped at a day.
  min_margin_minutes: z.number().int().min(0).max(1440).optional(),
  // How much freedom the packer has over nozzles:
  //   earliest         — substitute an equivalent nozzle (same diameter +
  //                      material, same printer) to open an earlier slot.
  //                      Default; the main cure for false serialisation.
  //   keep_assigned    — never substitute.
  //   minimise_changes — one nozzle per printer per spec across the whole plan,
  //                      so a printer never rotates hardware between prints.
  nozzle_policy: z.enum(["earliest", "keep_assigned", "minimise_changes"]).optional(),
  // Working hours, in the SHOP's local clock. A print may only be STARTED
  // inside this window; a long print then runs on unattended past closing,
  // which is normal. Omit both for round-the-clock; equal values = no limit.
  // tz_offset_minutes is the caller's UTC offset (Cairo = 120), so the hours
  // never silently mean the server's timezone.
  // Nullable AND optional, and the difference is load-bearing: OMITTED means
  // "use the company default", while an explicit null means "ignore working
  // hours for this run". zod drops absent optional keys and keeps explicit
  // nulls, which is what lets the service tell the two apart.
  work_start_hour: z.number().int().min(0).max(23).nullable().optional(),
  work_latest_start_hour: z.number().int().min(0).max(23).nullable().optional(),
  tz_offset_minutes: z.number().int().min(-840).max(840).optional(),
  /** @deprecated older spelling of nozzle_policy: "keep_assigned". */
  allow_nozzle_swap: z.boolean().optional(),
});

// Fleet-wide pack: no item list, the server gathers every schedulable item
// itself. Same knobs as the item-scoped form.
const autoScheduleAllSchema = z.object({
  dry_run: z.boolean().optional().default(false),
  min_margin_minutes: z.number().int().min(0).max(1440).optional(),
  nozzle_policy: z.enum(["earliest", "keep_assigned", "minimise_changes"]).optional(),
  // Working hours, in the SHOP's local clock. A print may only be STARTED
  // inside this window; a long print then runs on unattended past closing,
  // which is normal. Omit both for round-the-clock; equal values = no limit.
  // tz_offset_minutes is the caller's UTC offset (Cairo = 120), so the hours
  // never silently mean the server's timezone.
  // Nullable AND optional, and the difference is load-bearing: OMITTED means
  // "use the company default", while an explicit null means "ignore working
  // hours for this run". zod drops absent optional keys and keeps explicit
  // nulls, which is what lets the service tell the two apart.
  work_start_hour: z.number().int().min(0).max(23).nullable().optional(),
  work_latest_start_hour: z.number().int().min(0).max(23).nullable().optional(),
  tz_offset_minutes: z.number().int().min(-840).max(840).optional(),
  /** @deprecated older spelling of nozzle_policy: "keep_assigned". */
  allow_nozzle_swap: z.boolean().optional(),
  // Restrict to specific printers; omitted or empty = the whole fleet.
  printer_ids: z.array(z.string().uuid()).max(200).optional(),
  // Run this as a background run whatever its size, and answer with the run id
  // instead of the plan. Big packs take this path on their own (see
  // RUN_THRESHOLD_ITEMS); this is for a caller that wants it either way, so a
  // preview and the commit that follows behave the same.
  as_run: z.boolean().optional(),
});

// The Jobs action surface — assign, auto-schedule, bulk g-code drop.
//
// The name is historical: this was the Simple-mode half of a two-mode product.
// Advanced is retired, so there is no longer another mode for these routes to be
// "the simple one" of, and the queue below is no longer scoped by operation_mode
// (a filter that, with only one mode left, could only ever hide work).
//
// GET queue is legacy: the client lists from /jobs/queue. The POST routes here
// are the live ones.
@Controller("simple-jobs")
export class SimpleJobsController {
  constructor(private readonly simpleJobsService: SimpleJobsService) {}

  @Get("queue")
  @RequirePermission("view_orders")
  queue(@CompanyId() companyId: string) {
    return this.simpleJobsService.listQueue(companyId);
  }

  @Post("assign")
  @RequirePermission("action_orders")
  assign(@CompanyId() companyId: string, @Body() body: unknown) {
    const { piece_ids, printer_id, nozzle_asset_id, nozzle_asset_ids, resin_tank_id } =
      parseWithSchema(assignSchema, body);
    return this.simpleJobsService.assign(
      companyId, piece_ids, printer_id, nozzle_asset_id, nozzle_asset_ids, resin_tank_id
    );
  }

  // A read, deliberately spelled as a POST: the selection it describes can be
  // ten thousand piece ids, which do not fit in a URL. See availabilitySchema.
  @Post("printer-availability")
  @RequirePermission("view_orders")
  availability(@CompanyId() companyId: string, @Body() body: unknown) {
    const { horizon, deadline, piece_ids, bed } = parseWithSchema(availabilitySchema, body);
    const pieceIds = piece_ids && piece_ids.length > 0 ? piece_ids : undefined;
    return this.simpleJobsService.printerAvailability(companyId, horizon, deadline, pieceIds, bed);
  }

  @Post("attach-slicer")
  @RequirePermission("action_orders")
  attachSlicer(@CompanyId() companyId: string, @Body() body: unknown) {
    const { items } = parseWithSchema(attachSlicerSchema, body);
    return this.simpleJobsService.attachSlicer(companyId, items);
  }

  @Post("unassign")
  @RequirePermission("action_orders")
  bulkUnassign(@CompanyId() companyId: string, @Body() body: unknown) {
    const { printer_ids, piece_ids } = parseWithSchema(bulkUnassignSchema, body);
    return this.simpleJobsService.bulkUnassign(companyId, printer_ids, piece_ids);
  }

  @Post("mark-failed")
  @RequirePermission("action_orders")
  markFailed(@CompanyId() companyId: string, @UserId() userId: string, @Body() body: unknown) {
    const { piece_id, requeue_to, spool_waste, resin_waste_ml, failure_reason } =
      parseWithSchema(markFailedSchema, body);
    return this.simpleJobsService.markFailed(
      companyId, userId, piece_id, requeue_to, spool_waste, resin_waste_ml, failure_reason
    );
  }

  // Put a piece back in the queue without recording any loss. Distinct from
  // mark-failed on purpose: this restores the piece's material to stock in full
  // and books no spoilage, so the two can never be confused in the ledger.
  @Post("send-back")
  @RequirePermission("action_orders")
  sendBack(@CompanyId() companyId: string, @Body() body: unknown) {
    const { piece_id, requeue_to } = parseWithSchema(sendBackSchema, body);
    return this.simpleJobsService.sendBackToProduction(companyId, piece_id, requeue_to);
  }

  // One-click constraint-satisfying packer: earliest slot per item where its
  // printer, nozzle and reserved spool(s) are ALL free; commits via the
  // guarded jobs/beds schedule(). Mixed pieces + beds. Available in both modes.
  // Pass dry_run to get the same plan back without committing it.
  @Post("auto-schedule")
  @RequirePermission("action_orders")
  autoSchedule(@CompanyId() companyId: string, @Body() body: unknown) {
    return this.simpleJobsService.autoSchedule(
      companyId,
      parseWithSchema(autoScheduleSchema, body)
    );
  }

  // Fleet-wide pack. Same engine, but the item list is the whole schedulable
  // backlog rather than one printer's bucket — so every machine is packed in a
  // single least-slack pass and a nozzle contended between two printers is
  // resolved once, globally, instead of each printer's run guessing separately.
  @Post("auto-schedule-all")
  @RequirePermission("action_orders")
  autoScheduleAll(
    @CompanyId() companyId: string,
    @UserId() userId: string,
    @Body() body: unknown
  ) {
    // Answers with the plan for an ordinary pack, or with { run_id, async_run }
    // for one large enough to have become a background run. GET /runs/:id then
    // carries the same plan shape in `result` when it finishes.
    return this.simpleJobsService.autoScheduleAll(companyId, {
      ...parseWithSchema(autoScheduleAllSchema, body),
      user_id: userId,
    });
  }

  // What the fleet-wide pack would operate on — every ready, unscheduled,
  // printer-assigned piece/bed. Lets the client show "24 items across 5
  // printers" on the button without POSTing a dry run first.
  @Get("schedulable")
  @RequirePermission("view_orders")
  schedulable(@CompanyId() companyId: string) {
    return this.simpleJobsService.listSchedulable(companyId);
  }
}
