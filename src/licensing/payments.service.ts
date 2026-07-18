import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

// ════════════════════════════════════════════════════════════════
// Payment-provider seam. No provider is live yet: every workspace runs on
// the free trial, and "buying" a plan only records checkout intent
// (company_subscriptions.selected_plan_code). When a real provider lands
// (Payoneer is the plan), it implements PaymentProvider below and the rest
// of the app doesn't change:
//
//   client "Choose plan" → POST /licensing/checkout
//     → provider.createCheckout(...)      → { available: true, url }
//     → user pays on the hosted page      → provider calls
//       POST /licensing/payments/webhook/:provider
//     → webhook handler verifies the signature and flips
//       company_subscriptions to (plan_code = selected_plan_code,
//       status 'active', source = provider, current_period_end = period),
//       then LicensingService.invalidate(companyId).
//
// BILLING RULE (founder-confirmed 2026-07-18): completing checkout starts
// the paid period AT PAYMENT TIME — the payer gets no trial and no
// trial-time credit; the free trial exists only for workspaces without a
// paid plan. Webhook implementations must therefore set
// current_period_end = payment time + billing interval and overwrite any
// trial row outright (never extend or append to it).
//
// The DB is already shaped for this: selected_plan_code carries what to
// charge for, and the provider-reference columns (stripe_customer_id /
// stripe_subscription_id — provider-agnostic in practice) carry the
// provider's ids. Implementation notes for the Payoneer pass:
//   · env: PAYMENT_PROVIDER=payoneer + PAYONEER_* credentials (.env.example)
//   · webhook signatures are computed over the RAW request bytes — register
//     a Fastify raw-body content-type parser for the webhook route before
//     verifying (the default JSON parser re-serializes and breaks HMACs).
// ════════════════════════════════════════════════════════════════

export type CheckoutResult =
  | { available: false; provider: string; message: string }
  | { available: true; provider: string; url: string };

export interface PaymentProvider {
  readonly name: string;
  /** Build a hosted-checkout session for a company buying a plan. */
  createCheckout(companyId: string, planCode: string): Promise<CheckoutResult>;
  /** Handle an async provider notification (payment settled, renewal, refund…). */
  handleWebhook(
    body: unknown,
    headers: Record<string, string | string[] | undefined>
  ): Promise<{ ok: boolean }>;
}

/** Placeholder while no processor is wired up: checkout politely declines. */
class NoPaymentProvider implements PaymentProvider {
  readonly name = "none";

  async createCheckout(): Promise<CheckoutResult> {
    return {
      available: false,
      provider: this.name,
      message:
        "Online payments aren't open yet — your plan choice is saved and your workspace keeps running free. We'll let you know the moment checkout opens."
    };
  }

  async handleWebhook(): Promise<{ ok: boolean }> {
    throw new NotFoundException("No payment provider is configured.");
  }
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly provider: PaymentProvider;

  constructor(config: ConfigService) {
    const configured = (config.get<string>("PAYMENT_PROVIDER") ?? "none").trim().toLowerCase();
    // Registry of implemented providers. Payoneer joins here when built.
    const providers: Record<string, PaymentProvider> = {
      none: new NoPaymentProvider()
    };
    const chosen = providers[configured];
    if (!chosen && configured !== "none") {
      this.logger.warn(
        `PAYMENT_PROVIDER="${configured}" is not implemented — falling back to "none" (checkout stays offline).`
      );
    }
    this.provider = chosen ?? providers["none"]!;
  }

  get providerName(): string {
    return this.provider.name;
  }

  createCheckout(companyId: string, planCode: string): Promise<CheckoutResult> {
    return this.provider.createCheckout(companyId, planCode);
  }

  /** Routes /licensing/payments/webhook/:provider — 404 for anything that
      isn't the one configured, live provider. */
  handleWebhook(
    providerName: string,
    body: unknown,
    headers: Record<string, string | string[] | undefined>
  ): Promise<{ ok: boolean }> {
    if (providerName.toLowerCase() !== this.provider.name || this.provider.name === "none") {
      throw new NotFoundException("Unknown payment provider.");
    }
    return this.provider.handleWebhook(body, headers);
  }
}
