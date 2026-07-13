import { Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import { RequirePermission } from "../auth/permission.decorator";
import type { AuthRequest } from "../auth/supabase.guard";
import { parseWithSchema } from "../common/zod";
import { askBodySchema, toolNameParamSchema } from "./analytics.schemas";
import { AnalyticsService } from "./analytics.service";
import { AnalyticsAiService } from "./analytics-ai.service";

// ════════════════════════════════════════════════════════════════
// /analytics — the dashboard's API surface.
//
// Route gate is view_dashboard OR view_finance (any-of, owners bypass): a
// staffer with either permission may reach the module. The finer split —
// financial tools need view_finance, production tools need view_dashboard —
// happens per-tool inside AnalyticsService.execute, because /t/:name is one
// dynamic route serving the whole registry.
// ════════════════════════════════════════════════════════════════

const DASH_PERMS = ["view_dashboard", "view_finance"];

@Controller("analytics")
export class AnalyticsController {
  constructor(
    private readonly analyticsService: AnalyticsService,
    private readonly aiService: AnalyticsAiService
  ) {}

  @Get("meta")
  @RequirePermission(DASH_PERMS)
  async meta(@Req() req: AuthRequest) {
    const meta = await this.analyticsService.meta(req.companyId, req);
    return { ...meta, ai_enabled: this.aiService.enabled() };
  }

  @Get("insights")
  @RequirePermission(DASH_PERMS)
  insights(@Req() req: AuthRequest) {
    return this.analyticsService.insights(req.companyId, req);
  }

  @Get("t/:name")
  @RequirePermission(DASH_PERMS)
  runTool(
    @Param() param: Record<string, string>,
    @Query() query: Record<string, unknown>,
    @Req() req: AuthRequest
  ) {
    const { name } = parseWithSchema(toolNameParamSchema, param);
    return this.analyticsService.execute(name, query, req.companyId, req);
  }

  @Post("ask")
  @RequirePermission(DASH_PERMS)
  ask(@Body() body: unknown, @Req() req: AuthRequest) {
    return this.aiService.ask(parseWithSchema(askBodySchema, body), req.companyId, req);
  }
}
