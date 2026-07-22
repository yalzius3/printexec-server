import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import {
  ORDER_SEQUENCE_WIDTH,
  deriveTenantCodeBase,
  formatOrderNumber
} from "../common/tenant-code";
import {
  DOC_SEQUENCE_WIDTH,
  docNumberPattern,
  docNumberPrefix,
  formatDocNumber
} from "./document-number";

// ════════════════════════════════════════════════════════════════
// NUMBERING SERVICE
//
// Owner-facing control over the two business serials the shop shows customers:
// the order number (<TENANT>-<YEAR>-<SEQ>, counter in order_number_sequences)
// and the invoice number (INV-<YEAR>-<SEQ>, counter in finance_doc_sequences).
//
// Both counters are keyed by YEAR, so they already restart every January. This
// service is for the two things the year key can't do: restart the count NOW
// (e.g. after clearing out trial data), or start it at a chosen value (e.g.
// continuing from the numbering of a previous system).
//
// WHY ITS OWN MODULE: numbering spans Orders and Finance and belongs to
// neither. Both formats are also minted from shared, dependency-free helpers
// (orders/order-number.ts, ./document-number.ts) that the minting services use
// too — so a preview here is literally the string the next document will get.
//
// THE ONE INVARIANT: a serial may never be re-used. orders(company_id,
// order_number) and invoices(company_id, invoice_number) are both UNIQUE, so a
// counter set below a number that is already on a live document would mint a
// duplicate and the insert would fail — the shop would simply stop being able
// to create orders. Every write here therefore:
//   1. takes the counter's row lock FIRST (the same lock the minting path
//      takes, so a concurrent create serialises behind us),
//   2. re-reads the highest serial actually in use for that year,
//   3. refuses any value at or below it, naming the document that blocks it.
// Gaps below the highest are still reclaimable — that's what makes "reset to 1
// after deleting the test orders" work.
// ════════════════════════════════════════════════════════════════

export type NumberingKind = "order" | "invoice";

export type NumberingState = {
  kind: NumberingKind;
  /** Human label for the serial ("Order numbers"). */
  label: string;
  /** The calendar year whose counter this is — both serials reset annually. */
  year: number;
  /** False when the counter's table hasn't been migrated in yet. */
  available: boolean;
  /** Why it's unavailable, for the UI to show instead of a silent blank. */
  unavailable_reason: string | null;
  /** The literal text before the serial, e.g. "ABC-2026-". */
  prefix: string;
  /** Zero-padded width of the serial segment. */
  width: number;
  /** The serial the next document will receive. */
  next_value: number;
  /** Exactly the number the next document will receive, e.g. ABC-2026-00042. */
  next_number: string;
  /** Highest serial already on a live document this year (0 = none yet). */
  highest_used: number;
  /** The document holding highest_used — what a lower value would collide with. */
  highest_used_number: string | null;
  /** Lowest serial the owner may set right now (highest_used + 1). */
  minimum_value: number;
  /** How many documents already carry a serial for this year. */
  used_count: number;
};

/** What the live documents say about a (company, year)'s serials. */
type Usage = {
  /** Highest serial on a live document, or 0 when the year is untouched. */
  highest: number;
  /** That serial rendered in full, e.g. "ABC-2026-00041". */
  highestNumber: string | null;
  /** How many documents carry a serial of this format for the year. */
  count: number;
};

/** Per-kind wiring. Everything below is written once, against this shape. */
type KindSpec = {
  label: string;
  /** Counter table — checked with to_regclass before any read. */
  sequenceTable: string;
  /** Table holding the issued documents, and its business-number column. */
  documentTable: string;
  numberColumn: string;
  width: number;
};

const SPECS: Record<NumberingKind, KindSpec> = {
  order: {
    label: "Order numbers",
    sequenceTable: "public.order_number_sequences",
    documentTable: "orders",
    numberColumn: "order_number",
    width: ORDER_SEQUENCE_WIDTH
  },
  invoice: {
    label: "Invoice numbers",
    sequenceTable: "public.finance_doc_sequences",
    documentTable: "invoices",
    numberColumn: "invoice_number",
    width: DOC_SEQUENCE_WIDTH
  }
};

/** Highest serial the format can express before the padding widens. */
const MAX_SERIAL = 99_999_999;

@Injectable()
export class NumberingService {
  constructor(private readonly db: DatabaseService) {}

  /** Both serials' current state, for the Company settings panel. */
  async getState(companyId: string): Promise<{ order: NumberingState; invoice: NumberingState }> {
    const year = this.currentYear();
    const tenantCode = await this.resolveTenantCode(companyId);
    const [order, invoice] = await Promise.all([
      this.readState(companyId, "order", year, tenantCode),
      this.readState(companyId, "invoice", year, tenantCode)
    ]);
    return { order, invoice };
  }

  /**
   * Point a counter at `nextValue`, so the next document created gets exactly
   * that serial. Reset-to-1 is just nextValue = 1.
   *
   * Runs in one transaction that holds the counter's row lock across the
   * collision check, so a concurrent order/invoice creation cannot slip a
   * document in between the check and the write.
   */
  async setNextValue(
    companyId: string,
    kind: NumberingKind,
    nextValue: number
  ): Promise<NumberingState> {
    if (!Number.isInteger(nextValue) || nextValue < 1 || nextValue > MAX_SERIAL) {
      throw new BadRequestException(
        `The starting number must be a whole number between 1 and ${MAX_SERIAL}.`
      );
    }

    const spec = SPECS[kind];
    const year = this.currentYear();
    const tenantCode = await this.resolveTenantCode(companyId);

    return this.db.transaction(async (client) => {
      if (!(await this.sequenceTableExists(kind, client))) {
        throw new ConflictException(this.unavailableReason(kind));
      }

      // Take the counter's row lock BEFORE looking at the documents. This is
      // the same row the minting path locks, so from here until commit nobody
      // can mint a serial we haven't accounted for.
      await this.lockCounter(client, companyId, kind, year);

      const used = await this.readUsage(client, companyId, kind, year, tenantCode);
      if (nextValue <= used.highest) {
        throw new ConflictException(
          `${used.highestNumber} already uses number ${used.highest}, so the count can't restart at ` +
            `${nextValue} — serial numbers are never re-used. The lowest available number is ` +
            `${used.highest + 1}.`
        );
      }

      await this.writeCounter(client, companyId, kind, year, nextValue - 1);

      return this.buildState(kind, year, tenantCode, {
        available: true,
        nextValue,
        used,
        width: spec.width
      });
    });
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  private async readState(
    companyId: string,
    kind: NumberingKind,
    year: number,
    tenantCode: string
  ): Promise<NumberingState> {
    if (!(await this.sequenceTableExists(kind))) {
      return this.buildState(kind, year, tenantCode, {
        available: false,
        nextValue: 1,
        used: { highest: 0, highestNumber: null, count: 0 },
        width: SPECS[kind].width
      });
    }

    const [lastValue, used] = await Promise.all([
      this.readCounter(companyId, kind, year),
      this.readUsage(undefined, companyId, kind, year, tenantCode)
    ]);

    // A counter can trail the documents when rows predate it (the pre-migration
    // legacy generator, or an import). Report what will REALLY be minted: the
    // mint path bumps the counter, and a collision there would fail the insert,
    // so the honest "next" is whichever is higher.
    const nextValue = Math.max(lastValue + 1, used.highest + 1);

    return this.buildState(kind, year, tenantCode, {
      available: true,
      nextValue,
      used,
      width: SPECS[kind].width
    });
  }

  /** Whether the counter table has been migrated in yet. */
  private async sequenceTableExists(kind: NumberingKind, client?: PoolClient): Promise<boolean> {
    const res = await this.db.query<{ present: boolean }>(
      "SELECT to_regclass($1) IS NOT NULL AS present",
      [SPECS[kind].sequenceTable],
      client
    );
    return res.rows[0]?.present === true;
  }

  private unavailableReason(kind: NumberingKind): string {
    return kind === "order"
      ? "Order numbering isn't set up on this database yet — apply migrations/2026-07-04_tenant_order_numbering.sql."
      : "Finance numbering isn't set up on this database yet — apply migrations/2026-07-08_finance_core.sql.";
  }

  /** Current counter value (0 when the year has no row yet). */
  private async readCounter(companyId: string, kind: NumberingKind, year: number): Promise<number> {
    const res =
      kind === "order"
        ? await this.db.query<{ last_value: string }>(
            "SELECT last_value FROM order_number_sequences WHERE company_id = $1 AND year = $2",
            [companyId, year]
          )
        : await this.db.query<{ last_value: string }>(
            `SELECT last_value FROM finance_doc_sequences
              WHERE company_id = $1 AND doc_type = 'invoice' AND year = $2`,
            [companyId, year]
          );
    const value = Number(res.rows[0]?.last_value ?? 0);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }

  /**
   * Highest serial actually in use for (company, year) and how many documents
   * are numbered. Matched with the SAME regex shape the formatter produces, so
   * only numbers of the CURRENT format count — a legacy ORD-2026-001 lives in a
   * different namespace and can't collide with ABC-2026-00001.
   *
   * Cast to NUMERIC rather than BIGINT: the pattern accepts any digit run, and
   * an absurdly long one would overflow a bigint and throw mid-check.
   */
  private async readUsage(
    client: PoolClient | undefined,
    companyId: string,
    kind: NumberingKind,
    year: number,
    tenantCode: string
  ): Promise<Usage> {
    const spec = SPECS[kind];
    const pattern = this.numberPattern(kind, year, tenantCode);

    const res = await this.db.query<{ highest: string | null; used_count: string }>(
      `
        WITH numbered AS (
          SELECT substring(${spec.numberColumn} from $2)::numeric AS seq
          FROM ${spec.documentTable}
          WHERE company_id = $1 AND ${spec.numberColumn} ~ $2
        )
        SELECT MAX(seq)::text AS highest, COUNT(*)::text AS used_count FROM numbered
      `,
      [companyId, pattern],
      client
    );

    const row = res.rows[0];
    const parsed = Number(row?.highest ?? 0);
    const highest = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
    return {
      highest,
      // Re-formatted rather than selected back: the serial matched the format's
      // own regex, so rendering it through the formatter is exact and saves a
      // second pass over the table.
      highestNumber: highest > 0 ? this.formatNumber(kind, year, tenantCode, highest) : null,
      count: Number(row?.used_count ?? 0) || 0
    };
  }

  /** The regex matching exactly the numbers this (kind, year) mints, sequence
   *  in capture group 1 — one definition for both the `~` filter and the
   *  `substring(... from ...)` extraction above. */
  private numberPattern(kind: NumberingKind, year: number, tenantCode: string): string {
    return kind === "order"
      ? `^${escapeRegex(tenantCode)}-${year}-([0-9]+)$`
      : docNumberPattern("invoice", year);
  }

  private formatNumber(
    kind: NumberingKind,
    year: number,
    tenantCode: string,
    sequence: number
  ): string {
    return kind === "order"
      ? formatOrderNumber(tenantCode, year, sequence)
      : formatDocNumber("invoice", year, sequence);
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  /**
   * Row-lock the counter without consuming a number. The upsert creates the
   * year's row at 0 if absent (0 = "nothing handed out yet", the same value a
   * missing row means) and otherwise takes the lock via a no-op update.
   */
  private async lockCounter(
    client: PoolClient,
    companyId: string,
    kind: NumberingKind,
    year: number
  ): Promise<void> {
    if (kind === "order") {
      await this.db.query(
        `INSERT INTO order_number_sequences (company_id, year, last_value)
         VALUES ($1, $2, 0)
         ON CONFLICT (company_id, year)
         DO UPDATE SET last_value = order_number_sequences.last_value`,
        [companyId, year],
        client
      );
      return;
    }
    await this.db.query(
      `INSERT INTO finance_doc_sequences (company_id, doc_type, year, last_value)
       VALUES ($1, 'invoice', $2, 0)
       ON CONFLICT (company_id, doc_type, year)
       DO UPDATE SET last_value = finance_doc_sequences.last_value`,
      [companyId, year],
      client
    );
  }

  /** Set the counter so the NEXT bump returns lastValue + 1. */
  private async writeCounter(
    client: PoolClient,
    companyId: string,
    kind: NumberingKind,
    year: number,
    lastValue: number
  ): Promise<void> {
    if (kind === "order") {
      await this.db.query(
        "UPDATE order_number_sequences SET last_value = $3 WHERE company_id = $1 AND year = $2",
        [companyId, year, lastValue],
        client
      );
      return;
    }
    await this.db.query(
      `UPDATE finance_doc_sequences SET last_value = $3
        WHERE company_id = $1 AND doc_type = 'invoice' AND year = $2`,
      [companyId, year, lastValue],
      client
    );
  }

  // ── Shaping ───────────────────────────────────────────────────────────────

  private buildState(
    kind: NumberingKind,
    year: number,
    tenantCode: string,
    input: { available: boolean; nextValue: number; used: Usage; width: number }
  ): NumberingState {
    const { available, nextValue, used, width } = input;
    return {
      kind,
      label: SPECS[kind].label,
      year,
      available,
      unavailable_reason: available ? null : this.unavailableReason(kind),
      prefix: kind === "order" ? `${tenantCode}-${year}-` : docNumberPrefix("invoice", year),
      width,
      next_value: nextValue,
      next_number: this.formatNumber(kind, year, tenantCode, nextValue),
      highest_used: used.highest,
      highest_used_number: used.highestNumber,
      minimum_value: used.highest + 1,
      used_count: used.count
    };
  }

  /**
   * The tenant's order-number prefix. Mirrors OrdersService.resolveTenantCode —
   * the DB trigger owns persistence, so a half-migrated row just derives the
   * base code on the fly rather than failing the panel.
   */
  private async resolveTenantCode(companyId: string): Promise<string> {
    try {
      const res = await this.db.query<{ tenant_code: string | null; name: string | null }>(
        "SELECT tenant_code, name FROM companies WHERE company_id = $1",
        [companyId]
      );
      const row = res.rows[0];
      if (!row) throw new NotFoundException("Company not found.");
      return row.tenant_code?.trim() || deriveTenantCodeBase(row.name);
    } catch (e) {
      // tenant_code column not migrated yet — derive from the name instead.
      if ((e as { code?: string }).code !== "42703") throw e;
      const res = await this.db.query<{ name: string | null }>(
        "SELECT name FROM companies WHERE company_id = $1",
        [companyId]
      );
      return deriveTenantCodeBase(res.rows[0]?.name);
    }
  }

  /**
   * UTC year — the same clock nextDocNumber (issue_date) and the order
   * generator (established_at, defaulted from today()) key their counters on.
   */
  private currentYear(): number {
    return new Date().getUTCFullYear();
  }
}

/** Escape a value spliced into a POSIX regex. Tenant codes are A-Z plus an
 *  optional numeric suffix, but the code is company-derived data — it never
 *  goes into a pattern raw. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
