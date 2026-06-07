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

  @Delete(":orderId")
  @RequirePermission("action_orders")
  deleteOrder(
    @CompanyId() companyId: string,
    @Param("orderId") orderId: string
  ) {
    return this.ordersService.deleteOrder(companyId, orderId);
  }
}

