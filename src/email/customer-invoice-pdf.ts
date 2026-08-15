import PDFDocument from "pdfkit";
import { SUBTOTAL_LABEL, TOTAL_LABEL, taxTotalLabel, type CustomerInvoiceEmailData } from "./email-templates";

// ════════════════════════════════════════════════════════════════
// CUSTOMER INVOICE PDF
//
// The tenant's OWN invoice, rendered as the attachable document their customer
// files, forwards to their accountant, and pays against. Sibling of
// invoice-pdf.ts (which renders PrintExec's subscription invoice to the tenant)
// — same construction, different issuer: here the shop is the issuer and
// PrintExec appears nowhere on the page. It is the customer's document.
//
// Built with pdfkit's built-in Helvetica/Courier families: no font files to
// ship, no network fetch at render time. The company is set as a TYPOGRAPHIC
// wordmark rather than its uploaded logo on purpose — the logo may be an SVG
// (which pdfkit cannot embed at all) and fetching it would put a network call,
// and a new failure mode, in the path of every invoice. The branded logo still
// rides in the email's HTML header, where it is just an <img>.
//
// Pure and side-effect free: data in → Buffer out. Missing optional fields are
// omitted rather than throwing, so sparse company/customer records still
// produce a valid document.
// ════════════════════════════════════════════════════════════════

const INK = "#000000";
const SUBTLE = "#57534e";
const HAIRLINE = "#cccccc";
const PAGE_MARGIN = 50;
const HEADER_BAR_HEIGHT = 64;

// Line-item table geometry. Description takes the slack; the numeric columns are
// fixed so figures stay aligned down the page and across page breaks.
//
// Five numeric columns, not three: a line shows its NET amount, the TAX on it,
// and the two added — the three figures Egypt's ETA schema keeps per line
// (netTotal / taxableItem.Amount / total). Each column foots to its own row in
// the totals block.
//
// Widths are measured, not guessed. pdfkit WRAPS text that exceeds the width it
// is given, and the row height here is computed from the description alone — so
// an overflowing numeric cell wraps onto the row rule below it rather than
// visibly overflowing. Each column therefore holds its widest realistic string
// at the font it is drawn in (Helvetica 10 / Courier-Bold 8 headers):
//   QTY    "1234.567"            41.7pt  (quantity is NUMERIC(12,3))
//   TAX    "14%  999,999.99"     75.6pt  (mixed-rate rows print the rate inline)
//   TOTAL  "EGP 999,999.99"      ~74pt   (the totals block adds the currency)
// That leaves ~129pt for the description, which wraps — the row-height code
// already measures it, so wrapping costs only vertical space.
const COL_QTY = 44;
const COL_UNIT = 58;
const COL_NET = 58;
const COL_TAX = 78;
const COL_AMOUNT = 78;
const COL_GAP = 10;

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

function fmtMoney(amount: number, currency: string | null): string {
  const fixed = (Math.round(amount * 100) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  return currency ? `${currency} ${fixed}` : fixed;
}

/** Rates read as written ("14%", "12.5%") — never money-formatted "14.00%". */
function fmtPct(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** Quantities are NUMERIC(12,3): show decimals only when they carry meaning. */
function fmtQuantity(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
}

/**
 * Render the customer's invoice as a PDF. Resolves with the complete file
 * buffer once pdfkit has flushed the document.
 */
export function renderCustomerInvoicePdf(data: CustomerInvoiceEmailData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        margin: PAGE_MARGIN,
        // Required for the footer pass: bufferedPageRange/switchToPage can only
        // revisit pages that are still buffered. doc.end() flushes them.
        bufferPages: true,
        info: {
          Title: `Invoice ${data.invoice.number}`,
          Author: data.company.name
        }
      });

      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const left = PAGE_MARGIN;
      const right = doc.page.width - PAGE_MARGIN;
      const width = right - left;
      const currency = data.invoice.currency;
      // Null when the lines carry different rates — then each row prints its own.
      const uniformPct = data.invoice.taxPct;

      // Column x-positions, right-aligned numerics anchored off the page edge.
      const xAmount = right - COL_AMOUNT;
      const xTax = xAmount - COL_GAP - COL_TAX;
      const xNet = xTax - COL_GAP - COL_NET;
      const xUnit = xNet - COL_GAP - COL_UNIT;
      const xQty = xUnit - COL_GAP - COL_QTY;
      const descWidth = xQty - COL_GAP - left;

      const microLabel = (text: string, x: number, y: number, w?: number) =>
        doc
          .font("Courier-Bold")
          .fontSize(8)
          .fillColor(SUBTLE)
          .text(text.toUpperCase(), x, y, { characterSpacing: 1.5, ...(w ? { width: w } : {}) });

      // ── Header bar: the SHOP's wordmark, knocked out of solid ink ──
      const drawHeaderBar = () => {
        doc.rect(0, 0, doc.page.width, HEADER_BAR_HEIGHT).fill(INK);
        doc
          .fillColor("#ffffff")
          .font("Courier-Bold")
          .fontSize(14)
          .text(data.company.name.toUpperCase(), left, 26, {
            characterSpacing: 2,
            width: width - 150,
            lineBreak: false,
            ellipsis: true
          });
        if (data.company.slogan) {
          doc
            .font("Helvetica")
            .fontSize(8)
            .fillColor("#d6d3d1")
            .text(data.company.slogan, left, 26, { width, align: "right", lineBreak: false, ellipsis: true });
        }
      };
      drawHeaderBar();

      // ── Invoice title + number / issue + due dates ──
      let y = 96;
      doc.fillColor(INK).font("Courier-Bold").fontSize(11).text("INVOICE", left, y, { characterSpacing: 2 });
      doc.font("Courier-Bold").fontSize(16).fillColor(INK).text(data.invoice.number, left, y + 16);

      const issued = fmtDate(data.invoice.issueDate);
      const due = fmtDate(data.invoice.dueDate);
      doc.font("Helvetica").fontSize(9).fillColor(SUBTLE).text("Issued", left, y, { width, align: "right" });
      doc
        .font("Helvetica-Bold")
        .fontSize(11)
        .fillColor(INK)
        .text(issued ?? "—", left, y + 13, { width, align: "right" });
      if (due) {
        doc.font("Helvetica").fontSize(9).fillColor(SUBTLE).text("Due", left, y + 30, { width, align: "right" });
        doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text(due, left, y + 43, { width, align: "right" });
      }

      // ── From / Bill to ──
      y += due ? 74 : 54;
      const colWidth = (width - 20) / 2;
      const rightCol = left + colWidth + 20;

      microLabel("From", left, y);
      doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text(data.company.name, left, y + 13, { width: colWidth });
      const fromLines = [
        [data.company.city, data.company.countryCode].filter(Boolean).join(", "),
        data.company.phone ?? "",
        data.company.website ?? ""
      ].filter((l) => l.length > 0);
      if (fromLines.length > 0) {
        doc.font("Helvetica").fontSize(9).fillColor(SUBTLE).text(fromLines.join("\n"), left, y + 27, { width: colWidth });
      }

      microLabel("Bill to", rightCol, y);
      doc
        .font("Helvetica-Bold")
        .fontSize(11)
        .fillColor(INK)
        .text(data.customer.displayName, rightCol, y + 13, { width: colWidth });
      const billedLines = [
        data.customer.contactName && data.customer.contactName !== data.customer.displayName
          ? `Attn: ${data.customer.contactName}`
          : "",
        data.customer.email ?? "",
        data.customer.phone ?? ""
      ].filter((l) => l.length > 0);
      if (billedLines.length > 0) {
        doc.font("Helvetica").fontSize(9).fillColor(SUBTLE).text(billedLines.join("\n"), rightCol, y + 27, { width: colWidth });
      }

      // Reference line — ties the bill back to the job the customer knows.
      y += 84;
      if (data.invoice.orderNumber || data.invoice.orderTitle) {
        const ref = [data.invoice.orderNumber, data.invoice.orderTitle].filter(Boolean).join(" · ");
        microLabel("Reference", left, y);
        doc.font("Helvetica").fontSize(10).fillColor(INK).text(ref, left + 78, y - 1, { width: width - 78 });
        y += 22;
      }

      // ── Line items ──
      // A long invoice must break cleanly, so the table header is a function and
      // every row checks the remaining space before it draws.
      const drawTableHead = () => {
        doc.moveTo(left, y).lineTo(right, y).lineWidth(1.5).strokeColor(INK).stroke();
        y += 10;
        doc.font("Courier-Bold").fontSize(8).fillColor(SUBTLE);
        doc.text("DESCRIPTION", left, y, { characterSpacing: 1, width: descWidth });
        doc.text("QTY", xQty, y, { characterSpacing: 1, width: COL_QTY, align: "right" });
        doc.text("UNIT", xUnit, y, { characterSpacing: 1, width: COL_UNIT, align: "right" });
        doc.text("NET", xNet, y, { characterSpacing: 1, width: COL_NET, align: "right" });
        // Header carries the rate when the whole invoice shares one, so the
        // cells below can be pure money.
        doc.text(uniformPct == null ? "TAX" : `TAX ${fmtPct(uniformPct)}%`, xTax, y, { characterSpacing: 1, width: COL_TAX, align: "right" });
        doc.text("TOTAL", xAmount, y, { characterSpacing: 1, width: COL_AMOUNT, align: "right" });
        y += 16;
        doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).strokeColor(HAIRLINE).stroke();
        y += 8;
      };

      // Keep the totals block whole: never break between the last row and it.
      const bottomLimit = doc.page.height - PAGE_MARGIN - 40;
      const ensureSpace = (needed: number) => {
        if (y + needed <= bottomLimit) return;
        doc.addPage();
        drawHeaderBar();
        y = HEADER_BAR_HEIGHT + 32;
        drawTableHead();
      };

      drawTableHead();

      for (const line of data.invoice.lines) {
        const descHeight = doc.font("Helvetica").fontSize(10).heightOfString(line.description, { width: descWidth });
        const rowHeight = Math.max(descHeight, 12) + 10;
        ensureSpace(rowHeight);

        doc.font("Helvetica").fontSize(10).fillColor(INK).text(line.description, left, y, { width: descWidth });
        doc.font("Helvetica").fontSize(10).fillColor(SUBTLE).text(fmtQuantity(line.quantity), xQty, y, { width: COL_QTY, align: "right" });
        doc.text(fmtMoney(line.unitPrice, null), xUnit, y, { width: COL_UNIT, align: "right" });
        doc.text(fmtMoney(line.amount, null), xNet, y, { width: COL_NET, align: "right" });
        // Mixed-rate invoices print the rate per row; a uniform one said it once
        // in the header. An untaxed line gets an en dash, not a blank.
        doc.text(
          line.taxAmount > 0
            ? (uniformPct == null ? `${fmtPct(line.taxPct)}%  ${fmtMoney(line.taxAmount, null)}` : fmtMoney(line.taxAmount, null))
            : "–",
          xTax, y, { width: COL_TAX, align: "right" }
        );
        // The tax-inclusive line total is what the customer reconciles against
        // their payment, so it is the one figure in the row set in ink.
        doc.font("Helvetica-Bold").fillColor(INK).text(fmtMoney(line.amount + line.taxAmount, null), xAmount, y, { width: COL_AMOUNT, align: "right" });

        y += rowHeight;
        doc.moveTo(left, y - 5).lineTo(right, y - 5).lineWidth(0.5).strokeColor(HAIRLINE).stroke();
      }

      // ── Totals ──
      const totals: [string, string, boolean][] = [
        [SUBTOTAL_LABEL, fmtMoney(data.invoice.subtotal, currency), false],
        ...(data.invoice.taxTotal > 0
          ? ([[taxTotalLabel(data.invoice.taxPct), fmtMoney(data.invoice.taxTotal, currency), false]] as [string, string, boolean][])
          : []),
        [TOTAL_LABEL, fmtMoney(data.invoice.total, currency), true],
        ...(data.invoice.amountPaid > 0
          ? ([
              ["Paid", `- ${fmtMoney(data.invoice.amountPaid, currency)}`, false],
              ["Balance due", fmtMoney(data.invoice.balanceDue, currency), true]
            ] as [string, string, boolean][])
          : [])
      ];

      ensureSpace(totals.length * 20 + 24);
      y += 10;
      const totalsLabelX = xUnit - 60;
      for (const [label, value, strong] of totals) {
        if (strong) {
          doc.moveTo(totalsLabelX, y - 4).lineTo(right, y - 4).lineWidth(0.75).strokeColor(INK).stroke();
          y += 4;
        }
        doc
          .font(strong ? "Helvetica-Bold" : "Helvetica")
          .fontSize(strong ? 11 : 10)
          .fillColor(strong ? INK : SUBTLE)
          .text(label, totalsLabelX, y, { width: xAmount - totalsLabelX - COL_GAP, align: "right" });
        doc
          .font(strong ? "Helvetica-Bold" : "Helvetica")
          .fontSize(strong ? 12 : 10)
          .fillColor(INK)
          .text(value, xAmount, y - (strong ? 1 : 0), { width: COL_AMOUNT, align: "right" });
        y += strong ? 22 : 18;
      }

      // ── Memo / payment terms ──
      const notes = [data.invoice.terms, data.invoice.memo].filter(
        (n): n is string => !!n && n.trim().length > 0
      );
      if (notes.length > 0) {
        ensureSpace(48);
        y += 12;
        microLabel("Notes", left, y);
        y += 14;
        doc.font("Helvetica").fontSize(9.5).fillColor(SUBTLE).text(notes.join("\n\n"), left, y, { width: width * 0.7 });
        y = doc.y;
      }

      // ── Footer: the shop's own contact details, on every page ──
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        const footerY = doc.page.height - PAGE_MARGIN - 24;
        doc.moveTo(left, footerY - 12).lineTo(right, footerY - 12).lineWidth(0.5).strokeColor(HAIRLINE).stroke();
        const contact = [data.company.phone, data.company.email, data.company.website]
          .filter((v): v is string => !!v && v.length > 0)
          .join("   ·   ");
        doc
          .font("Helvetica")
          .fontSize(8.5)
          .fillColor(SUBTLE)
          .text(contact || data.company.name, left, footerY, { width, align: "center", lineBreak: false });
      }

      doc.end();
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}
