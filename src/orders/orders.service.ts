import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { z } from "zod";
import { recordOrderHistory } from "../common/order-history";
import { purgeOrderTx, type OrderPurgeResult } from "./order-purge";
import { OrderFilesService } from "./order-files.service";
import { reevaluateBedAfterPieceRemoval, releasePrinterForPieceTx } from "../common/cascade";
import { buildUpdateClause } from "../common/sql";
import { DatabaseService, type SqlExecutor } from "../database/database.service";
import { CustomersService } from "../customers/customers.service";
import { OrderCostingService } from "./order-costing";
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
  costing_preset_id: string | null;
  costing_config: Record<string, unknown> | null;
  order_cost: string | null;
  order_total: string | null;
  // Assigned personnel: the id lives on orders, the label comes from the LEFT
  // JOIN on users and is already coalesced to the email when the member has no
  // display name (see the SELECT). Both are null when nobody is assigned — and
  // also when the assignee's account was deleted, because the FK nulls the id,
  // so "no name" and "no owner" are always the same state.
  assigned_personnel_id: string | null;
  assigned_personnel_name: string | null;
};

@Injectable()
export class OrdersService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly customersService: CustomersService,
    private readonly orderCosting: OrderCostingService,
    private readonly orderFiles: OrderFilesService
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
          c.customer_id,
          -- u.id is the users PK, so grouping on it makes every u.* column above
          -- functionally dependent and legal to select. Without it the two
          -- personnel display columns are a grouping error, not a silent null.
          u.id
        ORDER BY o.created_at DESC
      `,
      values
    );

    return this.attachInvoiceTotals(companyId, result.rows);
  }

  // Recompute each order's total to equal its invoice total, via the SAME shared
  // costing service the invoice is built from: it evaluates the order's preset
  // formula (or the legacy base × (1 + profit%) when no preset is set) from each
  // piece's live cost_inputs + company rates + order labour. Routing the list
  // through it (rather than a re-derivation here) keeps the list total, the
  // order-detail total and the eventual invoice byte-identical. Best-effort: on
  // any failure we keep the SQL fallback already on each row.
  private async attachInvoiceTotals(companyId: string, orders: OrderRow[]): Promise<OrderRow[]> {
    if (orders.length === 0) return orders;
    try {
      const totals = await this.orderCosting.computeTotalsForOrders(
        companyId,
        orders.map((o) => o.order_id)
      );
      return orders.map((o) => {
        const t = totals.get(o.order_id);
        if (!t) return o; // no pieces → keep the SQL fallback already on the row
        if (!t.priced) return { ...o, order_cost: null, order_total: null };
        return {
          ...o,
          order_cost: (t.baseCents / 100).toString(),
          order_total: (t.totalCents / 100).toString()
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
          c.customer_id,
          -- u.id: see the note on the list query's GROUP BY above.
          u.id
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

  // Per-material print waste for one order: the quantity scrapped + the money it
  // cost, valued at the unit cost snapshotted when each failed print was
  // recorded. Drives the small "material wasted" line in the order detail
  // (quantity ⇄ money toggle).
  //
  // filament_waste_events stores grams AND millilitres in one column,
  // discriminated by `unit` (see FinanceService.bookMaterialWaste), so the two are
  // summed separately and reported side by side. A row carries one or the other,
  // never both — a material is either filament or resin. `unit` on each row lets
  // the client label it without inferring anything.
  async getOrderWaste(companyId: string, orderId: string) {
    const result = await this.databaseService.query<{
      material_type: string | null;
      unit: string | null;
      grams: string;
      resin_ml: string;
      cost: string;
    }>(
      `SELECT material_type,
              MIN(unit) AS unit,
              COALESCE(SUM(grams) FILTER (WHERE unit = 'g'), 0)  AS grams,
              COALESCE(SUM(grams) FILTER (WHERE unit = 'ml'), 0) AS resin_ml,
              COALESCE(SUM(cost), 0)                             AS cost
         FROM filament_waste_events
        WHERE company_id = $1 AND order_id = $2
        GROUP BY material_type
       HAVING SUM(grams) > 0
        -- Cost, not quantity: grams and millilitres aren't comparable, so ranking
        -- a mixed-technology order by the shared quantity column would be arbitrary.
        ORDER BY cost DESC`,
      [companyId, orderId]
    );
    const byMaterial = result.rows.map((r) => ({
      material_type: r.material_type,
      unit: r.unit ?? "g",
      grams: Number(r.grams) || 0,
      resin_ml: Number(r.resin_ml) || 0,
      cost: Number(r.cost) || 0
    }));
    return {
      by_material: byMaterial,
      total_grams: byMaterial.reduce((s, r) => s + r.grams, 0),
      total_resin_ml: byMaterial.reduce((s, r) => s + r.resin_ml, 0),
      total_cost: byMaterial.reduce((s, r) => s + r.cost, 0)
    };
  }

  async createOrder(companyId: string, input: CreateOrderInput) {
    return this.databaseService.transaction(async (client) => {
      // A customer is optional at creation; when present it must exist.
      if (input.customer_id) {
        await this.assertCustomerExists(companyId, input.customer_id, client);
      }
      // Same for personnel: optional, but if named they must be on this team.
      if (input.assigned_personnel_id) {
        await this.assertPersonnelExists(companyId, input.assigned_personnel_id, client);
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
            notes,
            assigned_personnel_id
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
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
          input.notes ?? null,
          input.assigned_personnel_id ?? null
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

    // Reassigning the order's owner. `undefined` = the PATCH said nothing about
    // personnel and the current value stands; `null` = explicitly unassign.
    // Only a real id needs checking, and the check returns the name so the
    // history line can say WHO rather than print a uuid at the operator.
    const reassignsPersonnel =
      input.assigned_personnel_id !== undefined &&
      input.assigned_personnel_id !== currentOrder.assigned_personnel_id;
    let nextPersonnelName: string | null = null;
    if (reassignsPersonnel && input.assigned_personnel_id) {
      nextPersonnelName = await this.assertPersonnelExists(
        companyId,
        input.assigned_personnel_id
      );
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
        // "Everything this piece's TECHNOLOGY needs to print", as one SQL
        // fragment shared by both branches below. Spelled out per technology
        // because the FDM shape — nozzle + filament grams — is permanently
        // false for a resin piece, which has neither: written that way, every
        // restored resin piece dropped to 'assigned' and had to be walked back
        // through a data step it had already completed.
        const pieceComplete = `
          assigned_printer_id IS NOT NULL
          AND slicer_file_url IS NOT NULL
          AND slicer_print_time_minutes IS NOT NULL
          AND CASE WHEN required_print_technology IN ('MSLA', 'SLA') THEN
                slicer_resin_used_ml IS NOT NULL AND resin_tank_id IS NOT NULL
              ELSE
                assigned_nozzle_asset_id IS NOT NULL AND slicer_filament_used_grams IS NOT NULL
              END`;
        if (nextStatus === "draft") {
          await this.databaseService.query(
            `
              UPDATE order_pieces
              SET
                status = CASE
                  WHEN ${pieceComplete} THEN 'ready'
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
                  AND ${pieceComplete}
                  THEN 'scheduled'
                WHEN ${pieceComplete}
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

      // A handover is a real event in the life of an order — who is answerable
      // for it changed — so it lands in the same history the status moves do.
      if (reassignsPersonnel) {
        const from = currentOrder.assigned_personnel_name ?? "nobody";
        const to = nextPersonnelName ?? "nobody";
        await recordOrderHistory(client, companyId, {
          entityType: "order",
          eventType: "personnel_assigned",
          orderId,
          orderNumber: currentOrder.order_number,
          description: `Order #${currentOrder.order_number} reassigned from ${from} to ${to}.`
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

  // Assigned personnel must be an employee OF THIS COMPANY. The FK on the
  // column only proves the users row exists — it says nothing about which
  // tenant it belongs to — so this is the guard that makes a cross-tenant
  // assigned_personnel_id impossible, exactly as assertCustomerExists does for
  // customer_id on the same table. Both create and update route through it.
  //
  // Returns the display name so the caller can write a history line naming the
  // person, without a second round trip.
  private async assertPersonnelExists(
    companyId: string,
    personnelId: string,
    executor?: SqlExecutor
  ): Promise<string> {
    const result = await this.databaseService.query<{ display_name: string | null; email: string }>(
      `
        SELECT display_name, email
        FROM users
        WHERE company_id = $1
          AND id = $2
      `,
      [companyId, personnelId],
      executor
    );

    const row = result.rows[0];

    if (!row) {
      throw new BadRequestException("That person is not an employee of this company.");
    }

    // display_name is nullable on users (a member who has never set one), so the
    // email is the fallback label — the same order the staff screen uses.
    return row.display_name ?? row.email;
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
        o.costing_preset_id,
        o.costing_config,
        o.assigned_personnel_id,
        -- A DISPLAY LABEL, not a raw column — the same shape customer_name
        -- above already has. users.display_name is NULLABLE (a member who never
        -- set one, which is every member who joined by invite and skipped it),
        -- so selecting it raw would hand the client a null for somebody who is
        -- very much assigned, and every render site would have to remember the
        -- email fallback independently. One COALESCE here means no client can
        -- get it wrong. NULLIF(btrim(...)) so a display name of spaces falls
        -- back too, rather than rendering as a blank cell.
        COALESCE(NULLIF(btrim(u.display_name), ''), u.email) AS assigned_personnel_name,
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
      -- Assigned personnel. Scoped by company_id as well as id: the FK only
      -- guarantees the user EXISTS, so if a cross-tenant id ever reached the
      -- column this join refuses to render a name for it rather than leaking
      -- another company's employee into this company's order list.
      LEFT JOIN users u
        ON u.id = o.assigned_personnel_id
       AND u.company_id = o.company_id
      LEFT JOIN order_pieces op
        ON op.order_id = o.order_id
    `;
  }

  /**
   * CANCEL AND DELETE — erase an order completely.
   *
   * Distinct from deleteOrder below, and the difference is the point. That one
   * ends an order and keeps the paper: the invoice survives flagged with
   * order_deleted_at, a "deleted" breadcrumb goes into the history, the files
   * stay in the bucket. This one leaves nothing — rows, files and the financial
   * record all go, and nothing afterwards shows the order existed.
   *
   * The cancel half is not a separate step and deliberately so. Setting
   * status='cancelled' first would fire the piece-cancellation cascade, the
   * status-change history row and the customer shipping-stage sweep, and every
   * one of those writes would then have to be erased again by the purge two
   * statements later. The order is being destroyed; there is no state left for
   * it to be in. What the operator means by "cancel and delete" — this work is
   * off, and it leaves no trace — is exactly what the purge does on its own.
   *
   * ONE TRANSACTION for every row, so a failure anywhere leaves the order fully
   * intact rather than half-erased. Storage bytes go afterwards, because a
   * bucket delete cannot be rolled back and doing it inside would destroy files
   * for an order that a later failure leaves standing.
   */
  async cancelAndDeleteOrder(
    companyId: string,
    orderId: string
  ): Promise<OrderPurgeResult & { files_removed: number; files_orphaned: boolean }> {
    // 404s if it does not exist or belongs to another company — the tenant
    // check that has to happen before anything destructive.
    const order = await this.getOrderById(companyId, orderId);

    const result = await this.databaseService.transaction((client) =>
      purgeOrderTx(client, companyId, orderId, {
        order_number: order.order_number,
        title: order.title,
        customer_id: order.customer_id
      })
    );

    // Committed: the order is gone whatever happens next. removeObjects never
    // throws for that reason — see the note on it.
    const files = await this.orderFiles.removeObjects(result.storage_keys);

    return { ...result, files_removed: files.removed, files_orphaned: files.failed };
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

      // 2c. Mark any invoice billing this order BEFORE the row disappears.
      //     invoices.order_id is ON DELETE SET NULL, so a moment from now the
      //     link is gone for good — an accountant would be left with a
      //     receivable for work that no longer exists and no way to tell. The
      //     number snapshot is what the Finance UI shows the marker from
      //     (COALESCE so an invoice predating the snapshot column still gets
      //     one); order_deleted_at records when. The invoice is deliberately
      //     NOT auto-voided: only a human should decide that, and a posted
      //     invoice may well be legitimately owed regardless.
      await client.query(`
        UPDATE invoices
        SET order_number_snapshot = COALESCE(order_number_snapshot, $3),
            order_deleted_at = NOW(),
            updated_at = NOW()
        WHERE company_id = $2
          AND order_id = $1
      `, [orderId, companyId, order.order_number]);

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
