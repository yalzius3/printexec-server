import { Body, Controller, Get, Post } from "@nestjs/common";
import { z } from "zod";
import { CompanyId } from "../common/company-id.decorator";
import { RequirePermission } from "../auth/permission.decorator";
import { parseWithSchema } from "../common/zod";
import { SimpleJobsService } from "./simple-jobs.service";

const assignSchema = z.object({
  piece_ids: z.array(z.string().uuid()).min(1).max(500),
  printer_id: z.string().uuid(),
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
    const { piece_ids, printer_id } = parseWithSchema(assignSchema, body);
    return this.simpleJobsService.assign(companyId, piece_ids, printer_id);
  }
}
