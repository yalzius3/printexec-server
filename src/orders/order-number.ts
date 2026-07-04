// Single source of truth for the atomic, per-(tenant, year) order-number
// counter. The service (production) and the integration tests both import and
// call bumpOrderSequence(), so the exact SQL that runs in a real order creation
// is the same SQL the concurrency test exercises — they cannot drift apart.
//
// Kept deliberately dependency-free (no relative runtime imports) so the test
// runner can load it directly. See migrations/2026-07-04_tenant_order_numbering.sql.

/**
 * The atomic bump. INSERT ... ON CONFLICT DO UPDATE takes a row lock on the
 * (company_id, year) counter, so simultaneous callers serialise on it and each
 * receives a distinct last_value — the guarantee that two concurrent order
 * creations can never share a number. A year with no row yet starts at 1.
 */
export const BUMP_ORDER_SEQUENCE_SQL = `
  INSERT INTO order_number_sequences (company_id, year, last_value)
  VALUES ($1, $2, 1)
  ON CONFLICT (company_id, year)
  DO UPDATE SET last_value = order_number_sequences.last_value + 1
  RETURNING last_value
`;

type SequenceRow = { last_value: string };

/**
 * Anything that can run a parameterised query and return rows: a bound
 * DatabaseService.query (production, transaction-aware) or a raw pg
 * Pool/PoolClient.query (tests). This is what lets both paths share one
 * implementation instead of copying the SQL.
 */
export type SequenceQueryRunner = (
  sql: string,
  values: unknown[]
) => Promise<{ rows: SequenceRow[] }>;

/** Reserve and return the next sequence value for (companyId, year). */
export async function bumpOrderSequence(
  runQuery: SequenceQueryRunner,
  companyId: string,
  year: number
): Promise<number> {
  const { rows } = await runQuery(BUMP_ORDER_SEQUENCE_SQL, [companyId, year]);
  const value = Number(rows[0]?.last_value);
  // The upsert always RETURNs exactly one row, so this only trips on a real
  // fault (e.g. the counter table is missing) — fail loudly rather than mint a
  // bogus number.
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("order-number sequence bump returned no usable value");
  }
  return value;
}
