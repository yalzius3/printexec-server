import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { z } from "zod";
import { recordOrderHistory } from "../common/order-history";
import { reevaluateBedAfterPieceRemoval, releasePrinterForPieceTx } from "../common/cascade";
import { buildUpdateClause } from "../common/sql";
import { DatabaseService, type SqlExecutor } from "../database/database.service";
import { CustomersService } from "../customers/customers.service";
import { deriveTenantCodeBase, formatOrderNumber } from "../common/tenant-code";
import { bumpOrderSequence } from "./order-number";
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
  customer_id: string | null;
  guest_name: string | null;
  guest_email: string | null;
  guest_phone: string | null;
  order_number: string;
  title: string;
  description: string | null;
  priority: number;
  deadline: string;
  established_at: string;
  status: string;
  notes: string | null;
  labor_cost: string | null;
  profit_pct: string | null;
  created_at: string;
  last_updated_at: string;
  customer_type: string | null;
  customer_name: string | null;
  customer_deleted_at: string | null;
  piece_count: string;
  scheduled_piece_count: string;
  printable_piece_count: string;
  order_cost: string | null;
  order_total: string | null;
};

@Injectable()
export class OrdersService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly customersService: CustomersService
  ) {}

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

    return this.attachInvoiceTotals(companyId, result.rows);
  }

  // Recompute each order's total to equal its invoice total — sum of every
  // piece's live cost (from its cost_inputs + company rates + order labour),
  // then × (1 + profit%). This matches the order-detail invoice exactly, even
  // when the stored per-piece `cost` snapshots are stale or missing. Best-effort:
  // on any failure we keep the SQL fallback already on each row.
  private async attachInvoiceTotals(companyId: string, orders: OrderRow[]): Promise<OrderRow[]> {
    if (orders.length === 0) return orders;
    try {
      const orderIds = orders.map((o) => o.order_id);

      // material_type → avg price/g (priced spools only). Mirrors assets pricing.
      const matRes = await this.databaseService.query<{ material_type: string; p: string | null }>(
        `SELECT fr.material_type,
                SUM(ai.purchase_price) / NULLIF(SUM(ai.initial_grams), 0) AS p
           FROM asset_instances ai
           JOIN filament_reference fr ON fr.filament_ref_id = ai.filament_ref_id
          WHERE ai.company_id = $1
            AND ai.asset_type = 'filament_spool'
            AND ai.parent_asset_id IS NULL
            AND ai.purchase_price > 0
            AND ai.initial_grams > 0
            AND fr.material_type IS NOT NULL
          GROUP BY fr.material_type`,
        [companyId]
      );
      const matMap = new Map<string, number>();
      for (const r of matRes.rows) {
        if (r.p != null && Number.isFinite(Number(r.p))) matMap.set(r.material_type, Number(r.p));
      }

      const compRes = await this.databaseService.query<{ electricity_price_per_kwh: string | null }>(
        "SELECT electricity_price_per_kwh FROM companies WHERE company_id = $1",
        [companyId]
      );
      const rateRaw = compRes.rows[0]?.electricity_price_per_kwh;
      const elecRate = rateRaw != null && rateRaw !== "" ? Number(rateRaw) : NaN;

      const pcRes = await this.databaseService.query<{
        order_id: string;
        cost: string | null;
        cost_inputs: { grams?: string[]; time?: string; failure?: string } | null;
        required_filament_material: string | null;
        requires_multicolor: boolean;
        color_slots: { slot_material: string }[] | null;
      }>(
        `SELECT op.order_id, op.cost, op.cost_inputs, op.required_filament_material, op.requires_multicolor,
                (
                  SELECT COALESCE(json_agg(json_build_object('slot_material', cs.slot_material) ORDER BY cs.sequence_order), '[]'::json)
                  FROM order_piece_color_slots cs WHERE cs.piece_id = op.piece_id
                ) AS color_slots
           FROM order_pieces op
          WHERE op.company_id = $1 AND op.order_id = ANY($2::uuid[])`,
        [companyId, orderIds]
      );

      const piecesByOrder = new Map<string, typeof pcRes.rows>();
      for (const p of pcRes.rows) {
        const list = piecesByOrder.get(p.order_id) ?? [];
        list.push(p);
        piecesByOrder.set(p.order_id, list);
      }

      const FALLBACK_WATTS = 230;
      const pieceCost = (
        p: (typeof pcRes.rows)[number],
        laborPerPiece: number,
      ): number | null => {
        const ci = p.cost_inputs;
        if (ci) {
          const minutes = Number(ci.time);
          if (Number.isFinite(minutes) && minutes > 0) {
            const grams = (ci.grams ?? []).map((g) => Number(g) || 0);
            let material = 0;
            let totalGrams = 0;
            for (let j = 0; j < grams.length; j += 1) {
              const g = grams[j] || 0;
              if (g <= 0) continue;
              totalGrams += g;
              const mat = p.requires_multicolor && p.color_slots?.[j]
                ? p.color_slots[j]!.slot_material
                : p.required_filament_material ?? undefined;
              const price = mat ? matMap.get(mat) : undefined;
              if (price != null) material += price * g;
            }
            if (totalGrams > 0) {
              const electricity = Number.isFinite(elecRate)
                ? ((FALLBACK_WATTS * minutes) / 60 / 1000) * elecRate
                : 0;
              const labor = Number.isFinite(laborPerPiece) ? laborPerPiece : 0;
              const complexity = totalGrams / minutes + 1;
              const failPct = Number(ci.failure);
              const failFactor = 1 + (Number.isFinite(failPct) ? failPct : 0) / 100;
              return (material + electricity + labor) * complexity * failFactor;
            }
          }
        }
        const stored = p.cost != null && p.cost !== "" ? Number(p.cost) : null;
        return stored != null && Number.isFinite(stored) ? stored : null;
      };

      return orders.map((o) => {
        const pieces = piecesByOrder.get(o.order_id) ?? [];
        if (pieces.length === 0) return o;
        const laborNum = o.labor_cost != null && o.labor_cost !== "" ? Number(o.labor_cost) : NaN;
        const laborPerPiece = Number.isFinite(laborNum) ? laborNum / Math.max(1, pieces.length) : NaN;
        let base = 0;
        let anyPriced = false;
        for (const p of pieces) {
          const c = pieceCost(p, laborPerPiece);
          if (c != null) {
            anyPriced = true;
            base += c;
          }
        }
        if (!anyPriced) return { ...o, order_cost: null, order_total: null };
        const profit = o.profit_pct != null && o.profit_pct !== "" ? Number(o.profit_pct) : 0;
        const total = base * (1 + (Number.isFinite(profit) ? profit : 0) / 100);
        return {
          ...o,
          order_cost: (Math.round(base * 100) / 100).toString(),
          order_total: (Math.round(total * 100) / 100).toString(),
        };
      });
    } catch {
      return orders; // keep the SQL fallback total on failure
    }
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
      // A customer is optional at creation; when present it must exist.
      if (input.customer_id) {
        await this.assertCustomerExists(companyId, input.customer_id, client);
      }
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
            guest_name,
            guest_email,
            guest_phone,
            order_number,
            title,
            description,
            priority,
            deadline,
            established_at,
            status,
            notes
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          RETURNING order_id
        `,
        [
          companyId,
          input.customer_id ?? null,
          input.guest_name ?? null,
          input.guest_email ?? null,
          input.guest_phone ?? null,
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

      // Customer stats + timeline only apply when an order is placed against a
      // customer. A customer-less order records these when one is assigned later.
      if (input.customer_id) {
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
      }

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

    // Guest-info auto-resolution: only on the transition INTO "confirmed" for
    // an order that has no customer_id yet (current or incoming) but does
    // carry guest info. Runs before the assignsCustomer/isFirstCustomerAssignment
    // logic below by mutating input.customer_id, so the resolved customer
    // flows through that existing stats/interaction-log side effect exactly
    // like a manually-picked customer_id would.
    let customerAutoCreated = false;
    const movingToConfirmed = input.status === "confirmed" && currentOrder.status !== "confirmed";
    const noCustomerYet = !input.customer_id && !currentOrder.customer_id;
    if (movingToConfirmed && noCustomerYet) {
      const guestName = input.guest_name ?? currentOrder.guest_name;
      const guestEmail = input.guest_email ?? currentOrder.guest_email;
      const guestPhone = input.guest_phone ?? currentOrder.guest_phone;
      if (guestName && (guestEmail || guestPhone)) {
        const resolved = await this.customersService.resolveOrCreateFromGuest(companyId, {
          name: guestName,
          email: guestEmail ?? null,
          phone: guestPhone ?? null
        });
        input.customer_id = resolved.customer.customer_id;
        customerAutoCreated = resolved.created;
      }
      // If guest info is genuinely absent here (only possible for legacy
      // pre-feature drafts), fall through unchanged — the existing
      // assertOrderStatusChangeAllowed / DB CHECK constraint rejects the
      // confirm attempt with a clear error, same as today.
    }

    if (input.order_number) {
      await this.assertUniqueOrderNumber(companyId, input.order_number, orderId);
    }

    // Assigning a customer (e.g. confirming an order created without one). The
    // customer must exist; the stats/timeline side-effects below run only on the
    // first assignment, mirroring createOrder so a deferred customer is counted.
    const assignsCustomer =
      input.customer_id !== undefined && input.customer_id !== currentOrder.customer_id;
    if (assignsCustomer) {
      await this.assertCustomerExists(companyId, input.customer_id as string);
    }
    const isFirstCustomerAssignment = assignsCustomer && !currentOrder.customer_id;

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

      if (isFirstCustomerAssignment) {
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

        await this.databaseService.query(
          `INSERT INTO customer_interactions (company_id, customer_id, interaction_type, description)
           VALUES ($1, $2, 'ADDITION', $3)`,
          [companyId, input.customer_id, `Placed new order #${currentOrder.order_number}: ${currentOrder.title}`],
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

    const updatedOrder = await this.getOrderById(companyId, orderId);
    return { ...updatedOrder, customer_auto_created: customerAutoCreated };
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

  // Mint the business-facing order number: <TENANT_CODE>-<YEAR>-<SEQUENCE>,
  // e.g. ABC-2026-00001. The sequence is unique per (tenant, year), resets each
  // year, and is generated atomically so concurrent creations never collide.
  // Runs on the caller's transaction (executor) so a rolled-back order also
  // rolls back the sequence bump, leaving no gap.
  private async generateOrderNumber(
    companyId: string,
    establishedAt: string,
    executor?: SqlExecutor
  ): Promise<string> {
    // Rollout guard: if the tenant-numbering migration hasn't been applied yet,
    // fall back to the legacy generator so order creation never breaks. The
    // sequences table and companies.tenant_code ship in the same migration, so
    // the table's presence implies the column exists too.
    const ready = await this.databaseService.query<{ ready: boolean }>(
      "SELECT to_regclass('public.order_number_sequences') IS NOT NULL AS ready",
      [],
      executor
    );
    if (!ready.rows[0]?.ready) {
      return this.generateLegacyOrderNumber(companyId, establishedAt, executor);
    }

    // Year of the order's establishment date (defaults to the creation date).
    const year = Number(establishedAt.slice(0, 4));
    const tenantCode = await this.resolveTenantCode(companyId, executor);

    // Bump the shared, single-source-of-truth counter so the exact atomic SQL
    // run here is the same one the integration/concurrency tests exercise (see
    // order-number.ts). Runs on the caller's transaction, so a rolled-back order
    // also rolls back the counter bump — no gaps.
    const sequence = await bumpOrderSequence(
      (sql, values) =>
        this.databaseService.query<{ last_value: string }>(sql, values, executor),
      companyId,
      year
    );
    return formatOrderNumber(tenantCode, year, sequence);
  }

  // Read the tenant's stable prefix. tenant_code is NOT NULL once the migration
  // has run; the fallback only guards a half-migrated row and keeps order
  // creation working by deriving the base code on the fly (the trigger owns
  // persistence, so we don't write it back here).
  private async resolveTenantCode(
    companyId: string,
    executor?: SqlExecutor
  ): Promise<string> {
    const result = await this.databaseService.query<{ tenant_code: string | null; name: string | null }>(
      "SELECT tenant_code, name FROM companies WHERE company_id = $1",
      [companyId],
      executor
    );
    const row = result.rows[0];
    if (!row) {
      throw new NotFoundException("Company not found.");
    }
    return row.tenant_code?.trim() || deriveTenantCodeBase(row.name);
  }

  // Pre-migration order numbering: ORD-<YEAR>-<NNN> via MAX()+1. Retained only
  // as a rollout fallback; superseded by the tenant-scoped format above once
  // 2026-07-04_tenant_order_numbering.sql is applied.
  private async generateLegacyOrderNumber(
    companyId: string,
    establishedAt: string,
    executor?: SqlExecutor
  ): Promise<string> {
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
        o.guest_name,
        o.guest_email,
        o.guest_phone,
        o.order_number,
        o.title,
        o.description,
        o.priority,
        o.deadline,
        o.established_at,
        o.status,
        o.notes,
        o.labor_cost,
        o.profit_pct,
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
        COUNT(op.piece_id) FILTER (WHERE op.status IN ('ready', 'scheduled', 'printing')) AS printable_piece_count,
        -- Fallback order cost/total (sum of stored per-piece costs; total adds
        -- profit). The list overrides these with a live recompute from each
        -- piece's cost_inputs so they equal the order's invoice figures even when
        -- stored costs are stale.
        SUM(op.cost) AS order_cost,
        SUM(op.cost) * (1 + COALESCE(o.profit_pct, 0) / 100) AS order_total
      FROM orders o
      LEFT JOIN customers c
        ON c.customer_id = o.customer_id
      LEFT JOIN order_pieces op
        ON op.order_id = o.order_id
    `;
  }

  async deleteOrder(companyId: string, orderId: string) {
    const order = await this.getOrderById(companyId, orderId);

    await this.databaseService.transaction(async (client) => {
      // Snapshot pieces before cascading so they can be logged individually.
      const pieces = await client.query<{ piece_id: string; piece_name: string; bed_id: string | null; status: string; assigned_printer_id: string | null }>(
        `
          SELECT piece_id, piece_name, bed_id, status, assigned_printer_id
          FROM order_pieces
          WHERE order_id = $1
            AND company_id = $2
        `,
        [orderId, companyId]
      );

      // 0. Release the printer lock held by any piece that is actively printing
      //    BEFORE its row is deleted. Otherwise printer_stock keeps is_in_use =
      //    TRUE with a now-dangling currently_printing_piece_id/order_id, which
      //    both strands the machine as "busy" and can trip the is_in_use CHECK
      //    constraints (chk_project_while_in_use) when the FK nulls out — a 500
      //    on the delete itself. releasePrinterForPieceTx is a no-op unless this
      //    piece actually holds the lock, so it's safe to call for every printer.
      for (const p of pieces.rows) {
        if (p.status === "printing" && p.assigned_printer_id) {
          await releasePrinterForPieceTx(client, companyId, p.assigned_printer_id, p.piece_id);
        }
      }

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

      // 2b. Re-evaluate any bed those pieces belonged to, ONCE per bed (a bed
      //     may also hold pieces from other orders): all gone → delete the bed;
      //     some kept → disassemble it. Mirrors the piece-delete cascade.
      const affectedBedIds = [
        ...new Set(pieces.rows.map((p) => p.bed_id).filter((b): b is string => !!b))
      ];
      for (const bedId of affectedBedIds) {
        await reevaluateBedAfterPieceRemoval(client, companyId, bedId);
      }

      // 3. Delete the order
      await client.query(`
        DELETE FROM orders
        WHERE order_id = $1
          AND company_id = $2
      `, [orderId, companyId]);

      // 4. Update customer order count (only when the order had a customer)
      if (order.customer_id) {
        await client.query(`
          UPDATE customers
          SET total_orders = GREATEST(0, total_orders - 1)
          WHERE customer_id = $1
            AND company_id = $2
        `, [order.customer_id, companyId]);
      }

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
      // Reopening / moving to draft is unconditional. Drafts are a
      // pre-production pricing stage and their pieces are hidden from Jobs, so
      // there's no piece-state guard.
      return;
    }

    if (nextStatus === "confirmed") {
      if (summary.totalPieces === 0) {
        throw new BadRequestException("Add at least one piece before confirming the order.");
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
