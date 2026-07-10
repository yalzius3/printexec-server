import { Module } from "@nestjs/common";
import { SimpleJobsController } from "./simple-jobs.controller";
import { SimpleJobsService } from "./simple-jobs.service";
import { JobsModule } from "../jobs/jobs.module";
import { BedsModule } from "../beds/beds.module";

@Module({
  // Jobs + Beds power the auto-scheduler: placement math lives here, but the
  // actual commits go through their schedule() methods so every guard
  // (printer/nozzle/spool overlap, past-check, status) applies unchanged.
  imports: [JobsModule, BedsModule],
  controllers: [SimpleJobsController],
  providers: [SimpleJobsService],
})
export class SimpleJobsModule {}
