import { Controller, Get, Param, Post } from "@nestjs/common";
import { CompanyId } from "../common/company-id.decorator";
import { RequirePermission } from "../auth/permission.decorator";
import { RunsService } from "./runs.service";

/**
 * Polling and cancellation for long operations. See runs.service.ts for what a
 * run is and, more importantly, what it is not.
 *
 * Reading a run needs only view_orders — an operator watching a pack finish
 * should not need the permission that started it. Cancelling is an ACTION on
 * the shop floor and needs action_orders.
 */
@Controller("runs")
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Get(":runId")
  @RequirePermission("view_orders")
  get(@CompanyId() companyId: string, @Param("runId") runId: string) {
    return this.runs.get(companyId, runId);
  }

  // Stops a run; never unwinds one. Everything already committed stays
  // committed — the counts on the row say how much that was.
  @Post(":runId/cancel")
  @RequirePermission("action_orders")
  cancel(@CompanyId() companyId: string, @Param("runId") runId: string) {
    return this.runs.cancel(companyId, runId);
  }
}
