import { Module } from "@nestjs/common";
import { SimpleJobsController } from "./simple-jobs.controller";
import { SimpleJobsService } from "./simple-jobs.service";
import { JobsModule } from "../jobs/jobs.module";
import { BedsModule } from "../beds/beds.module";
import { FinanceModule } from "../finance/finance.module";
import { RunsModule } from "../runs/runs.module";

@Module({
  // Jobs + Beds power the auto-scheduler: placement math lives here, but the
  // actual commits go through their schedule() methods so every guard
  // (printer/nozzle/spool overlap, past-check, status) applies unchanged.
  // Finance books measured failed-print waste to the ledger (markFailed).
  // Runs carries progress + cancellation for a fleet pack too large to be one
  // request; the packing itself is untouched by it.
  imports: [JobsModule, BedsModule, FinanceModule, RunsModule],
  controllers: [SimpleJobsController],
  providers: [SimpleJobsService],
})
export class SimpleJobsModule {}
