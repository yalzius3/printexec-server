import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query
} from "@nestjs/common";
import { CompanyId } from "../common/company-id.decorator";
import { RequirePermission } from "../auth/permission.decorator";
import { parseWithSchema } from "../common/zod";
import {
  addCompatibleNozzleSchema,
  createPrinterReferenceSchema,
  createPrinterSchema,
  listPrinterReferencesQuerySchema,
  listPrintersQuerySchema,
  updatePrinterSchema,
  updatePrinterStockSchema
} from "./printers.schemas";
import { PrintersService } from "./printers.service";

@Controller("printers")
export class PrintersController {
  constructor(private readonly printersService: PrintersService) {}

  @Get("references")
  @RequirePermission(["view_assets", "view_orders"])
  listPrinterReferences(@Query() query: unknown) {
    return this.printersService.listPrinterReferences(
      parseWithSchema(listPrinterReferencesQuerySchema, query)
    );
  }

  @Post("references")
  @RequirePermission("action_assets")
  createPrinterReference(
    @CompanyId() companyId: string,
    @Body() body: unknown
  ) {
    return this.printersService.createPrinterReference(
      companyId,
      parseWithSchema(createPrinterReferenceSchema, body)
    );
  }

  @Get("nozzle-options")
  @RequirePermission(["view_assets", "view_orders"])
  listNozzleOptions(@CompanyId() companyId: string) {
    return this.printersService.listNozzleOptions(companyId);
  }

  @Get()
  @RequirePermission(["view_assets", "view_orders"])
  listPrinters(
    @CompanyId() companyId: string,
    @Query() query: unknown
  ) {
    return this.printersService.listPrinters(
      companyId,
      parseWithSchema(listPrintersQuerySchema, query)
    );
  }

  @Get(":printerId")
  @RequirePermission(["view_assets", "view_orders"])
  getPrinter(
    @CompanyId() companyId: string,
    @Param("printerId") printerId: string
  ) {
    return this.printersService.getPrinterById(companyId, printerId);
  }

  @Post()
  @RequirePermission("action_assets")
  createPrinter(
    @CompanyId() companyId: string,
    @Body() body: unknown
  ) {
    return this.printersService.createPrinter(
      companyId,
      parseWithSchema(createPrinterSchema, body)
    );
  }

  @Patch(":printerId")
  @RequirePermission("action_assets")
  updatePrinter(
    @CompanyId() companyId: string,
    @Param("printerId") printerId: string,
    @Body() body: unknown
  ) {
    return this.printersService.updatePrinter(
      companyId,
      printerId,
      parseWithSchema(updatePrinterSchema, body)
    );
  }

  @Patch(":printerId/stock")
  @RequirePermission("action_assets")
  updatePrinterStock(
    @CompanyId() companyId: string,
    @Param("printerId") printerId: string,
    @Body() body: unknown
  ) {
    return this.printersService.updatePrinterStock(
      companyId,
      printerId,
      parseWithSchema(updatePrinterStockSchema, body)
    );
  }

  @Get(":printerId/nozzle-compatibility")
  @RequirePermission(["view_assets", "view_orders"])
  listNozzleCompatibility(
    @CompanyId() companyId: string,
    @Param("printerId") printerId: string
  ) {
    return this.printersService.listNozzleCompatibility(companyId, printerId);
  }

  @Post(":printerId/nozzle-compatibility")
  @RequirePermission("action_assets")
  addNozzleCompatibility(
    @CompanyId() companyId: string,
    @Param("printerId") printerId: string,
    @Body() body: unknown
  ) {
    return this.printersService.addNozzleCompatibility(
      companyId,
      printerId,
      parseWithSchema(addCompatibleNozzleSchema, body)
    );
  }

  @Delete(":printerId/nozzle-compatibility/:nozzleAssetId")
  @RequirePermission("action_assets")
  removeNozzleCompatibility(
    @CompanyId() companyId: string,
    @Param("printerId") printerId: string,
    @Param("nozzleAssetId") nozzleAssetId: string
  ) {
    return this.printersService.removeNozzleCompatibility(
      companyId,
      printerId,
      nozzleAssetId
    );
  }

  @Delete(":printerId")
  @RequirePermission("action_assets")
  deletePrinter(
    @CompanyId() companyId: string,
    @Param("printerId") printerId: string
  ) {
    return this.printersService.deletePrinter(companyId, printerId);
  }
}
