import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import { CompanyId } from "../common/company-id.decorator";
import { RequirePermission } from "../auth/permission.decorator";
import { parseWithSchema } from "../common/zod";
import { OrderAttachmentsService } from "./order-attachments.service";
import { createAttachmentSchema } from "./order-attachments.schemas";
import type { AuthRequest } from "../auth/supabase.guard";

@Controller("orders/:orderId/attachments")
export class OrderAttachmentsController {
  constructor(private readonly service: OrderAttachmentsService) {}

  @Get()
  @RequirePermission("view_orders")
  list(
    @CompanyId() companyId: string,
    @Param("orderId") orderId: string
  ) {
    return this.service.list(companyId, orderId);
  }

  @Post()
  @RequirePermission("action_orders")
  create(
    @CompanyId() companyId: string,
    @Param("orderId") orderId: string,
    @Body() body: unknown,
    @Req() req: AuthRequest
  ) {
    return this.service.create(
      companyId,
      orderId,
      parseWithSchema(createAttachmentSchema, body),
      req.userId
    );
  }

  @Delete(":attachmentId")
  @RequirePermission("action_orders")
  remove(
    @CompanyId() companyId: string,
    @Param("orderId") orderId: string,
    @Param("attachmentId") attachmentId: string
  ) {
    return this.service.remove(companyId, orderId, attachmentId);
  }
}
