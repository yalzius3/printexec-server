import { Module } from "@nestjs/common";
import { OrderPiecesModule } from "../order-pieces/order-pieces.module";
import { CustomersModule } from "../customers/customers.module";
import { OrdersController } from "./orders.controller";
import { OrdersService } from "./orders.service";

@Module({
  imports: [OrderPiecesModule, CustomersModule],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService]
})
export class OrdersModule {}
