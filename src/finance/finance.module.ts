import { Module } from "@nestjs/common";
import { EmailModule } from "../email/email.module";
import { OrdersModule } from "../orders/orders.module";
import { FinanceController } from "./finance.controller";
import { FinanceService } from "./finance.service";
import { FinanceReportsService } from "./finance-reports.service";
import { FinanceCostingService } from "./finance-costing.service";

@Module({
  // OrdersModule provides OrderCostingService (order → invoice total + COGS).
  // EmailModule provides InvoiceNotificationsService, nudged after an invoice
  // is issued so the customer is emailed their bill. One-way: EmailModule
  // depends on nothing here, so there is no cycle.
  imports: [OrdersModule, EmailModule],
  controllers: [FinanceController],
  providers: [FinanceService, FinanceReportsService, FinanceCostingService],
  exports: [FinanceService]
})
export class FinanceModule {}
