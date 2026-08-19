import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { CompanyId } from "../common/company-id.decorator";
import { RequirePermission } from "../auth/permission.decorator";
import { parseWithSchema } from "../common/zod";
import { JobsService } from "./jobs.service";
import {
  assignJobSchema,
  completeJobSchema,
  findCandidatesSchema,
  listJobsQuerySchema,
  reserveSpoolsSchema,
  restoreJobSchema,
  scheduleJobSchema,
  timelineQuerySchema,
  updatePieceFilesSchema,
  queueIdsQuerySchema,
  queueSortQuerySchema,
} from "./jobs.schemas";
import { z } from "zod";

// Inline: the one-field nozzle swap payload.
const setNozzleSchema = z.object({ nozzle_asset_id: z.string().uuid() });

/**
 * The Jobs API surfaces are the front door for the assignment + scheduling
 * workflow defined in `JOBS_DESIGN_MEMO.md`. Every mutation uses
 * `action_orders`; reads use `view_orders`.
 */
@Controller("jobs")
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}

  // ── Read endpoints ───────────────────────────────────────────
  @Get("queue")
  @RequirePermission("view_orders")
  listQueue(
    @CompanyId() companyId: string,
    @Query() query: unknown
  ) {
    return this.jobsService.listJobs(
      companyId,
      parseWithSchema(queueSortQuerySchema, query)
    );
  }

  /**
   * Cheap "has the board changed?" probe for the polling backstop, so an idle
   * queue stops re-pulling every row every minute. Two segments, so it cannot be
   * swallowed by the single-segment `:pieceId` route below whatever the
   * declaration order.
   */
  @Get("queue/fingerprint")
  @RequirePermission("view_orders")
  queueFingerprint(@CompanyId() companyId: string) {
    return this.jobsService.queueFingerprint(companyId);
  }

  /**
   * Filter facets + stage tab counts, aggregated in SQL. Both were previously
   * derived by walking every row on the client, which is a large part of why the
   * client had to be holding every row at all.
   */
  @Get("queue/summary")
  @RequirePermission("view_orders")
  queueSummary(@CompanyId() companyId: string, @Query() query: unknown) {
    return this.jobsService.queueSummary(
      companyId,
      parseWithSchema(listJobsQuerySchema, query)
    );
  }

  /**
   * Every piece id matching the current filter — what Ctrl+A selects, and what
   * the bulk actions then operate on. Ids only: ten thousand of them is ~380 KB
   * rather than the 16.5 MB of full rows the client used to hold to answer the
   * same question.
   */
  @Get("queue/ids")
  @RequirePermission("view_orders")
  queueIds(@CompanyId() companyId: string, @Query() query: unknown) {
    return this.jobsService.queueIds(
      companyId,
      parseWithSchema(queueIdsQuerySchema, query)
    );
  }

  /**
   * The pending, printer-less pieces Bulk Assign starts from. Returns
   * `cost_inputs` raw — the assumed time/quantity are derived on the client with
   * the same function that has always derived them, because those figures end up
   * in what a job is priced from.
   */
  @Get("queue/assignable")
  @RequirePermission("view_orders")
  queueAssignable(@CompanyId() companyId: string, @Query() query: unknown) {
    return this.jobsService.queueAssignable(
      companyId,
      parseWithSchema(listJobsQuerySchema, query)
    );
  }

  @Get("timeline")
  @RequirePermission("view_orders")
  timeline(
    @CompanyId() companyId: string,
    @Query() query: unknown
  ) {
    return this.jobsService.timeline(
      companyId,
      parseWithSchema(timelineQuerySchema, query)
    );
  }

  @Get("printers/:printerId/timeline")
  @RequirePermission("view_orders")
  printerTimeline(
    @CompanyId() companyId: string,
    @Param("printerId") printerId: string,
    @Query() query: unknown
  ) {
    return this.jobsService.printerTimeline(
      companyId,
      printerId,
      parseWithSchema(timelineQuerySchema, query)
    );
  }

  @Get("nozzles/:nozzleAssetId/timeline")
  @RequirePermission("view_orders")
  nozzleTimeline(
    @CompanyId() companyId: string,
    @Param("nozzleAssetId") nozzleAssetId: string,
    @Query() query: unknown
  ) {
    return this.jobsService.nozzleTimeline(
      companyId,
      nozzleAssetId,
      parseWithSchema(timelineQuerySchema, query)
    );
  }

  @Get("spools/:spoolAssetId/timeline")
  @RequirePermission("view_orders")
  spoolTimeline(
    @CompanyId() companyId: string,
    @Param("spoolAssetId") spoolAssetId: string,
    @Query() query: unknown
  ) {
    return this.jobsService.spoolTimeline(
      companyId,
      spoolAssetId,
      parseWithSchema(timelineQuerySchema, query)
    );
  }

  @Get("resin-tanks/:tankAssetId/timeline")
  @RequirePermission("view_orders")
  tankTimeline(
    @CompanyId() companyId: string,
    @Param("tankAssetId") tankAssetId: string,
    @Query() query: unknown
  ) {
    return this.jobsService.tankTimeline(
      companyId,
      tankAssetId,
      parseWithSchema(timelineQuerySchema, query)
    );
  }

  @Get(":pieceId/filament-plan")
  @RequirePermission("view_orders")
  filamentPlan(
    @CompanyId() companyId: string,
    @Param("pieceId") pieceId: string
  ) {
    return this.jobsService.filamentPlan(companyId, pieceId);
  }

  @Get(":pieceId")
  @RequirePermission("view_orders")
  getJob(
    @CompanyId() companyId: string,
    @Param("pieceId") pieceId: string
  ) {
    return this.jobsService.getJob(companyId, pieceId);
  }

  // ── Assignment funnel ───────────────────────────────────────
  @Post(":pieceId/candidates")
  @RequirePermission("view_orders")
  findCandidates(
    @CompanyId() companyId: string,
    @Param("pieceId") pieceId: string,
    @Body() body: unknown
  ) {
    return this.jobsService.findCandidates(
      companyId,
      pieceId,
      parseWithSchema(findCandidatesSchema, body ?? {})
    );
  }

  @Post(":pieceId/assign")
  @RequirePermission("action_orders")
  assign(
    @CompanyId() companyId: string,
    @Param("pieceId") pieceId: string,
    @Body() body: unknown
  ) {
    return this.jobsService.assign(
      companyId,
      pieceId,
      parseWithSchema(assignJobSchema, body)
    );
  }

  @Post(":pieceId/unassign")
  @RequirePermission("action_orders")
  unassign(
    @CompanyId() companyId: string,
    @Param("pieceId") pieceId: string
  ) {
    return this.jobsService.unassign(companyId, pieceId);
  }

  // Swap the assigned nozzle in place (assigned/ready pieces only). The nozzle
  // must come from the assigned printer's compatibility table.
  @Post(":pieceId/nozzle")
  @RequirePermission("action_orders")
  setNozzle(
    @CompanyId() companyId: string,
    @Param("pieceId") pieceId: string,
    @Body() body: unknown
  ) {
    return this.jobsService.setNozzle(
      companyId,
      pieceId,
      parseWithSchema(setNozzleSchema, body).nozzle_asset_id
    );
  }

  // ── Spool reservation (binds physical spool instance(s) + reserves grams) ──
  @Post(":pieceId/reserve-spools")
  @RequirePermission("action_orders")
  reserveSpools(
    @CompanyId() companyId: string,
    @Param("pieceId") pieceId: string,
    @Body() body: unknown
  ) {
    return this.jobsService.reserveSpools(
      companyId,
      pieceId,
      parseWithSchema(reserveSpoolsSchema, body ?? {})
    );
  }

  @Post(":pieceId/release-spools")
  @RequirePermission("action_orders")
  releaseSpools(
    @CompanyId() companyId: string,
    @Param("pieceId") pieceId: string
  ) {
    return this.jobsService.releaseSpools(companyId, pieceId);
  }

  // ── Scheduling ──────────────────────────────────────────────
  @Post(":pieceId/schedule")
  @RequirePermission("action_orders")
  schedule(
    @CompanyId() companyId: string,
    @Param("pieceId") pieceId: string,
    @Body() body: unknown
  ) {
    return this.jobsService.schedule(
      companyId,
      pieceId,
      parseWithSchema(scheduleJobSchema, body)
    );
  }

  @Post(":pieceId/unschedule")
  @RequirePermission("action_orders")
  unschedule(
    @CompanyId() companyId: string,
    @Param("pieceId") pieceId: string
  ) {
    return this.jobsService.unschedule(companyId, pieceId);
  }

  // ── Execution lifecycle ─────────────────────────────────────
  @Post(":pieceId/start")
  @RequirePermission("action_orders")
  start(
    @CompanyId() companyId: string,
    @Param("pieceId") pieceId: string
  ) {
    return this.jobsService.start(companyId, pieceId);
  }

  @Post(":pieceId/complete")
  @RequirePermission("action_orders")
  complete(
    @CompanyId() companyId: string,
    @Param("pieceId") pieceId: string,
    @Body() body: unknown
  ) {
    return this.jobsService.complete(
      companyId,
      pieceId,
      parseWithSchema(completeJobSchema, body)
    );
  }

  @Post(":pieceId/cancel")
  @RequirePermission("action_orders")
  cancel(
    @CompanyId() companyId: string,
    @Param("pieceId") pieceId: string
  ) {
    return this.jobsService.cancel(companyId, pieceId);
  }

  @Post(":pieceId/reprint")
  @RequirePermission("action_orders")
  reprint(
    @CompanyId() companyId: string,
    @Param("pieceId") pieceId: string
  ) {
    return this.jobsService.reprint(companyId, pieceId);
  }

  @Post(":pieceId/restore")
  @RequirePermission("action_orders")
  restore(
    @CompanyId() companyId: string,
    @Param("pieceId") pieceId: string,
    @Body() body: unknown
  ) {
    return this.jobsService.restore(
      companyId,
      pieceId,
      parseWithSchema(restoreJobSchema, body)
    );
  }

  // PATCH /api/jobs/:pieceId/files — set/replace either file independently.
  @Patch(":pieceId/files")
  @RequirePermission("action_orders")
  updateFiles(
    @CompanyId() companyId: string,
    @Param("pieceId") pieceId: string,
    @Body() body: unknown
  ) {
    return this.jobsService.updateFiles(
      companyId,
      pieceId,
      parseWithSchema(updatePieceFilesSchema, body)
    );
  }
}
