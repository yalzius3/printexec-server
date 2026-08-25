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
import { OrderPiecesService } from "../order-pieces/order-pieces.service";
import {
  createOrderPieceSchema,
  bulkCreateOrderPiecesSchema,
  createOrderSchema,
  listOrderPiecesQuerySchema,
  listOrdersQuerySchema,
  updateOrderSchema
} from "./orders.schemas";
import { OrdersService } from "./orders.service";

@Controller("orders")
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly orderPiecesService: OrderPiecesService
  ) {}

  @Get()
  @RequirePermission("view_orders")
  listOrders(
    @CompanyId() companyId: string,
    @Query() query: unknown
  ) {
    return this.ordersService.listOrders(
      companyId,
      parseWithSchema(listOrdersQuerySchema, query)
    );
  }

  @Get("history")
  @RequirePermission("view_orders")
  listHistory(
    @CompanyId() companyId: string,
    @Query("days") daysRaw?: string,
    @Query("entity_type") entityType?: string
  ) {
    const days = Math.max(1, Math.min(365, Number(daysRaw ?? 30) || 30));
    const normalizedEntity = entityType === "order" || entityType === "piece" ? entityType : undefined;
    return this.ordersService.listHistory(companyId, days, normalizedEntity);
  }

  @Get(":orderId")
  @RequirePermission("view_orders")
  getOrder(
    @CompanyId() companyId: string,
    @Param("orderId") orderId: string
  ) {
    return this.ordersService.getOrderById(companyId, orderId);
  }

  // Filament wasted on this order's failed prints, per material (grams + the
  // cost snapshotted when each loss was recorded). Its own endpoint so the core
  // order shape stays untouched and the detail view can lazy-load it.
  @Get(":orderId/waste")
  @RequirePermission("view_orders")
  getOrderWaste(
    @CompanyId() companyId: string,
    @Param("orderId") orderId: string
  ) {
    return this.ordersService.getOrderWaste(companyId, orderId);
  }

  @Post()
  @RequirePermission("action_orders")
  createOrder(
    @CompanyId() companyId: string,
    @Body() body: unknown
  ) {
    return this.ordersService.createOrder(
      companyId,
      parseWithSchema(createOrderSchema, body)
    );
  }

  @Patch(":orderId")
  @RequirePermission("action_orders")
  updateOrder(
    @CompanyId() companyId: string,
    @Param("orderId") orderId: string,
    @Body() body: unknown
  ) {
    return this.ordersService.updateOrder(
      companyId,
      orderId,
      parseWithSchema(updateOrderSchema, body)
    );
  }

  @Get(":orderId/pieces")
  @RequirePermission("view_orders")
  listOrderPieces(
    @CompanyId() companyId: string,
    @Param("orderId") orderId: string,
    @Query() query: unknown
  ) {
    return this.ordersService.listOrderPieces(
      companyId,
      orderId,
      parseWithSchema(listOrderPiecesQuerySchema, query)
    );
  }

  @Post(":orderId/pieces")
  @RequirePermission("action_orders")
  createOrderPiece(
    @CompanyId() companyId: string,
    @Param("orderId") orderId: string,
    @Body() body: unknown
  ) {
    return this.orderPiecesService.createPiece(
      companyId,
      orderId,
      parseWithSchema(createOrderPieceSchema, body)
    );
  }

  /**
   * Create many pieces in one transaction, with one order-status recompute.
   *
   * The single-piece route above stays for every other caller. This exists for
   * the bulk grid, which used to fire one request per row: each of those ran a
   * full order-status recompute, so adding N pieces was O(N²) — and 80,000 rows
   * also exceeded the browser's socket pool long before the database gave up.
   *
   * Capped at 500 per call, matching order-pieces' bulk-delete. The cap is what
   * keeps one transaction short enough not to hold locks on order_pieces while
   * the shop floor is trying to work; the client sends several batches in
   * sequence for anything larger.
   */
  @Post(":orderId/pieces/bulk")
  @RequirePermission("action_orders")
  createOrderPiecesBulk(
    @CompanyId() companyId: string,
    @Param("orderId") orderId: string,
    @Body() body: unknown
  ) {
    const { pieces } = parseWithSchema(bulkCreateOrderPiecesSchema, body);
    return this.orderPiecesService.createPieces(companyId, orderId, pieces);
  }

  @Delete(":orderId")
  @RequirePermission("action_orders")
  deleteOrder(
    @CompanyId() companyId: string,
    @Param("orderId") orderId: string
  ) {
    return this.ordersService.deleteOrder(companyId, orderId);
  }

  /**
   * Cancel and delete: erase the order completely — rows, files, and its
   * financial record. There is no undo and nothing is left to find afterwards.
   *
   * A POST on its own path rather than a flag on the DELETE above, because the
   * two are different operations with different consequences and a client
   * should have to name which one it means. A query parameter on DELETE would
   * make total erasure one typo away from the ordinary delete.
   *
   * Same action_orders permission as DELETE. Deliberately not a new, stronger
   * one: inventing a permission here would lock it away from the operators who
   * already hold full destructive rights over orders, and the guard that
   * actually matters for something irreversible is the confirmation in front of
   * it, not a role nobody has been granted yet.
   */
  @Post(":orderId/cancel-and-delete")
  @RequirePermission("action_orders")
  cancelAndDeleteOrder(
    @CompanyId() companyId: string,
    @Param("orderId") orderId: string
  ) {
    return this.ordersService.cancelAndDeleteOrder(companyId, orderId);
  }
}

