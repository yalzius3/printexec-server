import { Module } from "@nestjs/common";
import { OrderAttachmentsController } from "./order-attachments.controller";
import { OrderAttachmentsService } from "./order-attachments.service";

@Module({
  controllers: [OrderAttachmentsController],
  providers: [OrderAttachmentsService],
  exports: [OrderAttachmentsService],
})
export class OrderAttachmentsModule {}
