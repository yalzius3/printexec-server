import { Module } from "@nestjs/common";
import { AnalyticsController } from "./analytics.controller";
import { AnalyticsService } from "./analytics.service";
import { AnalyticsAiService } from "./analytics-ai.service";

@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService, AnalyticsAiService],
  // Exported so the licensing admin can read/adjust a company's Lorelei
  // allowance through the one service that owns the effective-cap logic.
  exports: [AnalyticsAiService]
})
export class AnalyticsModule {}
