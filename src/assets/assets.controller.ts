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
import { RequirePermission } from "../auth/permission.decorator";
import { parseWithSchema } from "../common/zod";
import {
  createFilamentReferenceSchema,
  createNozzleSchema,
  createResinTankSchema,
  createSpoolSchema,
  listAssetsQuerySchema,
  listAssetHistoryQuerySchema,
  listFilamentReferencesQuerySchema,
  updateAssetSchema,
  updateAssetStockSchema
} from "./assets.schemas";
import { AssetsService } from "./assets.service";

@Controller("assets")
export class AssetsController {
  constructor(private readonly assetsService: AssetsService) {}

  @Get("filament-references")
  @RequirePermission("view_assets")
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
  @RequirePermission("view_assets")
  listSpoolInventory(@CompanyId() companyId: string) {
    return this.assetsService.listSpoolInventory(companyId);
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
    @Body() body: unknown
  ) {
    return this.assetsService.createSpool(
      companyId,
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
