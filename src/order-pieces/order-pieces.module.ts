import { Module } from "@nestjs/common";
import { OrderPiecesController } from "./order-pieces.controller";
import { OrderPiecesService } from "./order-pieces.service";

@Module({
  controllers: [OrderPiecesController],
  providers: [OrderPiecesService],
  exports: [OrderPiecesService]
})
export class OrderPiecesModule {}
