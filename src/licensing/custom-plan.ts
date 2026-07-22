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

export type CustomPriceModel = "flat" | "per_printer" | "bundle" | "base_plus_overage";

/** How printers ABOVE the included allowance are billed (base_plus_overage). */
export type CustomOverageModel = "per_printer" | "bundle";

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
  /** The per-unit money input for the VARIABLE part of the price: the
   *  per-printer/per-bundle rate, or the overage rate under base_plus_overage. */
  priceAmount: number | null;
  /** Printers per bundle — used by the bundle model and by bundle overage. */
  bundleSize: number | null;
  billingBasis: CustomBillingBasis;
  /** base_plus_overage: the fixed monthly base. */
  baseAmount: number | null;
  /** base_plus_overage: how many printers that base already covers. */
  includedPrinters: number | null;
  /** base_plus_overage: how the excess is billed. null = no overage at all. */
  overageModel: CustomOverageModel | null;
  /** Optional floor applied to ANY model — only ever raises the total. */
  minMonthly: number | null;
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
  if (!terms || terms.priceModel === null) return null;

  const live = Math.max(0, Math.floor(printerCount) || 0);
  // "cap" bills the committed slots; with no cap (unlimited) there are no
  // slots to bill, so fall back to actual usage.
  const units = terms.billingBasis === "cap" ? terms.maxPrinters ?? live : live;

  const rate = Number(terms.priceAmount);
  const hasRate = terms.priceAmount !== null && Number.isFinite(rate) && rate >= 0;
  const size = terms.bundleSize && terms.bundleSize >= 1 ? Math.floor(terms.bundleSize) : null;

  let total: number;
  switch (terms.priceModel) {
    case "flat":
      if (!hasRate) return null;
      total = rate;
      break;
    case "per_printer":
      if (!hasRate) return null;
      total = rate * units;
      break;
    case "bundle": {
      if (!hasRate) return null;
      if (size === null) return null; // bundle model without a size is unpriceable
      total = Math.ceil(units / size) * rate;
      break;
    }
    case "base_plus_overage": {
      const base = Number(terms.baseAmount);
      if (terms.baseAmount === null || !Number.isFinite(base) || base < 0) return null;
      const included = Math.max(0, Math.floor(terms.includedPrinters ?? 0));
      // Only printers beyond the allowance are metered.
      const extra = Math.max(0, units - included);
      let overage = 0;
      if (extra > 0 && terms.overageModel !== null) {
        if (!hasRate) return null; // an overage model with no rate is unpriceable
        if (terms.overageModel === "per_printer") {
          overage = rate * extra;
        } else {
          if (size === null) return null;
          overage = Math.ceil(extra / size) * rate;
        }
      }
      total = base + overage;
      break;
    }
    default:
      return null;
  }

  if (!Number.isFinite(total)) return null;
  // An optional contractual floor — raises a small month up to the minimum,
  // never discounts a large one.
  const floor = Number(terms.minMonthly);
  if (terms.minMonthly !== null && Number.isFinite(floor) && floor > total) {
    total = floor;
  }
  return Math.max(0, Math.round(total * 100) / 100);
}

/** One-line human summary of the terms, e.g. "$9.08 per printer × 100 slots". */
export function describeCustomPlan(
  terms: CustomPlanTerms | null,
  printerCount: number
): string | null {
  if (terms === null || terms.priceModel === null) return null;
  const money = (n: number) => `$${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}`;
  const units = terms.billingBasis === "cap" ? terms.maxPrinters ?? printerCount : printerCount;
  const basisWord = terms.billingBasis === "cap" ? "slots" : "in use";
  const floorNote =
    terms.minMonthly !== null && Number(terms.minMonthly) > 0
      ? `, min ${money(Number(terms.minMonthly))}`
      : "";

  const body = ((): string | null => {
    if (terms.priceModel === "base_plus_overage") {
      if (terms.baseAmount === null) return null;
      const included = Math.max(0, Math.floor(terms.includedPrinters ?? 0));
      const extra = Math.max(0, units - included);
      const head = `${money(Number(terms.baseAmount))} base covers ${included} printers`;
      if (terms.overageModel === null) return `${head} (no overage)`;
      if (terms.priceAmount === null) return head;
      if (extra === 0) {
        const per =
          terms.overageModel === "per_printer"
            ? `${money(Number(terms.priceAmount))} per extra printer`
            : `${money(Number(terms.priceAmount))} per extra ${terms.bundleSize ?? 0}`;
        return `${head} — ${per}, none used (${units} ${basisWord})`;
      }
      if (terms.overageModel === "per_printer") {
        return `${head} + ${extra} over × ${money(Number(terms.priceAmount))} (${units} ${basisWord})`;
      }
      const size = terms.bundleSize ?? 0;
      if (size < 1) return null;
      const blocks = Math.ceil(extra / size);
      return `${head} + ${blocks} × ${money(Number(terms.priceAmount))} per ${size} (${extra} over, ${units} ${basisWord})`;
    }

    if (terms.priceAmount === null) return null;
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
  })();

  return body === null ? null : `${body}${floorNote}`;
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
  // Added 2026-07-22 (overage migration); absent on older reads.
  custom_base_amount?: string | number | null;
  custom_included_printers?: number | null;
  custom_overage_model?: CustomOverageModel | null;
  custom_min_monthly?: string | number | null;
}

const num = (v: string | number | null | undefined): number | null =>
  v === null || v === undefined ? null : Number(v);

/**
 * The same terms as they live on a PLAN row (2026-07-23). A negotiated deal
 * can be saved into `plans` as a private custom tier so it can be assigned to
 * other companies or attached to a grant code; those rows carry the pricing
 * under plain names rather than the custom_ prefix.
 */
export interface PlanTermsRow {
  max_printers: number | null;
  price_model?: CustomPriceModel | null;
  price_amount?: string | number | null;
  bundle_size?: number | null;
  billing_basis?: CustomBillingBasis | null;
  base_amount?: string | number | null;
  included_printers?: number | null;
  overage_model?: CustomOverageModel | null;
  min_monthly?: string | number | null;
  display_name?: string | null;
}

/**
 * Terms carried by a plan itself. Returns null for an ordinary catalogue tier
 * (no pricing model), so the caller falls back to the flat list price.
 */
export function termsFromPlanRow(row: PlanTermsRow | null | undefined): CustomPlanTerms | null {
  if (!row || !row.price_model) return null;
  return {
    maxPrinters: row.max_printers ?? null,
    priceModel: row.price_model,
    priceAmount: num(row.price_amount),
    bundleSize: row.bundle_size ?? null,
    billingBasis: row.billing_basis ?? "cap",
    baseAmount: num(row.base_amount),
    includedPrinters: row.included_printers ?? null,
    overageModel: row.overage_model ?? null,
    minMonthly: num(row.min_monthly),
    label: row.display_name ?? null,
    note: null
  };
}

/** Map a DB row's custom_* columns into CustomPlanTerms (null when unset). */
export function termsFromRow(row: Partial<CustomPlanRow> | null | undefined): CustomPlanTerms | null {
  if (!row) return null;
  const maxPrinters = row.custom_max_printers ?? null;
  const priceModel = row.custom_price_model ?? null;
  if (maxPrinters === null && priceModel === null) return null;
  return {
    maxPrinters,
    priceModel,
    priceAmount: num(row.custom_price_amount),
    bundleSize: row.custom_bundle_size ?? null,
    // Default to committed-cap billing: an admin who set a cap but no basis
    // was selling slots.
    billingBasis: row.custom_billing_basis ?? "cap",
    baseAmount: num(row.custom_base_amount),
    includedPrinters: row.custom_included_printers ?? null,
    overageModel: row.custom_overage_model ?? null,
    minMonthly: num(row.custom_min_monthly),
    label: row.custom_label ?? null,
    note: row.custom_note ?? null
  };
}
