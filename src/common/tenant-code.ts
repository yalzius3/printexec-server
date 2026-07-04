// Dependency-free helpers for the tenant-scoped order-number format:
//
//     <TENANT_CODE>-<YEAR>-<SEQUENCE>        e.g.  ABC-2026-00001
//
// The database owns tenant_code *assignment* (a BEFORE INSERT trigger on
// companies, see migrations/2026-07-04_tenant_order_numbering.sql). These
// helpers mirror that derivation so the rules are unit-testable and can be
// used as a last-resort fallback in OrdersService. Keep the two in sync — the
// trigger's tenant_code_base() SQL function is the SQL twin of
// deriveTenantCodeBase() below.

/** Prefix used when a company name contains no usable A-Z letters at all. */
export const TENANT_CODE_FALLBACK = "ORD";

/** Number of A-Z letters taken from the company name for the tenant code. */
export const TENANT_CODE_LENGTH = 3;

/** Width of the zero-padded per-tenant, per-year sequence segment. */
export const ORDER_SEQUENCE_WIDTH = 5;

/**
 * The *base* tenant code: the first three A-Z letters of the company name,
 * upper-cased, with spaces and every non-letter stripped first. Shorter names
 * yield shorter codes ("Ai" -> "AI"); a name with no ASCII letters yields the
 * fallback ("123" -> "ORD"). This is the un-deduplicated base; the database
 * appends a numeric suffix when two tenants would otherwise collide, so the
 * stored code is not guaranteed to equal this value.
 */
export function deriveTenantCodeBase(name: string | null | undefined): string {
  const letters = (name ?? "").replace(/[^A-Za-z]/g, "").toUpperCase();
  return letters.slice(0, TENANT_CODE_LENGTH) || TENANT_CODE_FALLBACK;
}

/**
 * Zero-pad a positive sequence number to at least five digits. Values beyond
 * 99999 are widened rather than truncated (100000 -> "100000") so the number
 * stays correct even for very high-volume tenant-years.
 */
export function padOrderSequence(sequence: number): string {
  return String(sequence).padStart(ORDER_SEQUENCE_WIDTH, "0");
}

/**
 * Assemble a business-facing order number from its parts.
 *
 *     formatOrderNumber("ABC", 2026, 1) === "ABC-2026-00001"
 */
export function formatOrderNumber(
  tenantCode: string,
  year: number | string,
  sequence: number
): string {
  return `${tenantCode}-${year}-${padOrderSequence(sequence)}`;
}
