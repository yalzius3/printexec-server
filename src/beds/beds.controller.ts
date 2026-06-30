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
import {
  createBedSchema,
  updateBedFilesSchema,
  updateBedSchema,
} from "./beds.schemas";
import { z } from "zod";
import type { AuthRequest } from "../auth/supabase.guard";
import { findCandidatesSchema, reserveSpoolsSchema } from "../jobs/jobs.schemas";
import { transitionPieceFulfilmentSchema } from "../orders/orders.schemas";

const uuid = z.string().uuid();
const assignBedSchema = z.object({
  printer_id: uuid,
  nozzle_asset_id: uuid,
  slicer_print_time_minutes: z.number().int().positive().max(100_000),
  slicer_file_url: z.string().min(1).nullable().optional(),
  stl_file_url: z.string().min(1).nullable().optional(),
  slicer_filament_used_grams: z.number().positive().max(100_000).nullable().optional(),
}).strict();

const scheduleBedSchema = z.object({
  start_at: z.string().datetime({ offset: true }),
}).strict();

const completeBedSchema = z.object({
  outcome: z.enum(["done", "failed"]),
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
