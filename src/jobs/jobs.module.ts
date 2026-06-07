import { Module } from "@nestjs/common";
import { JobsController } from "./jobs.controller";
import { JobsService } from "./jobs.service";
import { TimeStateService } from "./time-state.service";

@Module({
  controllers: [JobsController],
  providers: [JobsService, TimeStateService],
  exports: [JobsService],
})
export class JobsModule {}
