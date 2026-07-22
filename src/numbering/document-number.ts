// Single source of truth for FINANCE document numbers — the twin of
// orders/order-number.ts, which owns the order-number counter.
//
//     <PREFIX>-<YEAR>-<SEQUENCE>        e.g.  INV-2026-00042
//
// FinanceService.nextDocNumber mints from these helpers and NumberingService
// previews from them, so "the next invoice number will be X" can never drift
// from the number actually issued.
//
// Kept dependency-free (no relative runtime imports) for the same reason
// order-number.ts is: the unit tests load it directly.

/** Business prefix per document type. */
export const DOC_PREFIX = {
  invoice: "INV",
  bill: "BILL",
  payment: "PAY",
  expense: "EXP",
  journal: "JE"
} as const;

export type DocType = keyof typeof DOC_PREFIX;

/** Width of the zero-padded per-(company, type, year) sequence segment. */
export const DOC_SEQUENCE_WIDTH = 5;

/**
 * Zero-pad a sequence to at least five digits. Values past 99999 widen rather
 * than truncate (100000 -> "100000"), so the number stays correct forever.
 */
export function padDocSequence(sequence: number): string {
  return String(sequence).padStart(DOC_SEQUENCE_WIDTH, "0");
}

/**
 * Assemble a finance document number from its parts.
 *
 *     formatDocNumber("invoice", 2026, 42) === "INV-2026-00042"
 */
export function formatDocNumber(
  docType: DocType,
  year: number | string,
  sequence: number
): string {
  return `${DOC_PREFIX[docType]}-${year}-${padDocSequence(sequence)}`;
}

/** The literal prefix every number of this (type, year) starts with. */
export function docNumberPrefix(docType: DocType, year: number | string): string {
  return `${DOC_PREFIX[docType]}-${year}-`;
}

/**
 * POSIX regex matching exactly the numbers this (type, year) mints, with the
 * sequence as capture group 1 — so a SQL `~` filter and a
 * `substring(... from ...)` extraction stay in lockstep with the formatter.
 */
export function docNumberPattern(docType: DocType, year: number | string): string {
  return `^${DOC_PREFIX[docType]}-${year}-([0-9]+)$`;
}

/**
 * The atomic bump. Identical mechanism to BUMP_ORDER_SEQUENCE_SQL: the
 * ON CONFLICT path row-locks the counter, so concurrent document creations
 * serialise and each receives a distinct value.
 */
export const BUMP_DOC_SEQUENCE_SQL = `
  INSERT INTO finance_doc_sequences (company_id, doc_type, year, last_value)
  VALUES ($1, $2, $3, 1)
  ON CONFLICT (company_id, doc_type, year)
  DO UPDATE SET last_value = finance_doc_sequences.last_value + 1
  RETURNING last_value
`;
