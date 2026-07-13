import { Module } from "@nestjs/common";
import { FinanceModule } from "../finance/finance.module";
import { AssetsController } from "./assets.controller";
import { AssetsService } from "./assets.service";

@Module({
  // FinanceModule provides FinanceService so adding a spool with a vendor name
  // can auto-record the itemized filament-purchase bill.
  imports: [FinanceModule],
  controllers: [AssetsController],
  providers: [AssetsService],
  exports: [AssetsService]
})
export class AssetsModule {}
