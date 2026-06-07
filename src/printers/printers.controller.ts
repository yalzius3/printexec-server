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
  listPrinterReferences(@Query() query: unknown) {
    return this.printersService.listPrinterReferences(
      parseWithSchema(listPrinterReferencesQuerySchema, query)
    );
  }

  @Post("references")
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
  listNozzleOptions(@CompanyId() companyId: string) {
    return this.printersService.listNozzleOptions(companyId);
  }

  @Get()
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
  getPrinter(
    @CompanyId() companyId: string,
    @Param("printerId") printerId: string
  ) {
    return this.printersService.getPrinterById(companyId, printerId);
  }

  @Post()
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
  listNozzleCompatibility(
    @CompanyId() companyId: string,
    @Param("printerId") printerId: string
  ) {
    return this.printersService.listNozzleCompatibility(companyId, printerId);
  }

  @Post(":printerId/nozzle-compatibility")
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
  deletePrinter(
    @CompanyId() companyId: string,
    @Param("printerId") printerId: string
  ) {
    return this.printersService.deletePrinter(companyId, printerId);
  }
}
