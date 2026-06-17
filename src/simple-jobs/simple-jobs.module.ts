import { Module } from "@nestjs/common";
import { SimpleJobsController } from "./simple-jobs.controller";
import { SimpleJobsService } from "./simple-jobs.service";

@Module({
  controllers: [SimpleJobsController],
  providers: [SimpleJobsService],
})
export class SimpleJobsModule {}
