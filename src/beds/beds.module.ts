import { Module } from "@nestjs/common";
import { BedsController } from "./beds.controller";
import { BedsService } from "./beds.service";
import { JobsModule } from "../jobs/jobs.module";
import { FinanceModule } from "../finance/finance.module";

@Module({
  // Finance books the material lost on a partly-failed plate to the ledger
  // (BedsService.recordOutcome), exactly as it does for a single failed piece.
  // FinanceModule reaches Orders and Email, neither of which reaches back here,
  // so this stays a one-way edge.
  imports: [JobsModule, FinanceModule],
  controllers: [BedsController],
  providers: [BedsService],
  exports: [BedsService],
})
export class BedsModule {}
