import { Module } from "@nestjs/common";
import { AnalyticsController } from "./analytics.controller";
import { AnalyticsService } from "./analytics.service";
import { AnalyticsAiService } from "./analytics-ai.service";

@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService, AnalyticsAiService]
})
export class AnalyticsModule {}
