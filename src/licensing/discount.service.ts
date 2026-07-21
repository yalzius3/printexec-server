import { Injectable, Logger } from "@nestjs/common";
import { DatabaseService, type SqlExecutor } from "../database/database.service";

// ════════════════════════════════════════════════════════════════
// DISCOUNT CODES
//
// Resolves a code to the amount it takes off a plan's price, and records the
// redemption. A discount NEVER changes what plan a company holds (that's what
// license grants do) — it only reduces the amount on the invoice the
// activation issues.
//
// A code applies when it is: active, unexpired, valid for the plan being
// billed, under its redemption cap, and not already redeemed by this company.
// Anything else resolves to "no discount" with a reason the caller can show —
// a bad code must never block the subscription itself.
//
// Pre-migration safe: a missing discount_codes table (Postgres 42P01) resolves
// to "no discount" rather than failing the assignment.
// ════════════════════════════════════════════════════════════════

export interface ResolvedDiscount {
  discountId: string;
  code: string;
  kind: "percent" | "fixed";
  value: number;
  /** USD taken off the plan price (already clamped to the price). */
  amountOff: number;
  /** Price after the discount. */
  finalAmount: number;
}

export interface DiscountResolution {
  discount: ResolvedDiscount | null;
  /** Why no discount applied — surfaced to the admin, never fatal. */
  reason: string | null;
}

interface DiscountRow {
  discount_id: string;
  code: string;
  kind: "percent" | "fixed";
  value: string;
  plan_code: string | null;
  max_redemptions: number | null;
  expires_at: string | Date | null;
  active: boolean;
  redemptions: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

@Injectable()
export class DiscountService {
  private readonly logger = new Logger(DiscountService.name);

  constructor(private readonly db: DatabaseService) {}

  /**
   * Resolve a code against a plan + its price. Returns { discount: null,
   * reason } when it doesn't apply; never throws for a bad/unknown code.
   */
  async resolve(
    code: string,
    planCode: string,
    priceUsd: number,
    companyId: string
  ): Promise<DiscountResolution> {
    const trimmed = code.trim();
    if (!trimmed) return { discount: null, reason: null };

    let row: DiscountRow | undefined;
    try {
      const { rows } = await this.db.query<DiscountRow>(
        `SELECT d.discount_id, d.code, d.kind, d.value, d.plan_code,
                d.max_redemptions, d.expires_at, d.active,
                (SELECT count(*)::text FROM discount_redemptions r
                  WHERE r.discount_id = d.discount_id) AS redemptions
           FROM discount_codes d
          WHERE upper(d.code) = upper($1)`,
        [trimmed]
      );
      row = rows[0];
    } catch (e) {
      if ((e as { code?: string }).code === "42P01") {
        return { discount: null, reason: "Discount codes are not available yet (migration pending)." };
      }
      throw e;
    }

    if (!row) return { discount: null, reason: `Discount code "${trimmed}" doesn't exist.` };
    if (!row.active) return { discount: null, reason: `Discount code ${row.code} is switched off.` };
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
      return { discount: null, reason: `Discount code ${row.code} has expired.` };
    }
    if (row.plan_code && row.plan_code !== planCode) {
      return { discount: null, reason: `Discount code ${row.code} only applies to the ${row.plan_code} plan.` };
    }
    if (row.max_redemptions !== null && Number(row.redemptions) >= row.max_redemptions) {
      return { discount: null, reason: `Discount code ${row.code} has reached its redemption limit.` };
    }

    // Already redeemed by this company: idempotent, not an error — the
    // discount simply doesn't stack onto a second invoice.
    const prior = await this.db.query(
      "SELECT 1 FROM discount_redemptions WHERE discount_id = $1 AND company_id = $2",
      [row.discount_id, companyId]
    );
    if (prior.rowCount) {
      return { discount: null, reason: `Discount code ${row.code} was already used by this company.` };
    }

    const value = Number(row.value);
    const rawOff = row.kind === "percent" ? (priceUsd * value) / 100 : value;
    // Never discount below zero — a fixed code larger than the price just
    // zeroes it out.
    const amountOff = round2(Math.max(0, Math.min(priceUsd, rawOff)));

    return {
      discount: {
        discountId: row.discount_id,
        code: row.code,
        kind: row.kind,
        value,
        amountOff,
        finalAmount: round2(Math.max(0, priceUsd - amountOff))
      },
      reason: null
    };
  }

  /**
   * Record that a company used a code. ON CONFLICT DO NOTHING makes a repeat
   * call harmless (the UNIQUE (discount_id, company_id) is the guard that also
   * enforces one-use-per-company).
   */
  async recordRedemption(
    discountId: string,
    companyId: string,
    amountOff: number,
    executor?: SqlExecutor
  ): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO discount_redemptions (discount_id, company_id, amount_off)
         VALUES ($1, $2, $3)
         ON CONFLICT (discount_id, company_id) DO NOTHING`,
        [discountId, companyId, amountOff],
        executor
      );
    } catch (e) {
      // Accounting must never break the subscription that triggered it.
      this.logger.warn(
        `discount redemption not recorded (${discountId}/${companyId}): ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
}
