// ════════════════════════════════════════════════════════════════
// ORDER-COMPLETION EMAIL TEMPLATE
//
// Pure, side-effect-free composition: data in → { subject, body } out. Keeping
// it transport-agnostic means the sweep can compose in dry-run mode and log the
// exact message it WOULD send. This is the plain-text first pass; branded HTML
// layers can wrap the same data later without touching the notifier logic.
// ════════════════════════════════════════════════════════════════

export type OrderCompletionStatus =
  | "completed"
  | "ready_for_shipping"
  | "out_for_shipping"
  | "fulfilled";

export type OrderCompletionEmailData = {
  company: {
    name: string;
    phone: string | null;
    email: string | null;
    website: string | null;
    city: string | null;
    countryCode: string | null;
    currency: string | null;
  };
  customer: {
    displayName: string;
    /** The contact person on the account (first + last), if recorded. */
    contactName: string | null;
    phone: string | null;
    secondaryPhone: string | null;
    email: string;
    isBusiness: boolean;
    businessName: string | null;
  };
  order: {
    orderNumber: string;
    title: string;
    description: string | null;
    status: OrderCompletionStatus;
    // pg returns DATE columns as Date objects, not strings — formatDate handles both.
    establishedAt: string | Date | null;
    deadline: string | Date | null;
    pieceCount: number;
    /** Best-effort order total (sum of piece costs × profit). Null when unpriced. */
    total: number | null;
  };
};

export type ComposedEmail = { subject: string; body: string };

// Human phrasing for each "done or above" status. `label` is the short status
// word; `phrase` completes the sentence "your order is now …".
const STATUS_COPY: Record<OrderCompletionStatus, { label: string; phrase: string }> = {
  completed: {
    label: "Completed",
    phrase: "complete and being prepared for shipping"
  },
  ready_for_shipping: {
    label: "Ready for shipping",
    phrase: "packed and ready for shipping"
  },
  out_for_shipping: {
    label: "Out for delivery",
    phrase: "on its way to you"
  },
  fulfilled: {
    label: "Fulfilled",
    phrase: "fulfilled — thank you"
  }
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

/**
 * Format a date as "June 30, 2026". Accepts a 'YYYY-MM-DD'/ISO string OR a Date
 * (the pg driver returns DATE columns as Date objects, not strings). TZ-safe:
 * for a Date we read LOCAL components — pg builds a DATE at local midnight, so
 * the calendar day is preserved regardless of the server timezone; for a string
 * we slice the leading YYYY-MM-DD. Neither path re-parses through Date math that
 * could shift the day.
 */
function formatDate(value: string | Date | null): string | null {
  if (value == null) return null;
  let year: number;
  let month: number;
  let day: number;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    year = value.getFullYear();
    month = value.getMonth() + 1;
    day = value.getDate();
  } else {
    const parts = value.slice(0, 10).split("-");
    year = Number(parts[0]);
    month = Number(parts[1]);
    day = Number(parts[2]);
  }
  if (!year || !month || !day || month < 1 || month > 12) {
    return value instanceof Date ? null : value;
  }
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}

/** Format a money amount with the company's currency code, if any. */
function formatMoney(amount: number | null, currency: string | null): string | null {
  if (amount == null || !Number.isFinite(amount)) return null;
  const fixed = (Math.round(amount * 100) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  return currency ? `${currency} ${fixed}` : fixed;
}

/** "Label:   value", padded so the right-hand column lines up in monospace. */
function row(label: string, value: string): string {
  return `${(label + ":").padEnd(14, " ")}${value}`;
}

export function composeOrderCompletionEmail(data: OrderCompletionEmailData): ComposedEmail {
  const { company, customer, order } = data;
  const copy = STATUS_COPY[order.status];

  const greetingName = customer.contactName || customer.displayName || "there";
  const subject = `Your order ${order.orderNumber} is ${copy.label.toLowerCase()} — ${company.name}`;

  // ── Order summary block ──────────────────────────────────────
  const summary: string[] = [
    row("Order number", order.orderNumber),
    row("Title", order.title),
    row("Status", copy.label)
  ];
  if (order.description) summary.push(row("Details", order.description));
  summary.push(row("Pieces", String(order.pieceCount)));
  const placed = formatDate(order.establishedAt);
  if (placed) summary.push(row("Placed on", placed));
  const due = formatDate(order.deadline);
  if (due) summary.push(row("Due by", due));
  const total = formatMoney(order.total, company.currency);
  if (total) summary.push(row("Order total", total));

  // ── Customer / contact block ─────────────────────────────────
  const yourDetails: string[] = [row("Customer", customer.displayName)];
  if (customer.isBusiness && customer.contactName) {
    yourDetails.push(row("Contact", customer.contactName));
  }
  if (customer.phone) yourDetails.push(row("Phone", customer.phone));
  if (customer.secondaryPhone) yourDetails.push(row("Alt. phone", customer.secondaryPhone));
  yourDetails.push(row("Email", customer.email));

  // ── Company sign-off / contact block ─────────────────────────
  const contactLines: string[] = [`  ${company.name}`];
  if (company.phone) contactLines.push(`  ${company.phone}`);
  if (company.email) contactLines.push(`  ${company.email}`);
  if (company.website) contactLines.push(`  ${company.website}`);

  const body = [
    `Hi ${greetingName},`,
    ``,
    `Great news — your order with ${company.name} is now ${copy.phrase}.`,
    ``,
    `Order summary`,
    `─────────────`,
    ...summary,
    ``,
    `Your details`,
    `────────────`,
    ...yourDetails,
    ``,
    `This is an automated update from an unmonitored address — please don't reply.`,
    `Questions about your order? Reach us at:`,
    ...contactLines,
    ``,
    `Thank you for choosing ${company.name}!`,
    ``,
    `— The ${company.name} team`
  ].join("\n");

  return { subject, body };
}
