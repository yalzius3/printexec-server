import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Put
} from "@nestjs/common";
import { CompanyId } from "../common/company-id.decorator";
import { RequirePermission } from "../auth/permission.decorator";
import { parseWithSchema } from "../common/zod";
import {
  duplicateOrderPieceSchema,
  listOrderPiecesQuerySchema,
  replacePieceSpoolsSchema,
  updateOrderPieceSchema
} from "../orders/orders.schemas";
import { OrderPiecesService } from "./order-pieces.service";

@Controller("order-pieces")
export class OrderPiecesController {
  constructor(private readonly orderPiecesService: OrderPiecesService) {}

  @Get()
  @RequirePermission("view_orders")
  listPieces(
    @CompanyId() companyId: string,
    @Query() query: unknown
  ) {
    return this.orderPiecesService.listPieces(
      companyId,
      parseWithSchema(listOrderPiecesQuerySchema, query)
    );
  }

  @Get(":pieceId")
  @RequirePermission("view_orders")
  getPiece(
    @CompanyId() companyId: string,
    @Param("pieceId") pieceId: string
  ) {
    return this.orderPiecesService.getPieceById(companyId, pieceId);
  }

  @Patch(":pieceId")
  @RequirePermission("action_orders")
  updatePiece(
    @CompanyId() companyId: string,
    @Param("pieceId") pieceId: string,
    @Body() body: unknown
  ) {
    return this.orderPiecesService.updatePiece(
      companyId,
      pieceId,
      parseWithSchema(updateOrderPieceSchema, body)
    );
  }

  @Delete(":pieceId")
  @RequirePermission("action_orders")
  deletePiece(
    @CompanyId() companyId: string,
    @Param("pieceId") pieceId: string,
    @Query("force") force?: string
  ) {
    // The Jobs page force-deletes regardless of status (?force=true); the
    // Orders UI omits it and keeps the terminal/closed-order guard.
    return this.orderPiecesService.deletePiece(companyId, pieceId, {
      force: force === "true" || force === "1"
    });
  }

  @Post(":pieceId/duplicate")
  @RequirePermission("action_orders")
  duplicatePiece(
    @CompanyId() companyId: string,
    @Param("pieceId") pieceId: string,
    @Body() body: unknown
  ) {
    return this.orderPiecesService.duplicatePiece(
      companyId,
      pieceId,
      parseWithSchema(duplicateOrderPieceSchema, body)
    );
  }

  @Put(":pieceId/spools")
  @RequirePermission("action_orders")
  replaceSpools(
    @CompanyId() companyId: string,
    @Param("pieceId") pieceId: string,
    @Body() body: unknown
  ) {
    return this.orderPiecesService.replaceSpoolAllocations(
      companyId,
      pieceId,
      parseWithSchema(replacePieceSpoolsSchema, body)
    );
  }

  @Delete(":pieceId/schedule")
  @RequirePermission("action_orders")
  unschedulePiece(
    @CompanyId() companyId: string,
    @Param("pieceId") pieceId: string
  ) {
    return this.orderPiecesService.unschedulePiece(companyId, pieceId);
  }
}
