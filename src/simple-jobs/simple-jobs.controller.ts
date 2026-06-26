import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { CompanyId } from "../common/company-id.decorator";
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
});

const availabilitySchema = z.object({
  horizon: z.enum(["day", "week", "month", "deadline"]).default("week"),
  deadline: z.string().max(40).optional(),
  // Comma-separated piece ids being assigned — used to show only the printers
  // compatible with ALL of them (technology + multicolor; offline omitted).
  pieces: z.string().max(20000).optional(),
});

// Bulk-unassign every below-printing piece on the selected printers.
const bulkUnassignSchema = z.object({
  printer_ids: z.array(z.string().uuid()).min(1).max(500),
});

// Mark a printing/done piece as a failed run: record the wasted filament per
// reserved spool, then re-queue the piece to 'assigned' or 'pending'.
const markFailedSchema = z.object({
  piece_id: z.string().uuid(),
  requeue_to: z.enum(["assigned", "pending"]),
  spool_waste: z
    .array(
      z.object({
        spool_asset_id: z.string().uuid(),
        grams: z.number().nonnegative().max(10_000_000),
      })
    )
    .max(50)
    .default([]),
});

// Bulk-attach slicer files to already-assigned pieces (the bulk g-code drop).
const attachSlicerSchema = z.object({
  items: z
    .array(
      z.object({
        piece_id: z.string().uuid(),
        slicer_file_url: z.string().min(1).max(1000),
        slicer_print_time_minutes: z.number().int().positive().max(10_000_000).optional(),
        slicer_filament_used_grams: z.number().nonnegative().max(10_000_000).optional(),
      })
    )
    .min(1)
    .max(500),
});

// Simple-mode Jobs surface. Additive — the Advanced /jobs endpoints are
// untouched. Only reachable when the company is in Simple mode (the queue is
// scoped to the active operation_mode).
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
    const { piece_ids, printer_id, nozzle_asset_id, nozzle_asset_ids } = parseWithSchema(assignSchema, body);
    return this.simpleJobsService.assign(companyId, piece_ids, printer_id, nozzle_asset_id, nozzle_asset_ids);
  }

  @Get("printer-availability")
  @RequirePermission("view_orders")
  availability(@CompanyId() companyId: string, @Query() query: unknown) {
    const { horizon, deadline, pieces } = parseWithSchema(availabilitySchema, query);
    const pieceIds = pieces ? pieces.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    return this.simpleJobsService.printerAvailability(companyId, horizon, deadline, pieceIds);
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
    const { printer_ids } = parseWithSchema(bulkUnassignSchema, body);
    return this.simpleJobsService.bulkUnassign(companyId, printer_ids);
  }

  @Post("mark-failed")
  @RequirePermission("action_orders")
  markFailed(@CompanyId() companyId: string, @Body() body: unknown) {
    const { piece_id, requeue_to, spool_waste } = parseWithSchema(markFailedSchema, body);
    return this.simpleJobsService.markFailed(companyId, piece_id, requeue_to, spool_waste);
  }
}
