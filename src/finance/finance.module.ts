import { Module } from "@nestjs/common";
import { OrdersModule } from "../orders/orders.module";
import { FinanceController } from "./finance.controller";
import { FinanceService } from "./finance.service";
import { FinanceReportsService } from "./finance-reports.service";
import { FinanceCostingService } from "./finance-costing.service";

@Module({
  // OrdersModule provides OrderCostingService (order → invoice total + COGS).
  imports: [OrdersModule],
  controllers: [FinanceController],
  providers: [FinanceService, FinanceReportsService, FinanceCostingService],
  exports: [FinanceService]
})
export class FinanceModule {}
