import { Module } from "@nestjs/common";
import { BedsController } from "./beds.controller";
import { BedsService } from "./beds.service";
import { JobsModule } from "../jobs/jobs.module";

@Module({
  imports: [JobsModule],
  controllers: [BedsController],
  providers: [BedsService],
  exports: [BedsService],
})
export class BedsModule {}
