import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
} from "@nestjs/common";
import { CompanyId } from "../common/company-id.decorator";
import { RequirePermission } from "../auth/permission.decorator";
import { parseWithSchema } from "../common/zod";
import { BedsService } from "./beds.service";
import { MAX_PLATE_TRIAGE } from "./outcome";
import {
  createBedSchema,
  updateBedFilesSchema,
  updateBedSchema,
} from "./beds.schemas";
import { z } from "zod";
import type { AuthRequest } from "../auth/supabase.guard";
import { findCandidatesSchema, reserveSpoolsSchema } from "../jobs/jobs.schemas";
import {
  transitionPieceFulfilmentSchema,
  transitionPiecePostProcessSchema
} from "../orders/orders.schemas";

const uuid = z.string().uuid();
const assignBedSchema = z.object({
  printer_id: uuid,
  // Optional because a resin (MSLA/SLA) plate has no nozzle at all. The service
  // decides which technology's fields are required from the bed's own
  // required_print_technology, and rejects the wrong ones — so this being
  // optional here widens the schema, never the rules.
  nozzle_asset_id: uuid.optional(),
  // Optional: when omitted the service keeps the bed's existing time, or seeds
  // an assumed value from the constituent pieces' quote numbers.
  slicer_print_time_minutes: z.number().int().positive().max(100_000).nullable().optional(),
  slicer_file_url: z.string().min(1).nullable().optional(),
  stl_file_url: z.string().min(1).nullable().optional(),
  slicer_filament_used_grams: z.number().positive().max(100_000).nullable().optional(),
  // Resin's counterparts of nozzle + grams.
  slicer_resin_used_ml: z.number().positive().max(1_000_000).nullable().optional(),
  resin_tank_id: uuid.nullable().optional(),
}).strict();

// One-field nozzle swap (assigned/ready beds; printer's compat table only).
const bedNozzleSchema = z.object({ nozzle_asset_id: uuid }).strict();

const scheduleBedSchema = z.object({
  start_at: z.string().datetime({ offset: true }),
}).strict();

const completeBedSchema = z.object({
  outcome: z.enum(["done", "failed"]),
  actual_print_time_minutes: z.number().int().positive().max(100_000).optional(),
}).strict();

// Per-piece triage of a finished plate (BedsService.recordOutcome). The plate
// verdict above stays for the all-good and all-bad cases; this one carries a
// verdict per piece plus the material measured against each failure.
const bedOutcomeSchema = z.object({
  pieces: z
    .array(
      z.object({
        piece_id: uuid,
        outcome: z.enum(["done", "failed", "not_started"]),
        // Grams on an FDM plate, millilitres on a resin one — the plate's own
        // unit, because the piece is being measured against the plate's draw.
        // Omitted on a failed piece means "its whole share was lost", which is
        // the usual outcome and the same default MarkFailedModal pre-fills.
        waste: z.number().nonnegative().max(10_000_000).optional(),
      })
    )
    // Shared with the plan endpoint that FEEDS this one, which refuses to open a
    // plate above the same number. Spelled as the constant rather than a literal
    // so the read and the write cannot drift into disagreeing — see the note on
    // MAX_PLATE_TRIAGE for what that drift costs an operator.
    .max(MAX_PLATE_TRIAGE),
  // Where each group of re-queued pieces lands. Separate because they are
  // different situations: a failure usually goes back to the same machine to be
  // re-run, while work that never started is often re-planned from scratch.
  failed_requeue_to: z.enum(["assigned", "pending"]).default("pending"),
  not_started_requeue_to: z.enum(["assigned", "pending"]).default("pending"),
  // Why the plate failed, in the operator's words — recorded once against every
  // failed piece, the same way markFailed records it against one.
  failure_reason: z.string().trim().max(500).optional(),
  actual_print_time_minutes: z.number().int().positive().max(100_000).optional(),
}).strict();

@Controller("beds")
export class BedsController {
  constructor(private readonly beds: BedsService) {}

  @Get()
  @RequirePermission("view_orders")
  list(@CompanyId() companyId: string) {
    return this.beds.list(companyId);
  }

  @Get(":bedId")
  @RequirePermission("view_orders")
  get(@CompanyId() companyId: string, @Param("bedId") bedId: string) {
    return this.beds.get(companyId, bedId);
  }

  @Get(":bedId/pieces")
  @RequirePermission("view_orders")
  pieces(@CompanyId() companyId: string, @Param("bedId") bedId: string) {
    return this.beds.pieces(companyId, bedId);
  }

  // Everything the triage console opens with, including each piece's share of
  // the plate's material — computed here so the client never re-derives it.
  @Get(":bedId/outcome-plan")
  @RequirePermission("view_orders")
  outcomePlan(@CompanyId() companyId: string, @Param("bedId") bedId: string) {
    return this.beds.outcomePlan(companyId, bedId);
  }

  @Get(":bedId/filament-plan")
  @RequirePermission("view_orders")
  filamentPlan(@CompanyId() companyId: string, @Param("bedId") bedId: string) {
    return this.beds.filamentPlan(companyId, bedId);
  }

  @Post(":bedId/reserve-spools")
  @RequirePermission("action_orders")
  reserveSpools(
    @CompanyId() companyId: string,
    @Param("bedId") bedId: string,
    @Body() body: unknown
  ) {
    return this.beds.reserveSpools(companyId, bedId, parseWithSchema(reserveSpoolsSchema, body ?? {}));
  }

  @Post(":bedId/release-spools")
  @RequirePermission("action_orders")
  releaseSpools(@CompanyId() companyId: string, @Param("bedId") bedId: string) {
    return this.beds.releaseSpools(companyId, bedId);
  }

  @Post()
  @RequirePermission("action_orders")
  create(
    @CompanyId() companyId: string,
    @Body() body: unknown,
    @Req() req: AuthRequest
  ) {
    return this.beds.create(
      companyId,
      parseWithSchema(createBedSchema, body),
      req.userId
    );
  }

  @Patch(":bedId")
  @RequirePermission("action_orders")
  update(
    @CompanyId() companyId: string,
    @Param("bedId") bedId: string,
    @Body() body: unknown
  ) {
    return this.beds.update(
      companyId,
      bedId,
      parseWithSchema(updateBedSchema, body)
    );
  }

  @Patch(":bedId/files")
  @RequirePermission("action_orders")
  updateFiles(
    @CompanyId() companyId: string,
    @Param("bedId") bedId: string,
    @Body() body: unknown
  ) {
    return this.beds.updateFiles(
      companyId,
      bedId,
      parseWithSchema(updateBedFilesSchema, body)
    );
  }

  @Post(":bedId/disassemble")
  @RequirePermission("action_orders")
  disassemble(
    @CompanyId() companyId: string,
    @Param("bedId") bedId: string
  ) {
    return this.beds.disassemble(companyId, bedId);
  }

  @Post(":bedId/candidates")
  @RequirePermission("view_orders")
  candidates(
    @CompanyId() companyId: string,
    @Param("bedId") bedId: string,
    @Body() body: unknown
  ) {
    return this.beds.findCandidates(companyId, bedId, parseWithSchema(findCandidatesSchema, body ?? {}));
  }

  @Post(":bedId/assign")
  @RequirePermission("action_orders")
  assign(
    @CompanyId() companyId: string,
    @Param("bedId") bedId: string,
    @Body() body: unknown
  ) {
    return this.beds.assign(companyId, bedId, parseWithSchema(assignBedSchema, body));
  }

  @Post(":bedId/nozzle")
  @RequirePermission("action_orders")
  setNozzle(
    @CompanyId() companyId: string,
    @Param("bedId") bedId: string,
    @Body() body: unknown
  ) {
    return this.beds.setNozzle(
      companyId,
      bedId,
      parseWithSchema(bedNozzleSchema, body).nozzle_asset_id
    );
  }

  @Post(":bedId/schedule")
  @RequirePermission("action_orders")
  schedule(
    @CompanyId() companyId: string,
    @Param("bedId") bedId: string,
    @Body() body: unknown
  ) {
    return this.beds.schedule(companyId, bedId, parseWithSchema(scheduleBedSchema, body));
  }

  @Post(":bedId/unschedule")
  @RequirePermission("action_orders")
  unschedule(@CompanyId() companyId: string, @Param("bedId") bedId: string) {
    return this.beds.unschedule(companyId, bedId);
  }

  @Post(":bedId/complete")
  @RequirePermission("action_orders")
  complete(
    @CompanyId() companyId: string,
    @Param("bedId") bedId: string,
    @Body() body: unknown
  ) {
    return this.beds.complete(companyId, bedId, parseWithSchema(completeBedSchema, body));
  }

  // Triage a finished plate piece by piece: which parts came off good, which
  // failed and cost material, and which were never printed at all. Settles the
  // plate's material three ways, then dismantles it.
  @Post(":bedId/outcome")
  @RequirePermission("action_orders")
  outcome(
    @CompanyId() companyId: string,
    @Param("bedId") bedId: string,
    @Body() body: unknown,
    @Req() req: AuthRequest
  ) {
    return this.beds.recordOutcome(
      companyId,
      req.userId,
      bedId,
      parseWithSchema(bedOutcomeSchema, body)
    );
  }

  @Post(":bedId/cancel")
  @RequirePermission("action_orders")
  cancel(@CompanyId() companyId: string, @Param("bedId") bedId: string) {
    return this.beds.cancel(companyId, bedId);
  }

  // Advance a done bed through its shipping/fulfilment lifecycle. Walks every
  // constituent done piece's fulfilment_status forward in lockstep.
  @Post(":bedId/fulfilment")
  @RequirePermission("action_orders")
  transitionFulfilment(
    @CompanyId() companyId: string,
    @Param("bedId") bedId: string,
    @Body() body: unknown
  ) {
    const { status } = parseWithSchema(transitionPieceFulfilmentSchema, body);
    return this.beds.transitionBedFulfilment(companyId, bedId, status);
  }

  // Walk a done resin bed through wash → cure, moving every constituent done
  // piece's post_process_state forward in lockstep.
  @Post(":bedId/post-process")
  @RequirePermission("action_orders")
  transitionPostProcess(
    @CompanyId() companyId: string,
    @Param("bedId") bedId: string,
    @Body() body: unknown
  ) {
    const { state } = parseWithSchema(transitionPiecePostProcessSchema, body);
    return this.beds.transitionBedPostProcess(companyId, bedId, state);
  }

  @Post(":bedId/restore")
  @RequirePermission("action_orders")
  restore(@CompanyId() companyId: string, @Param("bedId") bedId: string) {
    return this.beds.restore(companyId, bedId);
  }

  @Post(":bedId/reprint")
  @RequirePermission("action_orders")
  reprint(@CompanyId() companyId: string, @Param("bedId") bedId: string) {
    return this.beds.reprint(companyId, bedId);
  }

  // Force-delete a bed + cascade-delete its pieces (Jobs page "delete
  // anything"). No status guard by design.
  @Delete(":bedId")
  @RequirePermission("action_orders")
  delete(@CompanyId() companyId: string, @Param("bedId") bedId: string) {
    return this.beds.deleteBed(companyId, bedId);
  }
}
