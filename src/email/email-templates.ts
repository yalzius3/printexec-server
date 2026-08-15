// ════════════════════════════════════════════════════════════════
// ORDER-COMPLETION EMAIL TEMPLATE
//
// Pure, side-effect-free composition: data in → { subject, text, html } out.
// Keeping it transport-agnostic means the sweep can compose in dry-run mode and
// log the exact message it WOULD send.
//
// Branding mirrors the PrintExec capabilities-doc header: an IBM Plex Mono
// "PRINTEXEC" wordmark on a black/white bar, plus the matrix-style coordinate
// "rain" strip. That strip is JS-generated in the source doc; email clients
// don't run JS, so it's baked to a STATIC, deterministic (order-seeded) string
// here. The HTML is table + inline-style only (Gmail/Outlook/Apple Mail safe);
// a plain-text part always rides alongside as the fallback.
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
    // Absolute, publicly reachable URL of the company's logo (the unauthenticated
    // /api/uploads/logo/:companyId route), or null when none is set. Rendered
    // top-right in the header; null keeps the blank header bar unchanged.
    logoUrl: string | null;
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

export type ComposedEmail = { subject: string; text: string; html: string };

// Human phrasing for each "ready or above" status. `label` is the short status
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

// ── Brand tokens (from the capabilities doc) ─────────────────────
const MONO = "'IBM Plex Mono','Roboto Mono',ui-monospace,'Courier New',monospace";
const SANS = "'DM Sans','Helvetica Neue',Arial,sans-serif";
const INK = "#000000";
const PAPER = "#ffffff";
const SUBTLE = "#57534e";
// Public marketing site — the footer wordmark and every "learn more" link
// point here. NOT the app: the platform lives at its own origin (the CTA
// appUrl, e.g. https://solution.printexec.xyz).
const SITE_URL = "https://printexec.xyz";
// Where recipients are told to reach a human. One place to change it.
const SUPPORT_EMAIL = "support@printexec.xyz";
// Hosted footer image (coordinate-rain + PrintExec wordmark), served from the
// marketing site's static assets (website/public/email-footer.png). A PNG renders
// in every mail client, unlike the inline SVG rain that Gmail/Outlook strip.
const FOOTER_IMG_URL = "https://printexec.xyz/email-footer.png";

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

/** Escape user/customer-supplied text before inlining it into HTML. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildText(data: OrderCompletionEmailData): string {
  const { company, customer, order } = data;
  const copy = STATUS_COPY[order.status];
  const greetingName = customer.contactName || customer.displayName || "there";

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

  const yourDetails: string[] = [row("Customer", customer.displayName)];
  if (customer.isBusiness && customer.contactName) {
    yourDetails.push(row("Contact", customer.contactName));
  }
  if (customer.phone) yourDetails.push(row("Phone", customer.phone));
  if (customer.secondaryPhone) yourDetails.push(row("Alt. phone", customer.secondaryPhone));
  yourDetails.push(row("Email", customer.email));

  const contactLines: string[] = [`  ${company.name}`];
  if (company.phone) contactLines.push(`  ${company.phone}`);
  if (company.email) contactLines.push(`  ${company.email}`);
  if (company.website) contactLines.push(`  ${company.website}`);

  return [
    `PRINTEXEC`,
    ``,
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
    `— The ${company.name} team`,
    `Fulfilled by PrintExec · ${SITE_URL}`
  ].join("\n");
}

function summaryRowHtml(label: string, value: string): string {
  return (
    `<tr>` +
    `<td style="padding:6px 0;font-family:${MONO};font-size:12px;color:${SUBTLE};` +
    `letter-spacing:0.04em;text-transform:uppercase;white-space:nowrap;vertical-align:top;">${esc(label)}</td>` +
    `<td style="padding:6px 0 6px 18px;font-family:${SANS};font-size:14px;color:${INK};` +
    `vertical-align:top;">${esc(value)}</td>` +
    `</tr>`
  );
}

function buildHtml(data: OrderCompletionEmailData): string {
  const { company, customer, order } = data;
  const copy = STATUS_COPY[order.status];
  const greetingName = customer.contactName || customer.displayName || "there";

  // Order summary rows
  const rows: string[] = [
    summaryRowHtml("Order", order.orderNumber),
    summaryRowHtml("Title", order.title),
    summaryRowHtml("Status", copy.label)
  ];
  if (order.description) rows.push(summaryRowHtml("Details", order.description));
  rows.push(summaryRowHtml("Pieces", String(order.pieceCount)));
  const placed = formatDate(order.establishedAt);
  if (placed) rows.push(summaryRowHtml("Placed", placed));
  const due = formatDate(order.deadline);
  if (due) rows.push(summaryRowHtml("Due by", due));
  const total = formatMoney(order.total, company.currency);
  if (total) rows.push(summaryRowHtml("Total", total));

  // Customer / contact rows
  const detail: string[] = [summaryRowHtml("Customer", customer.displayName)];
  if (customer.isBusiness && customer.contactName) detail.push(summaryRowHtml("Contact", customer.contactName));
  if (customer.phone) detail.push(summaryRowHtml("Phone", customer.phone));
  if (customer.secondaryPhone) detail.push(summaryRowHtml("Alt. phone", customer.secondaryPhone));
  detail.push(summaryRowHtml("Email", customer.email));

  // Company contact line
  const contactBits: string[] = [];
  if (company.phone) contactBits.push(esc(company.phone));
  if (company.email) contactBits.push(esc(company.email));
  if (company.website) contactBits.push(esc(company.website));
  const contactLine = contactBits.join("&nbsp;&nbsp;·&nbsp;&nbsp;");

  return [
    `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;opacity:0;">` +
      `Your order ${esc(order.orderNumber)} is ${esc(copy.label.toLowerCase())} — ${esc(company.name)}</div>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f5;margin:0;padding:0;">`,
    `<tr><td align="center" style="padding:24px 12px;">`,
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:${PAPER};border:1px solid ${INK};">`,

    // ── Header: company logo, top-right, over the plain 2px separator. Its
    // height is pinned to the reserved 28px so the bar's dimensions never change;
    // when the company has no logo we keep the original blank bar untouched.
    // (SVG logos may not render in Gmail/Outlook — the alt text carries the name.)
    `<tr><td style="background:${PAPER};border-bottom:2px solid ${INK};padding:18px 24px;" align="right">` +
      (company.logoUrl
        ? `<img src="${company.logoUrl}" alt="${esc(company.name)}" height="28" ` +
            `style="display:inline-block;height:28px;max-height:28px;width:auto;max-width:200px;border:0;outline:none;" />`
        : `<div style="height:28px;line-height:28px;">&nbsp;</div>`) +
      `</td></tr>`,

    // ── Body ──
    `<tr><td style="padding:30px 28px 6px;font-family:${SANS};color:${INK};">` +
      `<p style="margin:0 0 14px;font-size:15px;">Hi ${esc(greetingName)},</p>` +
      `<p style="margin:0 0 18px;font-size:20px;font-weight:700;line-height:1.3;font-family:${SANS};">` +
        `Your order with ${esc(company.name)} is ${esc(copy.phrase)}.</p>` +
      `<span style="display:inline-block;background:${INK};color:${PAPER};font-family:${MONO};` +
        `font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;padding:7px 13px;">` +
        `${esc(copy.label)}</span>` +
      `</td></tr>`,

    // ── Order summary ──
    `<tr><td style="padding:24px 28px 4px;font-family:${SANS};">` +
      `<div style="font-family:${MONO};font-size:11px;font-weight:700;letter-spacing:0.16em;` +
        `text-transform:uppercase;color:${INK};border-bottom:1px solid ${INK};padding-bottom:8px;margin-bottom:6px;">Order summary</div>` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows.join("")}</table>` +
      `</td></tr>`,

    // ── Your details ──
    `<tr><td style="padding:18px 28px 8px;font-family:${SANS};">` +
      `<div style="font-family:${MONO};font-size:11px;font-weight:700;letter-spacing:0.16em;` +
        `text-transform:uppercase;color:${INK};border-bottom:1px solid ${INK};padding-bottom:8px;margin-bottom:6px;">Your details</div>` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${detail.join("")}</table>` +
      `</td></tr>`,

    // ── Company contact / no-reply ──
    `<tr><td style="padding:20px 28px 24px;font-family:${SANS};font-size:13px;color:${SUBTLE};line-height:1.6;">` +
      `<p style="margin:0 0 10px;">This is an automated update from an unmonitored address — please don't reply.</p>` +
      `<p style="margin:0 0 4px;color:${INK};font-weight:700;">${esc(company.name)}</p>` +
      (contactLine ? `<p style="margin:0;">${contactLine}</p>` : ``) +
      `<p style="margin:14px 0 0;color:${INK};">Thank you for choosing ${esc(company.name)}!</p>` +
      `</td></tr>`,

    // ── Footer: a single hosted PNG — the coordinate-rain + PrintExec wordmark,
    // wrapped in one link to the site. A PNG renders in every client (Gmail /
    // Outlook strip inline SVG); the whole strip is one click target, and the
    // black bgcolor + alt keep it graceful if images are blocked.
    `<tr><td bgcolor="${INK}" style="background:${INK};font-size:0;line-height:0;padding:0;">` +
      `<a href="${SITE_URL}" target="_blank" rel="noopener" style="display:block;text-decoration:none;">` +
        `<img src="${FOOTER_IMG_URL}" alt="PrintExec — printexec.xyz" width="600" height="77" ` +
          `style="display:block;width:100%;max-width:600px;height:auto;border:0;outline:none;" />` +
      `</a>` +
      `</td></tr>`,

    `</table>`,
    `</td></tr>`,
    `</table>`
  ].join("");
}

export function composeOrderCompletionEmail(data: OrderCompletionEmailData): ComposedEmail {
  const { company, order } = data;
  const copy = STATUS_COPY[order.status];
  const subject = `Your order ${order.orderNumber} is ${copy.label.toLowerCase()} — ${company.name}`;
  return { subject, text: buildText(data), html: buildHtml(data) };
}

// ════════════════════════════════════════════════════════════════
// STAFF INVITE EMAIL
//
// Sent (optionally) when an owner/manager creates a team invite code and asks
// for it to be emailed to the invitee. Same brand idiom + table/inline-style
// discipline as the order email above; the invite CODE is the hero element
// (mirrors the auth verify screen's code treatment).
// ════════════════════════════════════════════════════════════════

export type StaffInviteEmailData = {
  companyName: string;
  inviteToken: string;
  /** ISO timestamp the code stops working. */
  expiresAt: string | Date;
  /** Display name of whoever created the invite (best-effort). */
  invitedByName: string | null;
  /** Absolute app origin the CTA links to, e.g. https://solution.printexec.xyz */
  appUrl: string;
};

function formatExpiry(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "48 hours";
  return d.toLocaleString("en-US", {
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "UTC"
  }) + " UTC";
}

export function composeStaffInviteEmail(data: StaffInviteEmailData): ComposedEmail {
  const { companyName, inviteToken, expiresAt, invitedByName, appUrl } = data;
  const expiry = formatExpiry(expiresAt);
  const inviter = invitedByName?.trim() || null;

  const subject = `You're invited to join ${companyName} on PrintExec`;

  const text = [
    `PRINTEXEC`,
    ``,
    `Hi,`,
    ``,
    inviter
      ? `${inviter} invited you to join ${companyName}'s workspace on PrintExec.`
      : `You've been invited to join ${companyName}'s workspace on PrintExec.`,
    ``,
    `Your invite code:`,
    ``,
    `    ${inviteToken}`,
    ``,
    `To join:`,
    `  1. Open ${appUrl}`,
    `  2. Choose "Create account", then "Join a team"`,
    `  3. Enter the invite code above`,
    ``,
    `This code works once and expires ${expiry}.`,
    ``,
    `This is an automated email from an unmonitored address — please don't reply.`,
    `Fulfilled by PrintExec · ${SITE_URL}`
  ].join("\n");

  const html = [
    `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;opacity:0;">` +
      `Your invite code for ${esc(companyName)} on PrintExec</div>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f5;margin:0;padding:0;">`,
    `<tr><td align="center" style="padding:24px 12px;">`,
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:${PAPER};border:1px solid ${INK};">`,

    // ── Header: PRINTEXEC wordmark bar ──
    `<tr><td style="background:${INK};padding:16px 24px;">` +
      `<span style="font-family:${MONO};font-size:15px;font-weight:700;letter-spacing:0.2em;color:${PAPER};">PRINTEXEC</span>` +
      `</td></tr>`,

    // ── Body ──
    `<tr><td style="padding:30px 28px 8px;font-family:${SANS};color:${INK};">` +
      `<p style="margin:0 0 14px;font-size:15px;">Hi,</p>` +
      `<p style="margin:0 0 20px;font-size:20px;font-weight:700;line-height:1.3;">` +
        (inviter
          ? `${esc(inviter)} invited you to join ${esc(companyName)}'s workspace.`
          : `You've been invited to join ${esc(companyName)}'s workspace.`) +
      `</p>` +
      `</td></tr>`,

    // ── The code (hero) ──
    `<tr><td align="center" style="padding:4px 28px 6px;">` +
      `<div style="display:inline-block;border:2px solid ${INK};padding:16px 28px;">` +
        `<span style="font-family:${MONO};font-size:26px;font-weight:700;letter-spacing:0.3em;color:${INK};">${esc(inviteToken)}</span>` +
      `</div>` +
      `<div style="margin-top:10px;font-family:${MONO};font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:${SUBTLE};">Invite code · single use · expires ${esc(expiry)}</div>` +
      `</td></tr>`,

    // ── Steps ──
    `<tr><td style="padding:22px 28px 8px;font-family:${SANS};font-size:14px;color:${INK};line-height:1.8;">` +
      `<div style="font-family:${MONO};font-size:11px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;border-bottom:1px solid ${INK};padding-bottom:8px;margin-bottom:10px;">How to join</div>` +
      `1&nbsp;&nbsp;Open <a href="${appUrl}" target="_blank" rel="noopener" style="color:${INK};font-weight:700;">${esc(appUrl.replace(/^https?:\/\//, ""))}</a><br/>` +
      `2&nbsp;&nbsp;Choose <b>Create account</b>, then <b>Join a team</b><br/>` +
      `3&nbsp;&nbsp;Enter the invite code above` +
      `</td></tr>`,

    // ── No-reply note ──
    `<tr><td style="padding:18px 28px 24px;font-family:${SANS};font-size:12.5px;color:${SUBTLE};line-height:1.6;">` +
      `This is an automated email from an unmonitored address — please don't reply. ` +
      `If you weren't expecting this invite, you can ignore it.` +
      `</td></tr>`,

    // ── Footer: rain strip ──
    `<tr><td bgcolor="${INK}" style="background:${INK};font-size:0;line-height:0;padding:0;">` +
      `<a href="${SITE_URL}" target="_blank" rel="noopener" style="display:block;text-decoration:none;">` +
        `<img src="${FOOTER_IMG_URL}" alt="PrintExec — printexec.xyz" width="600" height="77" ` +
          `style="display:block;width:100%;max-width:600px;height:auto;border:0;outline:none;" />` +
      `</a>` +
      `</td></tr>`,

    `</table>`,
    `</td></tr>`,
    `</table>`
  ].join("");

  return { subject, text, html };
}

// ════════════════════════════════════════════════════════════════
// LICENSE / PLAN NOTICES (platform → workspace owner)
//
// The LicenseNotificationsService sweep composes these as a company's trial
// or paid period approaches its end and again once it lapses. Platform mail,
// not company mail: PRINTEXEC wordmark header (like the staff invite), no
// per-company logo. Same table/inline-style discipline; pure composition.
// ════════════════════════════════════════════════════════════════

export type LicenseNoticeKind =
  | "trial_ending"
  | "trial_ended"
  | "renewal_due"
  | "plan_lapsed"
  | "plan_readonly";

export type LicenseNoticeEmailData = {
  kind: LicenseNoticeKind;
  companyName: string;
  planName: string;
  /** The trial/plan period end this notice is about. */
  periodEnd: string | Date | null;
  /** Whole days until periodEnd (for trial_ending / renewal_due). */
  daysLeft: number | null;
  /** When the grace window lapses into read-only (renewal_due / plan_lapsed). */
  graceUntil: string | Date | null;
  /** Length of the paid-plan grace window, for the explanatory copy. */
  graceDays: number;
  /** Absolute app origin the CTA links to. */
  appUrl: string;
};

const dayWord = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

/** Shared wordmark header + rain footer wrapping for platform emails. */
function platformShellHtml(preheader: string, innerRows: string[]): string {
  return [
    `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;opacity:0;">${esc(preheader)}</div>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f5;margin:0;padding:0;">`,
    `<tr><td align="center" style="padding:24px 12px;">`,
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:${PAPER};border:1px solid ${INK};">`,
    // ── Header: PRINTEXEC wordmark bar ──
    `<tr><td style="background:${INK};padding:16px 24px;">` +
      `<span style="font-family:${MONO};font-size:15px;font-weight:700;letter-spacing:0.2em;color:${PAPER};">PRINTEXEC</span>` +
      `</td></tr>`,
    ...innerRows,
    // ── Footer: rain strip ──
    `<tr><td bgcolor="${INK}" style="background:${INK};font-size:0;line-height:0;padding:0;">` +
      `<a href="${SITE_URL}" target="_blank" rel="noopener" style="display:block;text-decoration:none;">` +
        `<img src="${FOOTER_IMG_URL}" alt="PrintExec — printexec.xyz" width="600" height="77" ` +
          `style="display:block;width:100%;max-width:600px;height:auto;border:0;outline:none;" />` +
      `</a>` +
      `</td></tr>`,
    `</table>`,
    `</td></tr>`,
    `</table>`
  ].join("");
}

/** Ink-filled CTA button (email-safe: a padded anchor, no CSS classes). */
function ctaButtonHtml(label: string, href: string): string {
  return (
    `<a href="${href}" target="_blank" rel="noopener" ` +
    `style="display:inline-block;background:${INK};color:${PAPER};font-family:${SANS};` +
    `font-size:14px;font-weight:700;text-decoration:none;padding:12px 26px;">${esc(label)}</a>`
  );
}

/** Per-kind subject, headline and explanation copy. */
function licenseNoticeCopy(data: LicenseNoticeEmailData): {
  subject: string;
  headline: string;
  paragraphs: string[];
  cta: string;
} {
  const end = formatDate(data.periodEnd) ?? "soon";
  const grace = formatDate(data.graceUntil);
  const days = data.daysLeft;

  switch (data.kind) {
    case "trial_ending": {
      const when = days !== null && days > 0 ? `in ${dayWord(days)}` : "today";
      return {
        subject: `Your PrintExec trial ends ${when}`,
        headline: `Your free trial ends ${when} — on ${end}.`,
        paragraphs: [
          `When the trial ends, the ${data.companyName} workspace becomes read-only: all your data stays exactly where it is, but new work is paused until a plan is active.`,
          `Pick a plan (or redeem a grant code) in Plan & billing to keep everything running without interruption.`
        ],
        cta: "Choose your plan"
      };
    }
    case "trial_ended":
      return {
        subject: "Your PrintExec trial has ended — pick a plan to keep working",
        headline: `Your free trial ended on ${end}.`,
        paragraphs: [
          `The ${data.companyName} workspace is now read-only. Nothing has been deleted — every order, job and asset is safe — but new work is paused until a plan is active.`,
          `Choose a plan (or redeem a grant code) in Plan & billing and you'll be back to work in minutes.`
        ],
        cta: "Choose your plan"
      };
    case "renewal_due": {
      const when = days !== null && days > 0 ? `in ${dayWord(days)}` : "today";
      return {
        subject: `Your ${data.planName} plan period ends ${when}`,
        headline: `Your ${data.planName} plan runs to ${end}.`,
        paragraphs: [
          `To keep the ${data.companyName} workspace uninterrupted, renew before then. If the period lapses, you'll have a ${data.graceDays}-day grace window${grace ? ` (until ${grace})` : ""} before the workspace goes read-only.`,
          `You can review or change your plan any time in Plan & billing.`
        ],
        cta: "Review your plan"
      };
    }
    case "plan_lapsed":
      return {
        subject: `Your ${data.planName} plan has lapsed — grace window running`,
        headline: `Your ${data.planName} plan lapsed on ${end}.`,
        paragraphs: [
          `The ${data.companyName} workspace is in its grace window${grace ? ` until ${grace}` : ""}: day-to-day work continues, but adding printers is paused. After that, the workspace goes read-only until the plan is renewed.`,
          `Renew in Plan & billing to clear this — it takes a minute.`
        ],
        cta: "Renew your plan"
      };
    case "plan_readonly":
      return {
        subject: "Your PrintExec workspace is now read-only",
        headline: `The grace window has ended — your workspace is read-only.`,
        paragraphs: [
          `Your ${data.planName} plan lapsed on ${end} and the grace window has now run out, so the ${data.companyName} workspace is read-only. All your data is safe and waiting.`,
          `Renew your plan (or redeem a grant code) in Plan & billing to unlock the workspace immediately.`
        ],
        cta: "Renew your plan"
      };
  }
}

export function composeLicenseNoticeEmail(data: LicenseNoticeEmailData): ComposedEmail {
  const copy = licenseNoticeCopy(data);

  const text = [
    `PRINTEXEC`,
    ``,
    `Hi,`,
    ``,
    copy.headline,
    ``,
    ...copy.paragraphs.flatMap((p) => [p, ``]),
    `${copy.cta}: ${data.appUrl} → account menu → Plan & billing`,
    ``,
    `Need a hand? Reach us at ${SUPPORT_EMAIL}.`,
    ``,
    `This is an automated notice from an unmonitored address — please don't reply.`,
    `— The PrintExec team · ${SITE_URL}`
  ].join("\n");

  const inner = [
    `<tr><td style="padding:30px 28px 6px;font-family:${SANS};color:${INK};">` +
      `<p style="margin:0 0 14px;font-size:15px;">Hi,</p>` +
      `<p style="margin:0 0 18px;font-size:20px;font-weight:700;line-height:1.3;">${esc(copy.headline)}</p>` +
      copy.paragraphs
        .map((p) => `<p style="margin:0 0 14px;font-size:14px;line-height:1.65;">${esc(p)}</p>`)
        .join("") +
      `</td></tr>`,
    `<tr><td style="padding:8px 28px 10px;">${ctaButtonHtml(copy.cta, data.appUrl)}` +
      `<div style="margin-top:10px;font-family:${MONO};font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:${SUBTLE};">` +
      `Open PrintExec → account menu → Plan &amp; billing</div>` +
      `</td></tr>`,
    `<tr><td style="padding:16px 28px 24px;font-family:${SANS};font-size:12.5px;color:${SUBTLE};line-height:1.6;">` +
      `Need a hand? Reach us at <a href="mailto:${SUPPORT_EMAIL}" style="color:${INK};font-weight:700;">${SUPPORT_EMAIL}</a>.<br/>` +
      `This is an automated notice from an unmonitored address — please don't reply.` +
      `</td></tr>`
  ];

  return { subject: copy.subject, text, html: platformShellHtml(copy.headline, inner) };
}

// ════════════════════════════════════════════════════════════════
// PLATFORM CUSTOM EMAIL (admin → workspace owner)
//
// A platform admin writes subject + body in the licensing admin area (single
// or bulk, with {{variables}} already substituted by the caller). The body is
// plain text; blank lines split paragraphs.
// ════════════════════════════════════════════════════════════════

export type PlatformEmailData = {
  subject: string;
  /** Plain-text body; blank lines separate paragraphs. */
  body: string;
  companyName: string;
};

export function composePlatformEmail(data: PlatformEmailData): ComposedEmail {
  const paragraphs = data.body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  // The signature links to the marketing site (printexec.xyz), never the app —
  // recipients reach a human at SUPPORT_EMAIL, not by replying.
  const siteHost = SITE_URL.replace(/^https?:\/\//, "");
  const text = [
    `PRINTEXEC`,
    ``,
    ...paragraphs.flatMap((p) => [p, ``]),
    `Sent to the owner of ${data.companyName}. Learn more at ${SITE_URL}.`,
    `This address is unmonitored — to get in touch, write to ${SUPPORT_EMAIL}.`,
    `— The PrintExec team`
  ].join("\n");

  const inner = [
    `<tr><td style="padding:30px 28px 12px;font-family:${SANS};color:${INK};">` +
      paragraphs
        .map(
          (p) =>
            `<p style="margin:0 0 14px;font-size:14.5px;line-height:1.7;">${esc(p).replace(/\n/g, "<br/>")}</p>`
        )
        .join("") +
      `</td></tr>`,
    `<tr><td style="padding:4px 28px 24px;font-family:${SANS};font-size:12.5px;color:${SUBTLE};line-height:1.6;">` +
      `Sent to the owner of ${esc(data.companyName)} · ` +
      `<a href="${SITE_URL}" target="_blank" rel="noopener" style="color:${INK};font-weight:700;">${esc(siteHost)}</a><br/>` +
      `This address is unmonitored — to get in touch, write to ` +
      `<a href="mailto:${SUPPORT_EMAIL}" style="color:${INK};font-weight:700;">${SUPPORT_EMAIL}</a>.` +
      `</td></tr>`
  ];

  return {
    subject: data.subject,
    text,
    html: platformShellHtml(paragraphs[0] ?? data.subject, inner)
  };
}

// ════════════════════════════════════════════════════════════════
// SUBSCRIPTION INVOICE (platform → workspace owner)
//
// Issued by PrintExec when a company's subscription is activated onto a plan
// (grant redeemed, plan assigned, payment settled). A proper invoice: number,
// issue date, issued-by / billed-to, a line item for the plan + period, the
// total, and the subscription details. Same platform chrome + table/inline
// discipline as the notices above; pure composition.
// ════════════════════════════════════════════════════════════════

export type SubscriptionInvoiceEmailData = {
  invoiceNumber: string;
  issuedAt: string | Date;
  company: {
    name: string;
    ownerEmail: string | null;
    city?: string | null;
    countryCode?: string | null;
  };
  plan: { name: string; maxPrinters: number | null };
  amountUsd: number;
  currency: string;
  /** How the subscription was obtained: grant_code | manual | stripe | payoneer. */
  source: string;
  periodStart: string | Date | null;
  periodEnd: string | Date | null;
  /** Raw subscription status (active | trialing | …) for the details block. */
  status: string;
  /** Free-text ("Complimentary access", "Billed per agreement", …) or null. */
  note: string | null;
  /** App origin for the "view billing" link. */
  appUrl: string;
};

const SOURCE_LABELS: Record<string, string> = {
  grant_code: "Grant code",
  manual: "Assigned by PrintExec",
  stripe: "Card payment",
  payoneer: "Payoneer",
  trial: "Trial"
};
const sourceLabel = (s: string) => SOURCE_LABELS[s] ?? s;

/** "June 1, 2026 – July 1, 2026" / "through July 1, 2026" / "Ongoing". */
function billingPeriodText(start: string | Date | null, end: string | Date | null): string {
  const s = formatDate(start);
  const e = formatDate(end);
  if (s && e) return `${s} – ${e}`;
  if (e) return `Through ${e}`;
  if (s) return `From ${s}`;
  return "Ongoing";
}

const capText = (cap: number | null) => (cap === null ? "Unlimited printers" : `Up to ${cap} printers`);

export function composeSubscriptionInvoiceEmail(data: SubscriptionInvoiceEmailData): ComposedEmail {
  const issued = formatDate(data.issuedAt) ?? "";
  const amount = formatMoney(data.amountUsd, data.currency) ?? `${data.currency} 0.00`;
  const period = billingPeriodText(data.periodStart, data.periodEnd);
  const lineDesc = `PrintExec ${data.plan.name} plan`;
  const subject = `Your PrintExec invoice ${data.invoiceNumber} — ${data.plan.name} plan`;

  const billedTo: string[] = [data.company.name];
  if (data.company.ownerEmail) billedTo.push(data.company.ownerEmail);
  const loc = [data.company.city, data.company.countryCode].filter(Boolean).join(", ");
  if (loc) billedTo.push(loc);

  // ── Plain text ──
  const text = [
    `PRINTEXEC`,
    ``,
    `INVOICE ${data.invoiceNumber}`,
    `Issued ${issued}`,
    ``,
    `Issued by`,
    `  PrintExec`,
    `  ${SITE_URL.replace(/^https?:\/\//, "")}`,
    `  ${SUPPORT_EMAIL}`,
    ``,
    `Billed to`,
    ...billedTo.map((l) => `  ${l}`),
    ``,
    `Description                              Amount`,
    `${lineDesc.padEnd(40, " ").slice(0, 40)} ${amount}`,
    `  Billing period: ${period}`,
    `${"".padEnd(40, " ")} ─────────`,
    `${"Total".padEnd(40, " ")} ${amount}`,
    ...(data.note ? [``, data.note] : []),
    ``,
    `Subscription`,
    `  Plan:     ${data.plan.name} (${capText(data.plan.maxPrinters)})`,
    `  Status:   ${data.status}`,
    `  Obtained: ${sourceLabel(data.source)}`,
    `  Renews:   ${formatDate(data.periodEnd) ?? "Ongoing (until changed)"}`,
    ``,
    `View your plan & billing: ${data.appUrl} → account menu → Plan & billing`,
    ``,
    `This is an automated invoice from an unmonitored address — please don't reply.`,
    `Questions about billing? ${SUPPORT_EMAIL}`,
    `— PrintExec · ${SITE_URL}`
  ].join("\n");

  // ── HTML ──
  const label = (t: string) =>
    `<div style="font-family:${MONO};font-size:10px;font-weight:700;letter-spacing:0.14em;` +
    `text-transform:uppercase;color:${SUBTLE};margin-bottom:5px;">${esc(t)}</div>`;

  const detailRow = (k: string, v: string) =>
    `<tr>` +
    `<td style="padding:5px 0;font-family:${MONO};font-size:11px;color:${SUBTLE};` +
    `text-transform:uppercase;letter-spacing:0.04em;white-space:nowrap;vertical-align:top;">${esc(k)}</td>` +
    `<td style="padding:5px 0 5px 16px;font-family:${SANS};font-size:13.5px;color:${INK};vertical-align:top;">${esc(v)}</td>` +
    `</tr>`;

  const inner = [
    // ── Invoice heading: number + issue date ──
    `<tr><td style="padding:28px 28px 6px;font-family:${SANS};color:${INK};">` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
        `<td style="vertical-align:top;">` +
          `<div style="font-family:${MONO};font-size:12px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;color:${INK};">Invoice</div>` +
          `<div style="font-family:${MONO};font-size:15px;font-weight:700;margin-top:3px;">${esc(data.invoiceNumber)}</div>` +
        `</td>` +
        `<td align="right" style="vertical-align:top;font-family:${SANS};font-size:12px;color:${SUBTLE};">` +
          `Issued<br/><span style="color:${INK};font-weight:700;font-size:13.5px;">${esc(issued)}</span>` +
        `</td>` +
      `</tr></table>` +
      `</td></tr>`,

    // ── Issued by / Billed to ──
    `<tr><td style="padding:16px 28px 6px;font-family:${SANS};">` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
        `<td style="vertical-align:top;width:50%;">` +
          label("Issued by") +
          `<div style="font-size:13.5px;color:${INK};font-weight:700;">PrintExec</div>` +
          `<div style="font-size:12.5px;color:${SUBTLE};line-height:1.5;">${esc(SITE_URL.replace(/^https?:\/\//, ""))}<br/>${SUPPORT_EMAIL}</div>` +
        `</td>` +
        `<td style="vertical-align:top;width:50%;">` +
          label("Billed to") +
          `<div style="font-size:13.5px;color:${INK};font-weight:700;">${esc(data.company.name)}</div>` +
          `<div style="font-size:12.5px;color:${SUBTLE};line-height:1.5;">${billedTo.slice(1).map(esc).join("<br/>")}</div>` +
        `</td>` +
      `</tr></table>` +
      `</td></tr>`,

    // ── Line items + total ──
    `<tr><td style="padding:20px 28px 6px;font-family:${SANS};">` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:2px solid ${INK};border-bottom:1px solid ${INK};">` +
        `<tr>` +
          `<td style="padding:10px 0 6px;font-family:${MONO};font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${SUBTLE};">Description</td>` +
          `<td align="right" style="padding:10px 0 6px;font-family:${MONO};font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${SUBTLE};">Amount</td>` +
        `</tr>` +
        `<tr>` +
          `<td style="padding:4px 0 12px;font-family:${SANS};font-size:14px;color:${INK};">` +
            `${esc(lineDesc)}<br/><span style="font-size:12px;color:${SUBTLE};">Billing period: ${esc(period)}</span>` +
          `</td>` +
          `<td align="right" style="padding:4px 0 12px;font-family:${SANS};font-size:14px;color:${INK};white-space:nowrap;vertical-align:top;">${esc(amount)}</td>` +
        `</tr>` +
      `</table>` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
        `<td style="padding:10px 0;font-family:${SANS};font-size:13px;font-weight:700;color:${INK};text-transform:uppercase;letter-spacing:0.04em;">Total</td>` +
        `<td align="right" style="padding:10px 0;font-family:${SANS};font-size:17px;font-weight:800;color:${INK};white-space:nowrap;">${esc(amount)}</td>` +
      `</tr></table>` +
      (data.note ? `<div style="font-family:${SANS};font-size:12px;color:${SUBTLE};margin-top:2px;">${esc(data.note)}</div>` : ``) +
      `</td></tr>`,

    // ── Subscription details ──
    `<tr><td style="padding:14px 28px 6px;font-family:${SANS};">` +
      `<div style="font-family:${MONO};font-size:11px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:${INK};border-bottom:1px solid ${INK};padding-bottom:8px;margin-bottom:6px;">Subscription</div>` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">` +
        detailRow("Plan", `${data.plan.name} · ${capText(data.plan.maxPrinters)}`) +
        detailRow("Status", data.status) +
        detailRow("Obtained", sourceLabel(data.source)) +
        detailRow("Renews", formatDate(data.periodEnd) ?? "Ongoing (until changed)") +
      `</table>` +
      `</td></tr>`,

    // ── CTA + no-reply ──
    `<tr><td style="padding:18px 28px 8px;">${ctaButtonHtml("View plan & billing", data.appUrl)}</td></tr>`,
    `<tr><td style="padding:8px 28px 24px;font-family:${SANS};font-size:12.5px;color:${SUBTLE};line-height:1.6;">` +
      `This is an automated invoice from an unmonitored address — please don't reply.<br/>` +
      `Questions about billing? <a href="mailto:${SUPPORT_EMAIL}" style="color:${INK};font-weight:700;">${SUPPORT_EMAIL}</a>.` +
      `</td></tr>`
  ];

  return { subject, text, html: platformShellHtml(subject, inner) };
}

// ════════════════════════════════════════════════════════════════
// CUSTOMER INVOICE — the tenant bills THEIR customer
//
// Sent when a shop issues an invoice (see invoice-notifications.service.ts).
// The issuer is the SHOP, not PrintExec: it uses the same tenant-branded shell
// as the order-completion email (company logo header, PrintExec only in the
// footer strip), never the platform shell that composeSubscriptionInvoiceEmail
// uses for PrintExec's own billing.
//
// The lines and totals are repeated in the body rather than left to the PDF
// alone: plenty of people read the mail on a phone and never open an
// attachment, and a bill they can't read is a bill they don't pay.
// ════════════════════════════════════════════════════════════════

export type CustomerInvoiceLine = {
  description: string;
  quantity: number;
  unitPrice: number;
  /** NET: quantity × unitPrice, excluding tax (the DB's generated `amount`). */
  amount: number;
  /** The rate applied to this line; 0 for an untaxed/exempt line. */
  taxPct: number;
  /** The tax that rate produced. `amount + taxAmount` is the line's gross. */
  taxAmount: number;
};

export type CustomerInvoiceEmailData = {
  company: {
    name: string;
    slogan: string | null;
    phone: string | null;
    email: string | null;
    website: string | null;
    city: string | null;
    countryCode: string | null;
    logoUrl: string | null;
  };
  customer: {
    displayName: string;
    contactName: string | null;
    email: string | null;
    phone: string | null;
    isBusiness: boolean;
  };
  invoice: {
    number: string;
    issueDate: string | Date | null;
    dueDate: string | Date | null;
    currency: string | null;
    lines: CustomerInvoiceLine[];
    subtotal: number;
    taxTotal: number;
    /** The single rate every taxed line shares; null when they differ or none.
     *  Only used to NAME the tax — the figures are computed server-side. */
    taxPct: number | null;
    total: number;
    amountPaid: number;
    balanceDue: number;
    memo: string | null;
    terms: string | null;
    orderNumber: string | null;
    orderTitle: string | null;
  };
};

// ── Tax vocabulary ───────────────────────────────────────────────────────────
// These documents are tax-EXCLUSIVE: a line's amount is qty × unit price and the
// subtotal is the sum of those, so tax appears only in the total. Saying plain
// "Subtotal" and "Total" left the customer to guess which side of tax each was
// on — the labels now say it. Mirrors invoicePrint.ts on the client; the two
// must agree, because they render the same invoice.
export const SUBTOTAL_LABEL = "Subtotal (excl. tax)";
export const TOTAL_LABEL = "Total (incl. tax)";
export const taxTotalLabel = (pct: number | null): string =>
  pct == null ? "Tax" : `VAT (${pct.toLocaleString("en-US", { maximumFractionDigits: 2 })}%)`;

/** Quantities are NUMERIC(12,3) — hide the decimals when they say nothing. */
function formatQuantity(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
}

function invoiceLineRowHtml(line: CustomerInvoiceLine, currency: string | null): string {
  const qty = formatQuantity(line.quantity);
  const unit = formatMoney(line.unitPrice, null) ?? "";
  return (
    `<tr>` +
    `<td style="padding:9px 0;border-bottom:1px solid #e7e5e4;font-family:${SANS};font-size:13.5px;color:${INK};vertical-align:top;">` +
      `${esc(line.description)}` +
      `<br/><span style="font-family:${MONO};font-size:11px;color:${SUBTLE};">${esc(qty)} × ${esc(unit)}</span>` +
    `</td>` +
    `<td align="right" style="padding:9px 0 9px 14px;border-bottom:1px solid #e7e5e4;font-family:${SANS};` +
      `font-size:13.5px;color:${INK};white-space:nowrap;vertical-align:top;">` +
      `${esc(formatMoney(line.amount, currency) ?? "")}</td>` +
    `</tr>`
  );
}

function invoiceTotalRowHtml(label: string, value: string, strong: boolean): string {
  const weight = strong ? "800" : "400";
  const size = strong ? "16px" : "13.5px";
  const color = strong ? INK : SUBTLE;
  const border = strong ? `border-top:1px solid ${INK};` : "";
  return (
    `<tr>` +
    `<td style="padding:8px 0;${border}font-family:${SANS};font-size:13px;font-weight:${strong ? "700" : "400"};` +
      `color:${color};text-transform:uppercase;letter-spacing:0.04em;">${esc(label)}</td>` +
    `<td align="right" style="padding:8px 0 8px 14px;${border}font-family:${SANS};font-size:${size};` +
      `font-weight:${weight};color:${INK};white-space:nowrap;">${esc(value)}</td>` +
    `</tr>`
  );
}

function buildCustomerInvoiceText(data: CustomerInvoiceEmailData): string {
  const { company, customer, invoice } = data;
  const greetingName = customer.contactName || customer.displayName || "there";
  const money = (v: number) => formatMoney(v, invoice.currency) ?? String(v);

  const header: string[] = [row("Invoice", invoice.number)];
  const issued = formatDate(invoice.issueDate);
  if (issued) header.push(row("Issued", issued));
  const due = formatDate(invoice.dueDate);
  if (due) header.push(row("Due", due));
  if (invoice.orderNumber) header.push(row("Order", invoice.orderNumber));
  if (invoice.orderTitle) header.push(row("Job", invoice.orderTitle));

  const items = invoice.lines.map(
    (l) =>
      `  ${l.description}\n` +
      `    ${formatQuantity(l.quantity)} × ${formatMoney(l.unitPrice, null)}` +
      `   =   ${formatMoney(l.amount, invoice.currency)}`
  );

  const totals: string[] = [row(SUBTOTAL_LABEL, money(invoice.subtotal))];
  if (invoice.taxTotal > 0) totals.push(row(taxTotalLabel(invoice.taxPct), money(invoice.taxTotal)));
  totals.push(row(TOTAL_LABEL, money(invoice.total)));
  if (invoice.amountPaid > 0) {
    totals.push(row("Paid", `- ${money(invoice.amountPaid)}`));
    totals.push(row("Balance due", money(invoice.balanceDue)));
  }

  const notes = [invoice.terms, invoice.memo].filter(
    (n): n is string => !!n && n.trim().length > 0
  );

  const contactLines: string[] = [`  ${company.name}`];
  if (company.phone) contactLines.push(`  ${company.phone}`);
  if (company.email) contactLines.push(`  ${company.email}`);
  if (company.website) contactLines.push(`  ${company.website}`);

  return [
    company.name.toUpperCase(),
    ``,
    `Hi ${greetingName},`,
    ``,
    `Here is your invoice from ${company.name}. The full document is attached as a PDF.`,
    ``,
    `Invoice`,
    `───────`,
    ...header,
    ``,
    `Items`,
    `─────`,
    ...items,
    ``,
    ...totals,
    ...(notes.length > 0 ? [``, `Notes`, `─────`, ...notes.map((n) => `  ${n}`)] : []),
    ``,
    `This invoice was sent from an unmonitored address — please don't reply.`,
    `For anything about this invoice, contact us directly:`,
    ...contactLines,
    ``,
    `Thank you for your business.`,
    ``,
    `—`,
    `Sent with PrintExec · ${SITE_URL}`
  ].join("\n");
}

function buildCustomerInvoiceHtml(data: CustomerInvoiceEmailData): string {
  const { company, customer, invoice } = data;
  const greetingName = customer.contactName || customer.displayName || "there";
  const money = (v: number) => formatMoney(v, invoice.currency) ?? String(v);

  const meta: string[] = [summaryRowHtml("Invoice", invoice.number)];
  const issued = formatDate(invoice.issueDate);
  if (issued) meta.push(summaryRowHtml("Issued", issued));
  const due = formatDate(invoice.dueDate);
  if (due) meta.push(summaryRowHtml("Due", due));
  if (invoice.orderNumber) meta.push(summaryRowHtml("Order", invoice.orderNumber));
  if (invoice.orderTitle) meta.push(summaryRowHtml("Job", invoice.orderTitle));
  meta.push(summaryRowHtml("Billed to", customer.displayName));

  const totals: string[] = [invoiceTotalRowHtml(SUBTOTAL_LABEL, money(invoice.subtotal), false)];
  if (invoice.taxTotal > 0) totals.push(invoiceTotalRowHtml(taxTotalLabel(invoice.taxPct), money(invoice.taxTotal), false));
  totals.push(invoiceTotalRowHtml(TOTAL_LABEL, money(invoice.total), true));
  if (invoice.amountPaid > 0) {
    totals.push(invoiceTotalRowHtml("Paid", `- ${money(invoice.amountPaid)}`, false));
    totals.push(invoiceTotalRowHtml("Balance due", money(invoice.balanceDue), true));
  }

  const notes = [invoice.terms, invoice.memo].filter(
    (n): n is string => !!n && n.trim().length > 0
  );

  const contactBits: string[] = [];
  if (company.phone) contactBits.push(esc(company.phone));
  if (company.email) contactBits.push(esc(company.email));
  if (company.website) contactBits.push(esc(company.website));
  const contactLine = contactBits.join("&nbsp;&nbsp;·&nbsp;&nbsp;");

  // The headline figure: what they still owe if partly paid, else the total.
  const headline = invoice.amountPaid > 0 ? money(invoice.balanceDue) : money(invoice.total);
  const headlineLabel = invoice.amountPaid > 0 ? "Balance due" : "Amount due";

  return [
    `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;opacity:0;">` +
      `Invoice ${esc(invoice.number)} from ${esc(company.name)} — ${esc(headline)}</div>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f5;margin:0;padding:0;">`,
    `<tr><td align="center" style="padding:24px 12px;">`,
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:${PAPER};border:1px solid ${INK};">`,

    // ── Header: same fixed-height logo bar as the order emails ──
    `<tr><td style="background:${PAPER};border-bottom:2px solid ${INK};padding:18px 24px;" align="right">` +
      (company.logoUrl
        ? `<img src="${company.logoUrl}" alt="${esc(company.name)}" height="28" ` +
            `style="display:inline-block;height:28px;max-height:28px;width:auto;max-width:200px;border:0;outline:none;" />`
        : `<div style="height:28px;line-height:28px;">&nbsp;</div>`) +
      `</td></tr>`,

    // ── Headline: who it's from, and the one number that matters ──
    `<tr><td style="padding:30px 28px 6px;font-family:${SANS};color:${INK};">` +
      `<p style="margin:0 0 14px;font-size:15px;">Hi ${esc(greetingName)},</p>` +
      `<p style="margin:0 0 18px;font-size:20px;font-weight:700;line-height:1.3;">` +
        `Your invoice from ${esc(company.name)}.</p>` +
      `<div style="font-family:${MONO};font-size:11px;font-weight:700;letter-spacing:0.14em;` +
        `text-transform:uppercase;color:${SUBTLE};">${esc(headlineLabel)}</div>` +
      `<div style="font-family:${SANS};font-size:30px;font-weight:800;letter-spacing:-0.02em;color:${INK};` +
        `line-height:1.15;margin-top:4px;">${esc(headline)}</div>` +
      `</td></tr>`,

    // ── Invoice meta ──
    `<tr><td style="padding:22px 28px 4px;font-family:${SANS};">` +
      `<div style="font-family:${MONO};font-size:11px;font-weight:700;letter-spacing:0.16em;` +
        `text-transform:uppercase;color:${INK};border-bottom:1px solid ${INK};padding-bottom:8px;margin-bottom:6px;">Invoice</div>` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${meta.join("")}</table>` +
      `</td></tr>`,

    // ── Line items + totals ──
    `<tr><td style="padding:18px 28px 6px;font-family:${SANS};">` +
      `<div style="font-family:${MONO};font-size:11px;font-weight:700;letter-spacing:0.16em;` +
        `text-transform:uppercase;color:${INK};border-bottom:1px solid ${INK};padding-bottom:8px;margin-bottom:2px;">Items</div>` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">` +
        invoice.lines.map((l) => invoiceLineRowHtml(l, invoice.currency)).join("") +
      `</table>` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:6px;">` +
        totals.join("") +
      `</table>` +
      `</td></tr>`,

    // ── Notes ──
    notes.length > 0
      ? `<tr><td style="padding:14px 28px 0;font-family:${SANS};font-size:13px;color:${SUBTLE};line-height:1.6;">` +
          notes.map((n) => `<p style="margin:0 0 8px;">${esc(n)}</p>`).join("") +
          `</td></tr>`
      : ``,

    // ── Attachment note + company contact / no-reply ──
    `<tr><td style="padding:18px 28px 24px;font-family:${SANS};font-size:13px;color:${SUBTLE};line-height:1.6;">` +
      `<p style="margin:0 0 10px;color:${INK};">A PDF copy of this invoice is attached to this email.</p>` +
      `<p style="margin:0 0 10px;">This invoice was sent from an unmonitored address — please don't reply.</p>` +
      `<p style="margin:0 0 4px;color:${INK};font-weight:700;">${esc(company.name)}</p>` +
      (contactLine ? `<p style="margin:0;">${contactLine}</p>` : ``) +
      `<p style="margin:14px 0 0;color:${INK};">Thank you for your business.</p>` +
      `</td></tr>`,

    // ── Footer: the shared hosted PNG strip (see composeOrderCompletionEmail) ──
    `<tr><td bgcolor="${INK}" style="background:${INK};font-size:0;line-height:0;padding:0;">` +
      `<a href="${SITE_URL}" target="_blank" rel="noopener" style="display:block;text-decoration:none;">` +
        `<img src="${FOOTER_IMG_URL}" alt="PrintExec — printexec.xyz" width="600" height="77" ` +
          `style="display:block;width:100%;max-width:600px;height:auto;border:0;outline:none;" />` +
      `</a>` +
      `</td></tr>`,

    `</table>`,
    `</td></tr>`,
    `</table>`
  ].join("");
}

export function composeCustomerInvoiceEmail(data: CustomerInvoiceEmailData): ComposedEmail {
  const subject = `Invoice ${data.invoice.number} from ${data.company.name}`;
  return {
    subject,
    text: buildCustomerInvoiceText(data),
    html: buildCustomerInvoiceHtml(data)
  };
}
