import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { z } from "zod";
import { buildUpdateClause } from "../common/sql";
import {
  releasePieceSpoolsTx,
  reevaluateBedAfterPieceRemoval
} from "../common/cascade";
import { DatabaseService, type SqlExecutor } from "../database/database.service";
import {
  createCustomerSchema,
  listCustomersQuerySchema,
  updateCustomerSchema
} from "./customers.schemas";

type ListCustomersQuery = z.infer<typeof listCustomersQuerySchema>;
type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

type CustomerRow = {
  customer_id: string;
  company_id: string;
  customer_type: "b2b" | "b2c";
  first_name: string | null;
  last_name: string | null;
  business_name: string | null;
  tax_id: string | null;
  email: string;
  phone: string | null;
  secondary_phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  country_code: string | null;
  total_orders: number;
  first_order_at: string | null;
  last_order_at: string | null;
  is_active: boolean;
  notes: string | null;
  created_at: string;
  last_updated_at: string;
  deleted_at: string | null;
  display_name: string;
};

@Injectable()
export class CustomersService {
  constructor(private readonly databaseService: DatabaseService) { }

  async listCustomers(companyId: string, query: ListCustomersQuery) {
    const values: unknown[] = [companyId];
    const filters = ["company_id = $1"];

    if (query.customer_type) {
      values.push(query.customer_type);
      filters.push(`customer_type = $${values.length}`);
    }

    if (query.is_active !== undefined) {
      values.push(query.is_active);
      filters.push(`is_active = $${values.length}`);
    }

    if (query.search) {
      values.push(`%${query.search}%`);
      filters.push(`
        (
          COALESCE(business_name, '') ILIKE $${values.length}
          OR COALESCE(first_name, '') ILIKE $${values.length}
          OR COALESCE(last_name, '') ILIKE $${values.length}
          OR email ILIKE $${values.length}
          OR COALESCE(phone, '') ILIKE $${values.length}
        )
      `);
    }

    const result = await this.databaseService.query<CustomerRow>(
      `
        ${this.customerSelectSql()}
        WHERE ${filters.join(" AND ")}
        ORDER BY created_at DESC
      `,
      values
    );

    return result.rows;
  }

  async getCustomerById(
    companyId: string,
    customerId: string,
    executor?: SqlExecutor
  ): Promise<CustomerRow> {
    const result = await this.databaseService.query<CustomerRow>(
      `
        ${this.customerSelectSql()}
        WHERE company_id = $1
          AND customer_id = $2
      `,
      [companyId, customerId],
      executor
    );

    const row = result.rows[0];

    if (!row) {
      throw new NotFoundException("Customer not found.");
    }

    return row;
  }

  async createCustomer(companyId: string, input: CreateCustomerInput) {
    await this.assertCustomerTypeFields(input);

    // Insert the customer and record the "ADDITION" interaction atomically so a
    // failure on either side never leaves a customer without its creation log.
    return this.databaseService.transaction(async (client) => {
      const created = await this.databaseService
        .query<{ customer_id: string }>(
          `
        INSERT INTO customers (
          company_id,
          customer_type,
          first_name,
          last_name,
          business_name,
          tax_id,
          email,
          phone,
          secondary_phone,
          address_line1,
          address_line2,
          city,
          country_code,
          is_active,
          notes
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
        )
        RETURNING customer_id
      `,
          [
            companyId,
            input.customer_type,
            input.first_name ?? null,
            input.last_name ?? null,
            input.business_name ?? null,
            input.tax_id ?? null,
            input.email,
            input.phone ?? null,
            input.secondary_phone ?? null,
            input.address_line1 ?? null,
            input.address_line2 ?? null,
            input.city ?? null,
            input.country_code ?? null,
            input.is_active ?? true,
            input.notes ?? null
          ],
          client
        )
        .catch((e: unknown) => {
          // Postgres unique_violation (23505) on the per-company email index.
          // Surface a clean 409 instead of a raw 500 "Internal server error".
          if ((e as { code?: string } | null)?.code === "23505") {
            throw new ConflictException(
              `A customer with the email "${input.email}" already exists in this company.`
            );
          }
          throw e;
        });

      const row = created.rows[0];

      if (!row) {
        throw new BadRequestException("Customer insert failed.");
      }

      const customer = await this.getCustomerById(companyId, row.customer_id, client);
      await this.logInteraction(
        companyId,
        row.customer_id,
        "ADDITION",
        `Added new customer: ${customer.display_name}`,
        client
      );
      return customer;
    });
  }

  async updateCustomer(
    companyId: string,
    customerId: string,
    input: UpdateCustomerInput
  ) {
    const current = await this.getCustomerById(companyId, customerId);

    if (current.deleted_at) {
      throw new BadRequestException(
        "This customer has been deleted. Restore it before editing."
      );
    }

    const merged = {
      customer_type: input.customer_type ?? current.customer_type,
      first_name: input.first_name ?? current.first_name,
      business_name: input.business_name ?? current.business_name
    };

    await this.assertCustomerTypeFields(merged);

    const { clause, values } = buildUpdateClause(input);

    // An empty-body PATCH produces no SET columns; `UPDATE customers SET` with
    // an empty clause is invalid SQL. Nothing changed, so skip the write (and
    // the EDIT log) and return the record unchanged.
    if (!clause) {
      return this.getCustomerById(companyId, customerId);
    }

    await this.databaseService.query(
      `
        UPDATE customers
        SET ${clause}
        WHERE company_id = $${values.length + 1}
          AND customer_id = $${values.length + 2}
      `,
      [...values, companyId, customerId]
    ).catch((e: unknown) => {
      if ((e as { code?: string } | null)?.code === "23505") {
        throw new ConflictException(
          `Another customer already uses the email "${input.email ?? current.email}" in this company.`
        );
      }
      throw e;
    });

    let updateDesc = `Updated customer: ${current.display_name}`;
    if (input.is_active !== undefined) {
      updateDesc = input.is_active
        ? `Toggled ${current.display_name}'s status to Active`
        : `Toggled ${current.display_name}'s status to Inactive`;
    }
    await this.logInteraction(companyId, customerId, "EDIT", updateDesc);

    return this.getCustomerById(companyId, customerId);
  }

  async deleteCustomer(companyId: string, customerId: string) {
    const customer = await this.getCustomerById(companyId, customerId);

    if (customer.deleted_at) {
      throw new BadRequestException("Customer is already deleted.");
    }

    await this.databaseService.transaction(async (client) => {
      // 1. Identify the pieces we're about to cancel BEFORE we touch them, so
      //    we can release their spool reservations and re-evaluate any beds.
      //    We cancel every piece of the customer's active orders EXCEPT those
      //    physically in progress ('printing') or already finished ('done') —
      //    those stay as-is but remain attached to their now-cancelled order
      //    (orphaned in the real world, intact on the ERP).
      const piecesToCancel = await client.query<{ piece_id: string; bed_id: string | null }>(
        `
          SELECT op.piece_id, op.bed_id
            FROM order_pieces op
            JOIN orders o ON o.order_id = op.order_id
           WHERE o.customer_id = $1
             AND o.company_id = $2
             AND o.status NOT IN ('cancelled', 'completed')
             AND op.status NOT IN ('printing', 'done', 'cancelled', 'failed')
        `,
        [customerId, companyId]
      );

      // 2. Release reserved filament for each piece that's going away.
      for (const p of piecesToCancel.rows) {
        await releasePieceSpoolsTx(client, companyId, p.piece_id);
      }

      // 3. Cancel the customer's active (non-terminal) orders.
      await client.query(
        `
          UPDATE orders
          SET status = 'cancelled'
          WHERE customer_id = $1
            AND company_id = $2
            AND status NOT IN ('cancelled', 'completed')
        `,
        [customerId, companyId]
      );

      // 4. Cascade-cancel the eligible pieces of those orders.
      await client.query(
        `
          UPDATE order_pieces op
          SET status             = 'cancelled',
              scheduled_start_at = NULL,
              scheduled_end_at   = NULL,
              scheduled_at       = NULL
          FROM orders o
          WHERE o.order_id = op.order_id
            AND o.customer_id = $1
            AND o.company_id = $2
            AND o.status = 'cancelled'
            AND op.status NOT IN ('printing', 'done', 'cancelled', 'failed')
        `,
        [customerId, companyId]
      );

      // 5. Re-evaluate every distinct bed those pieces belonged to (all
      //    cancelled → bed cancelled; mixed with surviving printing/done →
      //    bed dismantled).
      const affectedBedIds = [
        ...new Set(piecesToCancel.rows.map((p) => p.bed_id).filter((b): b is string => !!b))
      ];
      for (const bedId of affectedBedIds) {
        await reevaluateBedAfterPieceRemoval(client, companyId, bedId);
      }

      // 6. Soft-delete the customer; row is retained so non-draft orders keep their link.
      await client.query(
        `
          UPDATE customers
          SET deleted_at = now(),
              is_active = FALSE
          WHERE customer_id = $1
            AND company_id = $2
        `,
        [customerId, companyId]
      );

      // 7. Log deletion on the customer's interaction timeline.
      await client.query(
        `INSERT INTO customer_interactions (company_id, customer_id, interaction_type, description)
         VALUES ($1, $2, 'DELETION', $3)`,
        [companyId, customerId, `Deleted customer: ${customer.display_name}`]
      );
    });

    return this.getCustomerById(companyId, customerId);
  }

  async restoreCustomer(companyId: string, customerId: string) {
    const customer = await this.getCustomerById(companyId, customerId);

    if (!customer.deleted_at) {
      return customer;
    }

    await this.databaseService.transaction(async (client) => {
      await client.query(
        `
          UPDATE customers
          SET deleted_at = NULL,
              is_active = TRUE
          WHERE customer_id = $1
            AND company_id = $2
        `,
        [customerId, companyId]
      );

      await client.query(
        `INSERT INTO customer_interactions (company_id, customer_id, interaction_type, description)
         VALUES ($1, $2, 'ACTION', $3)`,
        [companyId, customerId, `Restored customer: ${customer.display_name}`]
      );
    });

    return this.getCustomerById(companyId, customerId);
  }

  private async assertCustomerTypeFields(input: {
    customer_type: "b2b" | "b2c";
    first_name?: string | null | undefined;
    business_name?: string | null | undefined;
  }) {
    if (input.customer_type === "b2b" && !input.business_name) {
      throw new BadRequestException("business_name is required for b2b customers.");
    }

    if (input.customer_type === "b2c" && !input.first_name) {
      throw new BadRequestException("first_name is required for b2c customers.");
    }
  }

  private customerSelectSql() {
    return `
      SELECT
        customer_id,
        company_id,
        customer_type,
        first_name,
        last_name,
        business_name,
        tax_id,
        email,
        phone,
        secondary_phone,
        address_line1,
        address_line2,
        city,
        country_code,
        total_orders,
        first_order_at,
        last_order_at,
        is_active,
        notes,
        created_at,
        last_updated_at,
        deleted_at,
        CASE
          WHEN customer_type = 'b2b'
            THEN business_name
          ELSE concat_ws(' ', first_name, last_name)
        END AS display_name
      FROM customers
    `;
  }

  // ── Interaction Timeline ──────────────────────────────────────────────────

  async logInteraction(
    companyId: string,
    customerId: string,
    type: string,
    description: string,
    executor?: SqlExecutor
  ) {
    const res = await this.databaseService.query(
      `INSERT INTO customer_interactions (company_id, customer_id, interaction_type, description)
       VALUES ($1, $2, $3, $4)
       RETURNING interaction_id, interaction_type, description, created_at`,
      [companyId, customerId, type, description],
      executor
    );
    return res.rows[0];
  }

  async getInteractions(companyId: string, customerId: string) {
    const res = await this.databaseService.query(
      `SELECT interaction_id, interaction_type, description, created_at
       FROM customer_interactions
       WHERE company_id = $1 AND customer_id = $2
       ORDER BY created_at DESC`,
      [companyId, customerId]
    );
    return res.rows;
  }

  async getGlobalInteractions(companyId: string, days = 30, interactionType?: string) {
    const values: unknown[] = [companyId, days];
    const filters = [
      "ci.company_id = $1",
      "ci.created_at >= NOW() - make_interval(days => $2::int)"
    ];
    if (interactionType) {
      values.push(interactionType);
      filters.push(`ci.interaction_type = $${values.length}`);
    }

    const res = await this.databaseService.query(
      `SELECT
         ci.interaction_id,
         ci.customer_id,
         ci.interaction_type,
         ci.description,
         ci.created_at,
         CASE
           WHEN c.customer_type = 'b2b' THEN c.business_name
           ELSE concat_ws(' ', c.first_name, c.last_name)
         END AS customer_name
       FROM customer_interactions ci
       LEFT JOIN customers c ON c.customer_id = ci.customer_id
       WHERE ${filters.join(" AND ")}
       ORDER BY ci.created_at DESC
       LIMIT 100`,
      values
    );
    return res.rows;
  }
}
