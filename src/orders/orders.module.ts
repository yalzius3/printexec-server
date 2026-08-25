import { Module } from "@nestjs/common";
import { OrderPiecesModule } from "../order-pieces/order-pieces.module";
import { CustomersModule } from "../customers/customers.module";
import { OrdersController } from "./orders.controller";
import { OrdersService } from "./orders.service";
import { OrderCostingService } from "./order-costing";
import { OrderFilesService } from "./order-files.service";

@Module({
  imports: [OrderPiecesModule, CustomersModule],
  controllers: [OrdersController],
  providers: [OrdersService, OrderCostingService, OrderFilesService],
  // OrderCostingService is exported so FinanceModule can price an order the
  // same way the Orders UI does (invoice-from-order + COGS basis).
  exports: [OrdersService, OrderCostingService]
})
export class OrdersModule {}
