import { Controller, Get } from "@nestjs/common";
import type { HealthStatus } from "@xyz/shared";
import { DatabaseService } from "../database/database.service";
import { Public } from "../auth/public.decorator";

@Controller("health")
export class HealthController {
  constructor(private readonly databaseService: DatabaseService) {}

  @Public()
  @Get()
  async getHealth(): Promise<HealthStatus> {
    await this.databaseService.ping();

    return {
      status: "ok",
      service: "xyz-api",
      timestamp: new Date().toISOString()
    };
  }
}
