import PDFDocument from "pdfkit";
import type { SubscriptionInvoiceEmailData } from "./email-templates";

// ════════════════════════════════════════════════════════════════
// INVOICE PDF
//
// Renders the same invoice the email shows as an attachable PDF, so the owner
// keeps a real document for their records (and their accountant) rather than
// just an HTML mail.
//
// Built with pdfkit's built-in Helvetica family — no font files to ship and no
// network fetch at render time. The layout mirrors the email: PRINTEXEC
// wordmark bar, invoice number + issue date, issued-by / billed-to columns, a
// ruled line-item table, the total, and the subscription details block.
//
// Pure and side-effect free: data in → Buffer out. Never throws for missing
// optional fields (they're simply omitted), so a PDF failure can't be caused
// by sparse company data.
// ════════════════════════════════════════════════════════════════

const INK = "#000000";
const SUBTLE = "#57534e";
const PAGE_MARGIN = 50;

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

function fmtDate(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

function fmtMoney(amount: number, currency: string): string {
  const fixed = (Math.round(amount * 100) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  return `${currency} ${fixed}`;
}

function billingPeriod(start: string | Date | null, end: string | Date | null): string {
  const s = fmtDate(start);
  const e = fmtDate(end);
  if (s && e) return `${s} - ${e}`;
  if (e) return `Through ${e}`;
  if (s) return `From ${s}`;
  return "Ongoing";
}

const SOURCE_LABELS: Record<string, string> = {
  grant_code: "Grant code",
  manual: "Assigned by PrintExec",
  stripe: "Card payment",
  payoneer: "Payoneer",
  trial: "Trial"
};

/**
 * Render the invoice as a PDF. Resolves with the complete file buffer once
 * pdfkit has flushed the document.
 */
export function renderInvoicePdf(data: SubscriptionInvoiceEmailData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN, info: {
        Title: `PrintExec invoice ${data.invoiceNumber}`,
        Author: "PrintExec"
      } });

      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const left = PAGE_MARGIN;
      const right = doc.page.width - PAGE_MARGIN;
      const width = right - left;

      // ── Header bar: PRINTEXEC wordmark, knocked out of solid ink ──
      doc.rect(0, 0, doc.page.width, 64).fill(INK);
      doc
        .fillColor("#ffffff")
        .font("Courier-Bold")
        .fontSize(15)
        .text("PRINTEXEC", left, 26, { characterSpacing: 3 });

      // ── Invoice title + number / issue date ──
      let y = 96;
      doc
        .fillColor(INK)
        .font("Courier-Bold")
        .fontSize(11)
        .text("INVOICE", left, y, { characterSpacing: 2 });
      doc.font("Courier-Bold").fontSize(15).text(data.invoiceNumber, left, y + 16);

      const issued = fmtDate(data.issuedAt) ?? "";
      doc
        .font("Helvetica")
        .fontSize(9)
        .fillColor(SUBTLE)
        .text("Issued", left, y, { width, align: "right" });
      doc
        .font("Helvetica-Bold")
        .fontSize(11)
        .fillColor(INK)
        .text(issued, left, y + 13, { width, align: "right" });

      // ── Issued by / Billed to ──
      y += 54;
      const colWidth = (width - 20) / 2;
      const label = (text: string, x: number, yy: number) =>
        doc.font("Courier-Bold").fontSize(8).fillColor(SUBTLE).text(text.toUpperCase(), x, yy, { characterSpacing: 1.5 });

      label("Issued by", left, y);
      doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text("PrintExec", left, y + 13);
      doc
        .font("Helvetica")
        .fontSize(9)
        .fillColor(SUBTLE)
        .text("printexec.xyz\nsupport@printexec.xyz", left, y + 27, { width: colWidth });

      const rightCol = left + colWidth + 20;
      label("Billed to", rightCol, y);
      doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text(data.company.name, rightCol, y + 13, { width: colWidth });
      const billedLines = [
        data.company.ownerEmail ?? "",
        [data.company.city, data.company.countryCode].filter(Boolean).join(", ")
      ].filter((l) => l.length > 0);
      if (billedLines.length > 0) {
        doc.font("Helvetica").fontSize(9).fillColor(SUBTLE).text(billedLines.join("\n"), rightCol, y + 27, { width: colWidth });
      }

      // ── Line items ──
      y += 86;
      doc.moveTo(left, y).lineTo(right, y).lineWidth(1.5).strokeColor(INK).stroke();
      y += 10;
      doc.font("Courier-Bold").fontSize(8).fillColor(SUBTLE);
      doc.text("DESCRIPTION", left, y, { characterSpacing: 1 });
      doc.text("AMOUNT", left, y, { width, align: "right", characterSpacing: 1 });

      y += 18;
      const amount = fmtMoney(data.amountUsd, data.currency);
      doc.font("Helvetica").fontSize(11).fillColor(INK);
      doc.text(`PrintExec ${data.plan.name} plan`, left, y, { width: width - 120 });
      doc.text(amount, left, y, { width, align: "right" });
      doc
        .font("Helvetica")
        .fontSize(9)
        .fillColor(SUBTLE)
        .text(`Billing period: ${billingPeriod(data.periodStart, data.periodEnd)}`, left, y + 15, {
          width: width - 120
        });

      // ── Total ──
      y += 42;
      doc.moveTo(left, y).lineTo(right, y).lineWidth(0.75).strokeColor(INK).stroke();
      y += 12;
      doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text("TOTAL", left, y, { characterSpacing: 1 });
      doc.font("Helvetica-Bold").fontSize(14).text(amount, left, y - 3, { width, align: "right" });

      if (data.note) {
        y += 22;
        doc.font("Helvetica-Oblique").fontSize(9).fillColor(SUBTLE).text(data.note, left, y, { width });
        y += 12;
      }

      // ── Subscription details ──
      y += 34;
      doc.font("Courier-Bold").fontSize(9).fillColor(INK).text("SUBSCRIPTION", left, y, { characterSpacing: 1.5 });
      y += 14;
      doc.moveTo(left, y).lineTo(right, y).lineWidth(0.75).strokeColor(INK).stroke();
      y += 10;

      const cap = data.plan.maxPrinters === null ? "Unlimited printers" : `Up to ${data.plan.maxPrinters} printers`;
      const rows: [string, string][] = [
        ["Plan", `${data.plan.name} - ${cap}`],
        ["Status", data.status],
        ["Obtained", SOURCE_LABELS[data.source] ?? data.source],
        ["Renews", fmtDate(data.periodEnd) ?? "Ongoing (until changed)"]
      ];
      for (const [k, v] of rows) {
        doc.font("Courier").fontSize(8.5).fillColor(SUBTLE).text(k.toUpperCase(), left, y, { characterSpacing: 0.5 });
        doc.font("Helvetica").fontSize(10).fillColor(INK).text(v, left + 110, y - 1, { width: width - 110 });
        y += 17;
      }

      // ── Footer ──
      const footerY = doc.page.height - PAGE_MARGIN - 26;
      doc.moveTo(left, footerY - 12).lineTo(right, footerY - 12).lineWidth(0.5).strokeColor("#cccccc").stroke();
      doc
        .font("Helvetica")
        .fontSize(8.5)
        .fillColor(SUBTLE)
        .text(
          "This invoice was issued automatically by PrintExec. Questions about billing: support@printexec.xyz",
          left,
          footerY,
          { width, align: "center" }
        );

      doc.end();
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}
