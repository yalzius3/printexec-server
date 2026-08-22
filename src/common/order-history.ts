import type { SqlExecutor } from "../database/database.service";

export type OrderHistoryEntityType = "order" | "piece";

export type OrderHistoryEvent = {
  entityType: OrderHistoryEntityType;
  eventType: string;
  description: string;
  orderId?: string | null;
  orderNumber?: string | null;
  pieceId?: string | null;
  pieceName?: string | null;
};

export async function recordOrderHistory(
  executor: SqlExecutor,
  companyId: string,
  event: OrderHistoryEvent
): Promise<void> {
  await executor.query(
    `
      INSERT INTO order_history (
        company_id,
        entity_type,
        event_type,
        order_id,
        order_number,
        piece_id,
        piece_name,
        description
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
    [
      companyId,
      event.entityType,
      event.eventType,
      event.orderId ?? null,
      event.orderNumber ?? null,
      event.pieceId ?? null,
      event.pieceName ?? null,
      event.description
    ]
  );
}

/**
 * Write many history entries in ONE statement.
 *
 * Same columns and same semantics as `recordOrderHistory` — this exists purely
 * because some events are inherently plural. Triaging a print plate can settle
 * several hundred pieces at once, and a loop of single-row inserts inside that
 * transaction is several hundred round trips against a database that is not in
 * the same region as the API. Callers with one event should keep using the
 * singular form; it reads better and costs the same.
 *
 * No-ops on an empty list rather than issuing an INSERT with no rows.
 */
export async function recordOrderHistoryBatch(
  executor: SqlExecutor,
  companyId: string,
  events: readonly OrderHistoryEvent[]
): Promise<void> {
  if (events.length === 0) return;
  await executor.query(
    `
      INSERT INTO order_history (
        company_id,
        entity_type,
        event_type,
        order_id,
        order_number,
        piece_id,
        piece_name,
        description
      )
      SELECT $1, e.entity_type, e.event_type, e.order_id, e.order_number,
             e.piece_id, e.piece_name, e.description
        FROM UNNEST($2::text[], $3::text[], $4::uuid[], $5::text[],
                    $6::uuid[], $7::text[], $8::text[])
          AS e(entity_type, event_type, order_id, order_number,
               piece_id, piece_name, description)
    `,
    [
      companyId,
      events.map((e) => e.entityType),
      events.map((e) => e.eventType),
      events.map((e) => e.orderId ?? null),
      events.map((e) => e.orderNumber ?? null),
      events.map((e) => e.pieceId ?? null),
      events.map((e) => e.pieceName ?? null),
      events.map((e) => e.description)
    ]
  );
}
