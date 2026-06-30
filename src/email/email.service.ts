import { Injectable, Logger } from "@nestjs/common";
import { Resend } from "resend";

// ════════════════════════════════════════════════════════════════
// EMAIL TRANSPORT
//
// The single seam between "we composed a message" and "a provider sent it".
// Today there is no provider wired up, so delivery is gated behind EMAIL_ENABLED
// (mirrors FilePurgeService's PURGE_ENABLED dry-run gate):
//
//   EMAIL_ENABLED != "true"  → dry-run: log the composed message, send nothing.
//   EMAIL_ENABLED == "true"  → call deliver(), which sends via Resend.
//
// Provider: Resend (https://resend.com). Needs RESEND_API_KEY and a verified
// sending domain for EMAIL_FROM_ADDRESS. Switching providers later is a
// deliver()-only change — nothing upstream in the pipeline cares.
//
// Sender identity is configured here, not per-message: a single no-reply From
// (EMAIL_FROM_ADDRESS / EMAIL_FROM_NAME). We deliberately set NO Reply-To —
// these are one-way notifications; customers are directed to the company's
// contact details in the body instead.
//
// send() returns the outcome the caller records; a thrown error from deliver()
// is surfaced so the caller can leave the order un-recorded and retry next sweep.
// ════════════════════════════════════════════════════════════════
export type EmailMessage = {
  to: string;
  subject: string;
  /** Plain-text body — always sent as the fallback part. */
  text: string;
  /** Optional branded HTML body. When present it's the primary rendering. */
  html?: string;
};

export type EmailSendResult = "sent" | "dry_run";

@Injectable()
export class EmailService {
  private readonly logger = new Logger("EmailService");
  private readonly enabled: boolean;
  private readonly fromAddress: string;
  private readonly fromName: string;
  private resend: Resend | null = null;

  constructor() {
    this.enabled = (process.env.EMAIL_ENABLED ?? "").toLowerCase() === "true";
    this.fromAddress = (process.env.EMAIL_FROM_ADDRESS ?? "").trim();
    this.fromName = (process.env.EMAIL_FROM_NAME ?? "").trim();
  }

  /** Whether real delivery is attempted (vs. dry-run). */
  get isLiveDelivery(): boolean {
    return this.enabled;
  }

  /** The configured no-reply sender, e.g. `PrintExec <no-reply@printexec.com>`. */
  private get from(): string {
    if (!this.fromAddress) return this.fromName || "(unset EMAIL_FROM_ADDRESS)";
    return this.fromName ? `${this.fromName} <${this.fromAddress}>` : this.fromAddress;
  }

  /**
   * Compose-agnostic send. Returns "dry_run" when delivery is disabled (default)
   * or "sent" once a transport accepts the message. Throws if the transport
   * fails so the caller can retry — it should NOT swallow.
   */
  async send(message: EmailMessage): Promise<EmailSendResult> {
    if (!this.enabled) {
      this.logger.log(
        `[dry-run] would email (from ${this.from}) → ${message.to} — "${message.subject}"\n${message.text}`
      );
      return "dry_run";
    }

    await this.deliver(message);
    return "sent";
  }

  /**
   * Hand the message to Resend. No Reply-To is set — these are one-way
   * notifications. Throws on a missing key/address or a provider rejection so
   * the caller leaves the order un-recorded and retries on the next sweep.
   */
  private async deliver(message: EmailMessage): Promise<void> {
    if (!this.fromAddress) {
      throw new Error("EMAIL_FROM_ADDRESS is not set; refusing to send.");
    }
    const apiKey = (process.env.RESEND_API_KEY ?? "").trim();
    if (!apiKey) {
      throw new Error("RESEND_API_KEY is not set; cannot deliver email.");
    }

    const client = (this.resend ??= new Resend(apiKey));
    const { data, error } = await client.emails.send({
      from: this.from, // "Name <no-reply@domain>" — Resend accepts this form
      to: [message.to],
      subject: message.subject,
      // Both parts: branded HTML when present, plain text always as fallback.
      ...(message.html ? { html: message.html } : {}),
      text: message.text
    });

    if (error) {
      throw new Error(`Resend rejected: ${error.name} — ${error.message}`);
    }

    this.logger.log(
      `[email] sent ${data?.id ?? "(no id)"} → ${message.to} — "${message.subject}"`
    );
  }
}
