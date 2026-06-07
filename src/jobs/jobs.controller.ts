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
} from "./jobs.schemas";

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
