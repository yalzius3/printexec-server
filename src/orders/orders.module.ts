import { Module } from "@nestjs/common";
import { OrderPiecesModule } from "../order-pieces/order-pieces.module";
import { CustomersModule } from "../customers/customers.module";
import { OrdersController } from "./orders.controller";
import { OrdersService } from "./orders.service";
import { OrderCostingService } from "./order-costing";

@Module({
  imports: [OrderPiecesModule, CustomersModule],
  controllers: [OrdersController],
  providers: [OrdersService, OrderCostingService],
  // OrderCostingService is exported so FinanceModule can price an order the
  // same way the Orders UI does (invoice-from-order + COGS basis).
  exports: [OrdersService, OrderCostingService]
})
export class OrdersModule {}
