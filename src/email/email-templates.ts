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
const RAIN_AXES = ["X", "Y", "Z"];

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

/**
 * Static, pre-rendered ("baked") version of the capabilities-doc rain strip,
 * using THAT document's exact buildRain algorithm — same PRNG, token formats,
 * counts, fonts, colors and bottom fade — emitted as a static <svg> string
 * because email clients don't run the doc's JS. Seeded by the order number.
 *
 * Note: inline SVG renders in Apple Mail but Gmail/Outlook strip it; the cell
 * sits on solid black so it degrades to a plain black band in those clients.
 */
function bottomRainSvg(seed: number, w: number, h: number): string {
  let s = (seed | 0) || 1;
  const rng = () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 4294967295;
  };
  const rc = () => ((rng() * 2000) - 1000).toFixed(2);
  const fmt = (ax: string, v: string): string => {
    const r = rng();
    return r < 0.4 ? `[${ax}: ${v}]` : r < 0.7 ? `${ax}&#8594;${v}` : `${ax} ${v}`;
  };

  const parts: string[] = [`<rect x="0" y="0" width="${w}" height="${h}" fill="#000"/>`];
  const count = Math.floor(w / 32) * 4;
  for (let i = 0; i < count; i += 1) {
    const ax = RAIN_AXES[Math.floor(rng() * 3)] as string;
    const v = rc();
    const x = rng() * (w - 90);
    const y = rng() * (h - 14) + 12;
    const fs = 7 + rng() * 5;
    const al = (0.65 + rng() * 0.35).toFixed(2);
    const cw = fs * 0.605;
    const grouped = rng() < 0.12;

    if (grouped) {
      RAIN_AXES.forEach((bax, bi) => {
        const lbl = fmt(bax, rc());
        const yy = (y + bi * fs * 1.3).toFixed(2);
        const ai = lbl.indexOf(bax);
        parts.push(
          `<text x="${x.toFixed(2)}" y="${yy}" font-family="'Roboto Mono',monospace" font-size="${fs.toFixed(1)}" fill="#aaa89a" opacity="${(Number(al) * 0.75).toFixed(2)}">${lbl}</text>`
        );
        if (ai >= 0) {
          parts.push(
            `<text x="${(x + ai * cw).toFixed(2)}" y="${yy}" font-family="'Roboto Mono',monospace" font-size="${fs.toFixed(1)}" fill="#fff" opacity="${al}">${bax}</text>`
          );
        }
      });
    } else {
      const lbl = fmt(ax, v);
      const ai = lbl.indexOf(ax);
      parts.push(
        `<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" font-family="'Roboto Mono',monospace" font-size="${fs.toFixed(1)}" fill="#999080" opacity="${al}">${lbl}</text>`
      );
      if (ai >= 0) {
        parts.push(
          `<text x="${(x + ai * cw).toFixed(2)}" y="${y.toFixed(2)}" font-family="'Roboto Mono',monospace" font-size="${fs.toFixed(1)}" fill="#fff" opacity="${al}">${ax}</text>`
        );
      }
    }
  }
  // Bottom fade (isBottom=true in the ref): solid at the top → transparent by 60%.
  const gid = `rain-${seed}`;
  parts.push(
    `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="#000" stop-opacity="1"/>` +
      `<stop offset="0.6" stop-color="#000" stop-opacity="0"/>` +
      `</linearGradient></defs>` +
      `<rect x="0" y="0" width="${w}" height="${h}" fill="url(#${gid})"/>`
  );

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" ` +
    `width="100%" height="${h}" style="display:block;">${parts.join("")}</svg>`
  );
}

/** Seed for the rain strip — sum of order-number char codes (stable per order). */
function seedFrom(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) n = (n + text.charCodeAt(i) * (i + 1)) | 0;
  return n;
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
    `Fulfilled by PrintExec`
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
  const isFulfilled = order.status === "fulfilled";

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

    // ── Header: blank bar (company logo goes top-right) + plain separator ──
    `<tr><td style="background:${PAPER};border-bottom:2px solid ${INK};padding:18px 24px;" align="right">` +
      `<div style="height:28px;line-height:28px;">&nbsp;</div>` +
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

    // ── Footer: PrintExec wordmark + "Fulfilled by PrintExec" ──
    `<tr><td style="background:${INK};padding:18px 24px 14px;">` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
      `<td style="font-family:${MONO};font-weight:700;font-size:16px;letter-spacing:0.08em;color:${PAPER};">PRINTEXEC</td>` +
      `<td align="right" style="font-family:${MONO};font-size:11px;letter-spacing:0.06em;color:#9a958a;">` +
        `${isFulfilled ? "✓ " : ""}Fulfilled by PrintExec</td>` +
      `</tr></table>` +
      `</td></tr>`,

    // ── Bottom rain strip: baked static render of the ref doc's rain SVG ──
    `<tr><td style="background:${INK};font-size:0;line-height:0;">` +
      `${bottomRainSvg(seedFrom(order.orderNumber), 600, 62)}</td></tr>`,

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
