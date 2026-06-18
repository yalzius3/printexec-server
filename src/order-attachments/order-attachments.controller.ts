import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Patch,
  Req,
} from "@nestjs/common";
import { CompanyId } from "../common/company-id.decorator";
import { RequirePermission } from "../auth/permission.decorator";
import { parseWithSchema } from "../common/zod";
import { OrderAttachmentsService } from "./order-attachments.service";
import { createAttachmentSchema, updateAttachmentSchema } from "./order-attachments.schemas";
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

  @Patch(":attachmentId")
  @RequirePermission("action_orders")
  update(
    @CompanyId() companyId: string,
    @Param("orderId") orderId: string,
    @Param("attachmentId") attachmentId: string,
    @Body() body: unknown
  ) {
    return this.service.update(
      companyId,
      orderId,
      attachmentId,
      parseWithSchema(updateAttachmentSchema, body)
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
