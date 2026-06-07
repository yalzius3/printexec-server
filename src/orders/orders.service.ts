import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { z } from "zod";
import { recordOrderHistory } from "../common/order-history";
import { buildUpdateClause } from "../common/sql";
import { DatabaseService, type SqlExecutor } from "../database/database.service";
import {
  createOrderSchema,
  listOrderPiecesQuerySchema,
  listOrdersQuerySchema,
  updateOrderSchema
} from "./orders.schemas";

type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;
type CreateOrderInput = z.infer<typeof createOrderSchema>;
type UpdateOrderInput = z.infer<typeof updateOrderSchema>;
type ListOrderPiecesQuery = z.infer<typeof listOrderPiecesQuerySchema>;
type OrderPieceStatusSummary = {
  totalPieces: number;
  pendingPieces: number;
  assignedPieces: number;
  readyPieces: number;
  scheduledPieces: number;
  printingPieces: number;
  donePieces: number;
  failedPieces: number;
  cancelledPieces: number;
};

type OrderRow = {
  order_id: string;
  company_id: string;
  customer_id: string;
  order_number: string;
  title: string;
  description: string | null;
  priority: number;
  deadline: string;
  established_at: string;
  status: string;
  notes: string | null;
  created_at: string;
  last_updated_at: string;
  customer_type: string;
  customer_name: string | null;
  customer_deleted_at: string | null;
  piece_count: string;
  scheduled_piece_count: string;
  printable_piece_count: string;
};

@Injectable()
export class OrdersService {
  constructor(private readonly databaseService: DatabaseService) {}

  async listOrders(companyId: string, query: ListOrdersQuery) {
    const values: unknown[] = [companyId];
    const filters = ["o.company_id = $1"];

    if (query.customer_id) {
      values.push(query.customer_id);
      filters.push(`o.customer_id = $${values.length}`);
    }

    if (query.status) {
      values.push(query.status);
      filters.push(`o.status = $${values.length}`);
    }

    if (query.search) {
      values.push(`%${query.search}%`);
      filters.push(`
        (
          o.order_number ILIKE $${values.length}
          OR o.title ILIKE $${values.length}
          OR COALESCE(c.business_name, concat_ws(' ', c.first_name, c.last_name)) ILIKE $${values.length}
        )
      `);
    }

    const result = await this.databaseService.query<OrderRow>(
      `
        ${this.orderSelectSql()}
        WHERE ${filters.join(" AND ")}
        GROUP BY
          o.order_id,
          c.customer_id
        ORDER BY o.created_at DESC
      `,
      values
    );

    return result.rows;
  }

  async getOrderById(
    companyId: string,
    orderId: string,
    executor?: SqlExecutor
  ): Promise<OrderRow> {
    const result = await this.databaseService.query<OrderRow>(
      `
        ${this.orderSelectSql()}
        WHERE o.company_id = $1
          AND o.order_id = $2
        GROUP BY
          o.order_id,
          c.customer_id
      `,
      [companyId, orderId],
      executor
    );

    const row = result.rows[0];

    if (!row) {
      throw new NotFoundException("Order not found.");
    }

    return row;
  }

  async createOrder(companyId: string, input: CreateOrderInput) {
    return this.databaseService.transaction(async (client) => {
      await this.assertCustomerExists(companyId, input.customer_id, client);
      const establishedAt = input.established_at ?? new Date().toISOString().slice(0, 10);
      const orderNumber = input.order_number ?? await this.generateOrderNumber(companyId, establishedAt, client);
      await this.assertUniqueOrderNumber(companyId, orderNumber, undefined, client);

      if (input.status && input.status !== "draft") {
        throw new BadRequestException("New orders must start as draft.");
      }

      const created = await this.databaseService.query<{ order_id: string }>(
        `
          INSERT INTO orders (
            company_id,
            customer_id,
            order_number,
            title,
            description,
            priority,
            deadline,
            established_at,
            status,
            notes
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          RETURNING order_id
        `,
        [
          companyId,
          input.customer_id,
          orderNumber,
          input.title,
          input.description ?? null,
          input.priority ?? 0,
          input.deadline,
          establishedAt,
          input.status ?? "draft",
          input.notes ?? null
        ],
        client
      );

      const createdRow = created.rows[0];

      if (!createdRow) {
        throw new BadRequestException("Order insert failed.");
      }

      await this.databaseService.query(
        `
          UPDATE customers
          SET
            total_orders = total_orders + 1,
            first_order_at = COALESCE(first_order_at, now()),
            last_order_at = now()
          WHERE customer_id = $1
            AND company_id = $2
        `,
        [input.customer_id, companyId],
        client
      );

        // Log interaction for the customer timeline
      await this.databaseService.query(
        `INSERT INTO customer_interactions (company_id, customer_id, interaction_type, description)
         VALUES ($1, $2, 'ADDITION', $3)`,
        [companyId, input.customer_id, `Placed new order #${orderNumber}: ${input.title}`],
        client
      );

      await recordOrderHistory(client, companyId, {
        entityType: "order",
        eventType: "created",
        orderId: createdRow.order_id,
        orderNumber,
        description: `Order #${orderNumber} created (${input.title}).`
      });

      return this.getOrderById(companyId, createdRow.order_id, client);
    });
  }

  async updateOrder(
    companyId: string,
    orderId: string,
    input: UpdateOrderInput
  ) {
    const currentOrder = await this.getOrderById(companyId, orderId);

    if (input.order_number) {
      await this.assertUniqueOrderNumber(companyId, input.order_number, orderId);
    }

    const nextDeadline = input.deadline ?? currentOrder.deadline;
    const nextEstablishedAt = input.established_at ?? currentOrder.established_at;

    if (nextEstablishedAt > nextDeadline) {
      throw new BadRequestException("established_at cannot be later than deadline.");
    }

    const nextStatus = input.status ?? currentOrder.status;
    const cancelOpenPieces = currentOrder.status !== "cancelled" && nextStatus === "cancelled";
    const restoreCancelledPieces = currentOrder.status === "cancelled" && nextStatus !== "cancelled";
    const { clause, values } = buildUpdateClause(input);

    await this.databaseService.transaction(async (client) => {
      if (cancelOpenPieces) {
        // Leave printing/completed/failed pieces alone so we do not strand active execution.
        await this.databaseService.query(
          `
            UPDATE order_pieces
            SET status = 'cancelled'
            WHERE company_id = $1
              AND order_id = $2
              AND status IN ('pending', 'assigned', 'ready', 'scheduled')
          `,
          [companyId, orderId],
          client
        );
      }

      if (restoreCancelledPieces) {
        if (nextStatus === "draft") {
          await this.databaseService.query(
            `
              UPDATE order_pieces
              SET
                status = CASE
                  WHEN assigned_printer_id IS NOT NULL
                    AND assigned_nozzle_asset_id IS NOT NULL
                    AND slicer_file_url IS NOT NULL
                    AND slicer_print_time_minutes IS NOT NULL
                    AND slicer_filament_used_grams IS NOT NULL
                    THEN 'ready'
                  WHEN assigned_printer_id IS NOT NULL
                    THEN 'assigned'
                  ELSE 'pending'
                END,
                scheduled_at = NULL,
                scheduled_start_at = NULL,
                scheduled_end_at = NULL
              WHERE company_id = $1
                AND order_id = $2
                AND status = 'cancelled'
            `,
            [companyId, orderId],
            client
          );
        } else {
          await this.databaseService.query(
            `
              UPDATE order_pieces
              SET status = CASE
                WHEN scheduled_start_at IS NOT NULL
                  AND scheduled_end_at IS NOT NULL
                  AND assigned_printer_id IS NOT NULL
                  AND assigned_nozzle_asset_id IS NOT NULL
                  AND slicer_file_url IS NOT NULL
                  AND slicer_print_time_minutes IS NOT NULL
                  AND slicer_filament_used_grams IS NOT NULL
                  THEN 'scheduled'
                WHEN assigned_printer_id IS NOT NULL
                  AND assigned_nozzle_asset_id IS NOT NULL
                  AND slicer_file_url IS NOT NULL
                  AND slicer_print_time_minutes IS NOT NULL
                  AND slicer_filament_used_grams IS NOT NULL
                  THEN 'ready'
                WHEN assigned_printer_id IS NOT NULL
                  THEN 'assigned'
                ELSE 'pending'
              END
              WHERE company_id = $1
                AND order_id = $2
                AND status = 'cancelled'
            `,
            [companyId, orderId],
            client
          );
        }
      }

      if (nextStatus !== currentOrder.status) {
        const statusSummary = await this.getOrderPieceStatusSummary(companyId, orderId, client);
        this.assertOrderStatusChangeAllowed(nextStatus, statusSummary);
      }

      // An empty-body PATCH yields no SET columns; running `UPDATE orders SET`
      // with an empty clause is invalid SQL, so skip the write entirely (the
      // status-driven side effects above are already no-ops in that case).
      if (clause) {
        await this.databaseService.query(
          `
            UPDATE orders
            SET ${clause}
            WHERE company_id = $${values.length + 1}
              AND order_id = $${values.length + 2}
          `,
          [...values, companyId, orderId],
          client
        );
      }

      if (nextStatus !== currentOrder.status) {
        await recordOrderHistory(client, companyId, {
          entityType: "order",
          eventType: "status_changed",
          orderId,
          orderNumber: currentOrder.order_number,
          description: `Order #${currentOrder.order_number} moved from ${currentOrder.status} to ${nextStatus}.`
        });
      }
    });

    return this.getOrderById(companyId, orderId);
  }

  async listOrderPieces(
    companyId: string,
    orderId: string,
    query: ListOrderPiecesQuery
  ) {
    await this.getOrderById(companyId, orderId);

    const values: unknown[] = [companyId, orderId];
    const filters = ["op.company_id = $1", "op.order_id = $2"];

    if (query.status) {
      values.push(query.status);
      filters.push(`op.status = $${values.length}`);
    }

    if (query.assigned_printer_id) {
      values.push(query.assigned_printer_id);
      filters.push(`op.assigned_printer_id = $${values.length}`);
    }

    if (query.search) {
      values.push(`%${query.search}%`);
      filters.push(`
        (
          op.piece_name ILIKE $${values.length}
          OR op.description ILIKE $${values.length}
        )
      `);
    }

    const result = await this.databaseService.query(
      `
        SELECT
          op.*,
          COUNT(ops.piece_spool_id) AS spool_allocation_count
        FROM order_pieces op
        LEFT JOIN order_piece_spools ops
          ON ops.piece_id = op.piece_id
        WHERE ${filters.join(" AND ")}
        GROUP BY op.piece_id
        ORDER BY op.created_at DESC
      `,
      values
    );

    return result.rows;
  }

  private async assertCustomerExists(
    companyId: string,
    customerId: string,
    executor?: SqlExecutor
  ) {
    const result = await this.databaseService.query<{ deleted_at: string | null }>(
      `
        SELECT deleted_at
        FROM customers
        WHERE company_id = $1
          AND customer_id = $2
      `,
      [companyId, customerId],
      executor
    );

    const row = result.rows[0];

    if (!row) {
      throw new BadRequestException("Customer does not exist for this company.");
    }

    if (row.deleted_at) {
      throw new BadRequestException("Customer has been deleted and cannot start new orders.");
    }
  }

  private async assertUniqueOrderNumber(
    companyId: string,
    orderNumber: string,
    excludedOrderId?: string,
    executor?: SqlExecutor
  ) {
    const values: unknown[] = [companyId, orderNumber];
    let exclusionSql = "";

    if (excludedOrderId) {
      values.push(excludedOrderId);
      exclusionSql = `AND order_id <> $${values.length}`;
    }

    const result = await this.databaseService.query(
      `
        SELECT order_id
        FROM orders
        WHERE company_id = $1
          AND order_number = $2
          ${exclusionSql}
        LIMIT 1
      `,
      values,
      executor
    );

    if (result.rowCount) {
      throw new BadRequestException("order_number already exists for this company.");
    }
  }

  private async generateOrderNumber(
    companyId: string,
    establishedAt: string,
    executor?: SqlExecutor
  ) {
    const year = establishedAt.slice(0, 4);
    const prefix = `ORD-${year}-`;
    const result = await this.databaseService.query<{ max_suffix: string | null }>(
      `
        SELECT COALESCE(
          MAX(CAST(substring(order_number from '([0-9]+)$') AS integer)),
          0
        ) AS max_suffix
        FROM orders
        WHERE company_id = $1
          AND order_number ~ $2
      `,
      [companyId, `^${prefix}[0-9]+$`],
      executor
    );

    const maxSuffix = Number(result.rows[0]?.max_suffix ?? 0) || 0;
    const nextSuffix = String(maxSuffix + 1).padStart(3, "0");
    return `${prefix}${nextSuffix}`;
  }

  private orderSelectSql() {
    return `
      SELECT
        o.order_id,
        o.company_id,
        o.customer_id,
        o.order_number,
        o.title,
        o.description,
        o.priority,
        o.deadline,
        o.established_at,
        o.status,
        o.notes,
        o.created_at,
        o.last_updated_at,
        c.customer_type,
        c.deleted_at AS customer_deleted_at,
        CASE
          WHEN c.customer_type = 'b2b'
            THEN c.business_name
          ELSE concat_ws(' ', c.first_name, c.last_name)
        END AS customer_name,
        COUNT(op.piece_id) AS piece_count,
        COUNT(op.piece_id) FILTER (WHERE op.status = 'scheduled') AS scheduled_piece_count,
        COUNT(op.piece_id) FILTER (WHERE op.status IN ('ready', 'scheduled', 'printing')) AS printable_piece_count
      FROM orders o
      INNER JOIN customers c
        ON c.customer_id = o.customer_id
      LEFT JOIN order_pieces op
        ON op.order_id = o.order_id
    `;
  }

  async deleteOrder(companyId: string, orderId: string) {
    const order = await this.getOrderById(companyId, orderId);

    await this.databaseService.transaction(async (client) => {
      // Snapshot pieces before cascading so they can be logged individually.
      const pieces = await client.query<{ piece_id: string; piece_name: string }>(
        `
          SELECT piece_id, piece_name
          FROM order_pieces
          WHERE order_id = $1
            AND company_id = $2
        `,
        [orderId, companyId]
      );

      // 1. Delete spool allocations on the order's pieces.
      await client.query(`
        DELETE FROM order_piece_spools
        WHERE company_id = $1
          AND piece_id IN (
            SELECT piece_id FROM order_pieces
            WHERE order_id = $2 AND company_id = $1
          )
      `, [companyId, orderId]);

      // 2. Delete order pieces
      await client.query(`
        DELETE FROM order_pieces
        WHERE order_id = $1
          AND company_id = $2
      `, [orderId, companyId]);

      // 3. Delete the order
      await client.query(`
        DELETE FROM orders
        WHERE order_id = $1
          AND company_id = $2
      `, [orderId, companyId]);

      // 4. Update customer order count
      await client.query(`
        UPDATE customers
        SET total_orders = GREATEST(0, total_orders - 1)
        WHERE customer_id = $1
          AND company_id = $2
      `, [order.customer_id, companyId]);

      for (const piece of pieces.rows) {
        await recordOrderHistory(client, companyId, {
          entityType: "piece",
          eventType: "deleted",
          orderId: null,
          orderNumber: order.order_number,
          pieceId: null,
          pieceName: piece.piece_name,
          description: `Piece "${piece.piece_name}" removed with order #${order.order_number}.`
        });
      }

      await recordOrderHistory(client, companyId, {
        entityType: "order",
        eventType: "deleted",
        orderId: null,
        orderNumber: order.order_number,
        description: `Order #${order.order_number} deleted (${order.title}).`
      });
    });
  }

  async listHistory(
    companyId: string,
    days: number,
    entityType?: "order" | "piece"
  ) {
    const values: unknown[] = [companyId, days];
    const filters = [
      "company_id = $1",
      "created_at >= NOW() - make_interval(days => $2::int)"
    ];
    if (entityType) {
      values.push(entityType);
      filters.push(`entity_type = $${values.length}`);
    }
    const result = await this.databaseService.query(
      `
        SELECT
          history_id,
          entity_type,
          event_type,
          order_id,
          order_number,
          piece_id,
          piece_name,
          description,
          created_at
        FROM order_history
        WHERE ${filters.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT 500
      `,
      values
    );
    return result.rows;
  }

  private async getOrderPieceStatusSummary(
    companyId: string,
    orderId: string,
    executor: SqlExecutor
  ): Promise<OrderPieceStatusSummary> {
    const result = await this.databaseService.query<{
      total_piece_count: string;
      pending_piece_count: string;
      assigned_piece_count: string;
      ready_piece_count: string;
      scheduled_piece_count: string;
      printing_piece_count: string;
      done_piece_count: string;
      failed_piece_count: string;
      cancelled_piece_count: string;
    }>(
      `
        SELECT
          COUNT(*) AS total_piece_count,
          COUNT(*) FILTER (WHERE status = 'pending') AS pending_piece_count,
          COUNT(*) FILTER (WHERE status = 'assigned') AS assigned_piece_count,
          COUNT(*) FILTER (WHERE status = 'ready') AS ready_piece_count,
          COUNT(*) FILTER (WHERE status = 'scheduled') AS scheduled_piece_count,
          COUNT(*) FILTER (WHERE status = 'printing') AS printing_piece_count,
          COUNT(*) FILTER (WHERE status = 'done') AS done_piece_count,
          COUNT(*) FILTER (WHERE status = 'failed') AS failed_piece_count,
          COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_piece_count
        FROM order_pieces
        WHERE company_id = $1
          AND order_id = $2
      `,
      [companyId, orderId],
      executor
    );

    const summary = result.rows[0];

    return {
      totalPieces: Number(summary?.total_piece_count ?? 0),
      pendingPieces: Number(summary?.pending_piece_count ?? 0),
      assignedPieces: Number(summary?.assigned_piece_count ?? 0),
      readyPieces: Number(summary?.ready_piece_count ?? 0),
      scheduledPieces: Number(summary?.scheduled_piece_count ?? 0),
      printingPieces: Number(summary?.printing_piece_count ?? 0),
      donePieces: Number(summary?.done_piece_count ?? 0),
      failedPieces: Number(summary?.failed_piece_count ?? 0),
      cancelledPieces: Number(summary?.cancelled_piece_count ?? 0),
    };
  }

  private assertOrderStatusChangeAllowed(
    nextStatus: string,
    summary: OrderPieceStatusSummary
  ) {
    if (nextStatus === "cancelled") {
      return;
    }

    if (nextStatus === "draft") {
      if (summary.scheduledPieces > 0 || summary.printingPieces > 0 || summary.donePieces > 0 || summary.failedPieces > 0) {
        throw new BadRequestException(
          "Draft is only available before pieces are scheduled or started."
        );
      }
      return;
    }

    if (nextStatus === "confirmed") {
      if (summary.totalPieces === 0) {
        throw new BadRequestException("Add at least one piece before confirming the order.");
      }

      if (summary.pendingPieces > 0 || summary.assignedPieces > 0) {
        throw new BadRequestException(
          "Every piece needs complete workflow data before the order can be confirmed."
        );
      }

      if (summary.printingPieces > 0 || summary.donePieces > 0 || summary.failedPieces > 0) {
        throw new BadRequestException(
          "Orders with active or finished pieces cannot be moved back to confirmed."
        );
      }
      return;
    }

    if (nextStatus === "in_progress") {
      if (summary.printingPieces === 0) {
        throw new BadRequestException(
          "An order can only be set to in progress while at least one piece is printing."
        );
      }
      return;
    }

    if (nextStatus === "completed") {
      if (summary.totalPieces === 0) {
        throw new BadRequestException("Add at least one piece before completing the order.");
      }

      if (summary.donePieces !== summary.totalPieces) {
        throw new BadRequestException(
          "An order can only be completed when every piece is done."
        );
      }
    }
  }
}
