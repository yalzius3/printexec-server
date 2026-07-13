import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Delete
} from "@nestjs/common";
import { CompanyId } from "../common/company-id.decorator";
import { UserId } from "../common/user-id.decorator";
import { RequirePermission } from "../auth/permission.decorator";
import { parseWithSchema } from "../common/zod";
import {
  assetsOverviewQuerySchema,
  createFilamentReferenceSchema,
  createNozzleSchema,
  createResinTankSchema,
  createSparePartSchema,
  createSpoolSchema,
  listAssetsQuerySchema,
  listAssetHistoryQuerySchema,
  listFilamentReferencesQuerySchema,
  splitSpoolSchema,
  updateAssetSchema,
  updateAssetStockSchema
} from "./assets.schemas";
import { AssetsService } from "./assets.service";

@Controller("assets")
export class AssetsController {
  constructor(private readonly assetsService: AssetsService) {}

  // Cross-module metadata: the piece editors (orders/jobs) pick materials from
  // this catalogue, so order staff must read it without Assets access.
  @Get("filament-references")
  @RequirePermission(["view_assets", "view_orders"])
  listFilamentReferences(@Query() query: unknown) {
    return this.assetsService.listFilamentReferences(
      parseWithSchema(listFilamentReferencesQuerySchema, query)
    );
  }

  @Post("filament-references")
  @RequirePermission("action_assets")
  createFilamentReference(
    @CompanyId() companyId: string,
    @Body() body: unknown
  ) {
    return this.assetsService.createFilamentReference(
      companyId,
      parseWithSchema(createFilamentReferenceSchema, body)
    );
  }

  @Get("history")
  @RequirePermission("view_assets")
  listAssetHistory(
    @CompanyId() companyId: string,
    @Query() query: unknown
  ) {
    return this.assetsService.listAssetHistory(
      companyId,
      parseWithSchema(listAssetHistoryQuerySchema, query)
    );
  }

  @Get()
  @RequirePermission("view_assets")
  listAssets(
    @CompanyId() companyId: string,
    @Query() query: unknown
  ) {
    return this.assetsService.listAssets(
      companyId,
      parseWithSchema(listAssetsQuerySchema, query)
    );
  }

  // Owned filament spools (physical inventory) with remaining/reserved grams —
  // used by the piece editor + scheduler so the operator picks an actual spool,
  // not an abstract catalogue reference.
  @Get("spools")
  @RequirePermission(["view_assets", "view_orders"])
  listSpoolInventory(@CompanyId() companyId: string) {
    return this.assetsService.listSpoolInventory(companyId);
  }

  // Average filament price per gram per material — used by piece-cost estimates.
  // Declared before :assetId so the static path isn't swallowed as an id.
  // Cross-module metadata: quotations (orders module) are priced from this —
  // an order staff member without Assets access must still get price data.
  @Get("material-pricing")
  @RequirePermission(["view_assets", "view_orders"])
  listMaterialPricing(@CompanyId() companyId: string) {
    return this.assetsService.listMaterialPricing(companyId);
  }

  // Aggregated insights for the Assets → Overview tab. Static path declared
  // before :assetId so it isn't swallowed as an id.
  @Get("overview")
  @RequirePermission("view_assets")
  getAssetsOverview(@CompanyId() companyId: string, @Query() query: unknown) {
    const { period } = parseWithSchema(assetsOverviewQuerySchema, query);
    return this.assetsService.getAssetsOverview(companyId, period);
  }

  @Get(":assetId")
  @RequirePermission("view_assets")
  getAsset(
    @CompanyId() companyId: string,
    @Param("assetId") assetId: string
  ) {
    return this.assetsService.getAssetById(companyId, assetId);
  }

  @Post("spools")
  @RequirePermission("action_assets")
  createSpool(
    @CompanyId() companyId: string,
    @UserId() userId: string,
    @Body() body: unknown
  ) {
    return this.assetsService.createSpool(
      companyId,
      userId,
      parseWithSchema(createSpoolSchema, body)
    );
  }

  @Post("nozzles")
  @RequirePermission("action_assets")
  createNozzle(
    @CompanyId() companyId: string,
    @Body() body: unknown
  ) {
    return this.assetsService.createNozzle(
      companyId,
      parseWithSchema(createNozzleSchema, body)
    );
  }

  // Spare parts (fans, belts, …). Carries the user id because — like spools —
  // a vendor-named intake books a purchase bill in Finance on their behalf.
  @Post("spare-parts")
  @RequirePermission("action_assets")
  createSparePart(
    @CompanyId() companyId: string,
    @UserId() userId: string,
    @Body() body: unknown
  ) {
    return this.assetsService.createSparePart(
      companyId,
      userId,
      parseWithSchema(createSparePartSchema, body)
    );
  }

  @Post("resin-tanks")
  @RequirePermission("action_assets")
  createResinTank(
    @CompanyId() companyId: string,
    @Body() body: unknown
  ) {
    return this.assetsService.createResinTank(
      companyId,
      parseWithSchema(createResinTankSchema, body)
    );
  }

  // Split an idle spool into N child spools (action; service enforces eligibility).
  @Post(":assetId/split")
  @RequirePermission("action_assets")
  splitSpool(
    @CompanyId() companyId: string,
    @Param("assetId") assetId: string,
    @Body() body: unknown
  ) {
    return this.assetsService.splitSpool(
      companyId,
      assetId,
      parseWithSchema(splitSpoolSchema, body)
    );
  }

  @Patch(":assetId")
  @RequirePermission("action_assets")
  updateAsset(
    @CompanyId() companyId: string,
    @Param("assetId") assetId: string,
    @Body() body: unknown
  ) {
    return this.assetsService.updateAsset(
      companyId,
      assetId,
      parseWithSchema(updateAssetSchema, body)
    );
  }

  @Patch(":assetId/stock")
  @RequirePermission("action_assets")
  updateAssetStock(
    @CompanyId() companyId: string,
    @Param("assetId") assetId: string,
    @Body() body: unknown
  ) {
    return this.assetsService.updateAssetStock(
      companyId,
      assetId,
      parseWithSchema(updateAssetStockSchema, body)
    );
  }

  @Delete(":assetId")
  @RequirePermission("action_assets")
  deleteAsset(
    @CompanyId() companyId: string,
    @Param("assetId") assetId: string
  ) {
    return this.assetsService.deleteAsset(companyId, assetId);
  }
}
