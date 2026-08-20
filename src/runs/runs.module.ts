import { Module, type OnModuleInit } from "@nestjs/common";
import { RunsController } from "./runs.controller";
import { RunsService } from "./runs.service";

@Module({
  controllers: [RunsController],
  providers: [RunsService],
  // Exported because the services that DO long work start their own runs —
  // SimpleJobsService for the fleet-wide pack. The run machinery owns progress
  // and cancellation; it never owns the work.
  exports: [RunsService],
})
export class RunsModule implements OnModuleInit {
  constructor(private readonly runs: RunsService) {}

  /** Any run still marked 'running' at boot belongs to a process that is gone.
   *  Sweeping it to 'failed' is what stops a dead run sitting on an operator's
   *  screen claiming to be in progress. Best-effort: a sweep failure must not
   *  stop the API from starting. */
  async onModuleInit(): Promise<void> {
    await this.runs.sweepStale().catch(() => undefined);
  }
}
