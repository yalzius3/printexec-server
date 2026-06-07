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
