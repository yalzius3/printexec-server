import { Module } from "@nestjs/common";
import { FinanceController } from "./finance.controller";
import { FinanceService } from "./finance.service";
import { FinanceReportsService } from "./finance-reports.service";

@Module({
  controllers: [FinanceController],
  providers: [FinanceService, FinanceReportsService],
  exports: [FinanceService]
})
export class FinanceModule {}
