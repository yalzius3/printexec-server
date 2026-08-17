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
  listAssetBatchesQuerySchema,
  listAssetsQuerySchema,
  listAssetHistoryQuerySchema,
  listFilamentReferencesQuerySchema,
  splitAssetSchema,
  updateAssetBatchSchema,
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
  listFilamentReferences(@CompanyId() companyId: string, @Query() query: unknown) {
    return this.assetsService.listFilamentReferences(
      companyId,
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

  // Owned resin tanks with remaining/reserved millilitres — the resin
  // counterpart of /spools, read by the piece editor's tank picker.
  @Get("resin-tanks")
  @RequirePermission(["view_assets", "view_orders"])
  listResinTankInventory(@CompanyId() companyId: string) {
    return this.assetsService.listResinTankInventory(companyId);
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

  // Average resin price per ml per resin type — the resin cost path's input.
  // Same cross-module rule as material-pricing: quoting a resin job needs it.
  @Get("resin-pricing")
  @RequirePermission(["view_assets", "view_orders"])
  listResinPricing(@CompanyId() companyId: string) {
    return this.assetsService.listResinPricing(companyId);
  }

  // Aggregated insights for the Assets → Overview tab. Static path declared
  // before :assetId so it isn't swallowed as an id.
  @Get("overview")
  @RequirePermission("view_assets")
  getAssetsOverview(@CompanyId() companyId: string, @Query() query: unknown) {
    const { period } = parseWithSchema(assetsOverviewQuerySchema, query);
    return this.assetsService.getAssetsOverview(companyId, period);
  }

  // Filament intake lots, newest first. Static path — same rule as the ones
  // above: it must be declared before :assetId or "batches" parses as an id.
  @Get("batches")
  @RequirePermission("view_assets")
  listAssetBatches(@CompanyId() companyId: string, @Query() query: unknown) {
    return this.assetsService.listAssetBatches(
      companyId,
      parseWithSchema(listAssetBatchesQuerySchema, query)
    );
  }

  // Relabel a lot. Renaming is an edit to inventory records, so it takes the
  // same action permission every other asset mutation does.
  @Patch("batches/:batchId")
  @RequirePermission("action_assets")
  renameAssetBatch(
    @CompanyId() companyId: string,
    @Param("batchId") batchId: string,
    @Body() body: unknown
  ) {
    const { name } = parseWithSchema(updateAssetBatchSchema, body);
    return this.assetsService.renameAssetBatch(companyId, batchId, name);
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

  // Resin tanks. Carries the user id for the same reason spools/spare parts do:
  // a vendor-named intake books a purchase bill in Finance on their behalf.
  @Post("resin-tanks")
  @RequirePermission("action_assets")
  createResinTank(
    @CompanyId() companyId: string,
    @UserId() userId: string,
    @Body() body: unknown
  ) {
    return this.assetsService.createResinTank(
      companyId,
      userId,
      parseWithSchema(createResinTankSchema, body)
    );
  }

  // Decant an idle spool or resin tank into N children (action; the service
  // enforces eligibility and picks the unit from the asset's type).
  @Post(":assetId/split")
  @RequirePermission("action_assets")
  splitAsset(
    @CompanyId() companyId: string,
    @Param("assetId") assetId: string,
    @Body() body: unknown
  ) {
    return this.assetsService.splitAsset(
      companyId,
      assetId,
      parseWithSchema(splitAssetSchema, body)
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
