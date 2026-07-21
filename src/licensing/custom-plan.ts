// ════════════════════════════════════════════════════════════════
// Custom per-company plan terms — the ONE place custom pricing is defined
// and computed. The license resolver (effective printer cap + what the tenant
// sees), the subscription-invoice issuer (what they're actually billed) and
// the admin API (the live preview while a deal is being set up) all call
// through here, so those three can never drift apart.
//
// Catalogue tiers stay rigid on purpose; this override layer is what makes
// Enterprise deals negotiable without inventing a global tier per customer.
// Columns live on company_subscriptions (2026-07-22 migration) and are
// writable ONLY by an unlocked platform admin.
// ════════════════════════════════════════════════════════════════

export type CustomPriceModel = "flat" | "per_printer" | "bundle";

/**
 * What the price is multiplied by:
 *   cap    → the committed cap (they bought N slots; bill the slots)
 *   actual → printers currently in use (bill what they run)
 */
export type CustomBillingBasis = "cap" | "actual";

export interface CustomPlanTerms {
  /** Overrides the plan's printer cap. null = inherit the plan's. */
  maxPrinters: number | null;
  /** null = no custom pricing (fall back to the plan's list price). */
  priceModel: CustomPriceModel | null;
  priceAmount: number | null;
  /** Printers per bundle — required by, and only used by, the bundle model. */
  bundleSize: number | null;
  billingBasis: CustomBillingBasis;
  /** Tenant-facing name for the deal, e.g. "Enterprise — 100 printers". */
  label: string | null;
  /** Internal-only context; never sent to the tenant. */
  note: string | null;
}

/** True when this row carries any override at all (cap and/or pricing). */
export function hasCustomPlan(terms: CustomPlanTerms | null): terms is CustomPlanTerms {
  if (!terms) return false;
  return terms.maxPrinters !== null || terms.priceModel !== null;
}

/**
 * Monthly price in USD for a custom plan, or null when no custom pricing is
 * configured (the caller then falls back to the plan's list price).
 *
 * `printerCount` is the company's live printer count — used when the basis is
 * "actual", and as the fallback for a "cap" basis with no cap set (an
 * unlimited plan has no slot count to bill, so we bill what's in use).
 */
export function computeCustomMonthlyUsd(
  terms: CustomPlanTerms | null,
  printerCount: number
): number | null {
  if (!terms || terms.priceModel === null || terms.priceAmount === null) return null;

  const amount = Number(terms.priceAmount);
  if (!Number.isFinite(amount) || amount < 0) return null;

  const live = Math.max(0, Math.floor(printerCount) || 0);
  // "cap" bills the committed slots; with no cap (unlimited) there are no
  // slots to bill, so fall back to actual usage.
  const units = terms.billingBasis === "cap" ? terms.maxPrinters ?? live : live;

  let total: number;
  switch (terms.priceModel) {
    case "flat":
      total = amount;
      break;
    case "per_printer":
      total = amount * units;
      break;
    case "bundle": {
      const size = terms.bundleSize && terms.bundleSize >= 1 ? Math.floor(terms.bundleSize) : null;
      if (size === null) return null; // bundle model without a size is unpriceable
      total = Math.ceil(units / size) * amount;
      break;
    }
    default:
      return null;
  }

  if (!Number.isFinite(total)) return null;
  return Math.max(0, Math.round(total * 100) / 100);
}

/** One-line human summary of the terms, e.g. "$9.08 per printer × 100 slots". */
export function describeCustomPlan(
  terms: CustomPlanTerms | null,
  printerCount: number
): string | null {
  if (terms === null || terms.priceModel === null || terms.priceAmount === null) return null;
  const money = (n: number) => `$${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}`;
  const units = terms.billingBasis === "cap" ? terms.maxPrinters ?? printerCount : printerCount;
  const basisWord = terms.billingBasis === "cap" ? "slots" : "in use";
  switch (terms.priceModel) {
    case "flat":
      return `${money(Number(terms.priceAmount))} per month, flat`;
    case "per_printer":
      return `${money(Number(terms.priceAmount))} per printer × ${units} ${basisWord}`;
    case "bundle": {
      const size = terms.bundleSize ?? 0;
      if (size < 1) return null;
      const bundles = Math.ceil(units / size);
      return `${money(Number(terms.priceAmount))} per ${size} printers × ${bundles} (${units} ${basisWord})`;
    }
    default:
      return null;
  }
}

/** Row shape as selected from company_subscriptions (pg returns NUMERIC as text). */
export interface CustomPlanRow {
  custom_max_printers: number | null;
  custom_price_model: CustomPriceModel | null;
  custom_price_amount: string | number | null;
  custom_bundle_size: number | null;
  custom_billing_basis: CustomBillingBasis | null;
  custom_label: string | null;
  custom_note: string | null;
}

/** Map a DB row's custom_* columns into CustomPlanTerms (null when unset). */
export function termsFromRow(row: Partial<CustomPlanRow> | null | undefined): CustomPlanTerms | null {
  if (!row) return null;
  const maxPrinters = row.custom_max_printers ?? null;
  const priceModel = row.custom_price_model ?? null;
  if (maxPrinters === null && priceModel === null) return null;
  const rawAmount = row.custom_price_amount;
  return {
    maxPrinters,
    priceModel,
    priceAmount: rawAmount === null || rawAmount === undefined ? null : Number(rawAmount),
    bundleSize: row.custom_bundle_size ?? null,
    // Default to committed-cap billing: an admin who set a cap but no basis
    // was selling slots.
    billingBasis: row.custom_billing_basis ?? "cap",
    label: row.custom_label ?? null,
    note: row.custom_note ?? null
  };
}
