// ── Shared order → invoice / quotation line builder ──────────────────────────
// Mirrored VERBATIM in printexec-client/src/order-invoice-lines.ts and
// printexec-server/src/orders/order-invoice-lines.ts. Keep the two in lockstep:
// the Orders quotation preview, the printed quotation, and the generated invoice
// all itemise an order through THIS code, so the customer sees the same lines on
// the quote and the bill, and the invoice subtotal equals the quoted Total to
// the cent (the same reason costing-formula.ts / costing.ts are mirrored).
//
// Distribution rule — mirrors the pricing bar's Total:
//   · Everything is done in whole cents against round(total): the custom charges
//     are billed whole (each its own line, outside the profit multiplier) and the
//     remaining, margin-loaded cents are spread across the priced pieces in
//     proportion to each piece's base production cost, using largest-remainder
//     apportionment. Σ lines therefore equals round(total) EXACTLY — no drift
//     against the Total the operator saw.
//   · Identical (name, unit price) pieces collapse into one line with a qty.

export type InvoiceLinePiece = { name: string; baseTotal: number };
export type InvoiceCustomLine = { label: string; amount: number };
export type BuiltInvoiceLine = { description: string; quantity: number; unitPrice: number };

export function buildOrderInvoiceLines(args: {
  /** Priced pieces only, already in the SAME deterministic order on both sides
   *  (lower(piece_name), created_at) so apportionment lands identically. */
  pieces: InvoiceLinePiece[];
  /** Σ pieces' baseTotal — the aggregate the formula priced against. */
  base: number;
  /** The evaluated formula Total (sell price, custom charges included). */
  total: number;
  customLines: InvoiceCustomLine[];
}): BuiltInvoiceLine[] {
  const { pieces, base, total } = args;
  const customLines = (args.customLines ?? []).filter((c) => Number(c.amount) > 0);

  // Whole-cent arithmetic so the lines reconcile EXACTLY to the displayed Total.
  const totalCents = Math.round(total * 100);
  const customCents = customLines.reduce((s, c) => s + Math.round(Number(c.amount) * 100), 0);
  const pieceCents = totalCents - customCents; // margin-loaded part spread across pieces

  const lines: BuiltInvoiceLine[] = [];

  if (base > 0 && pieceCents > 0 && pieces.length > 0) {
    // Largest-remainder apportionment of `pieceCents` across the pieces, weighted
    // by each piece's base cost, so Σ piece cents === pieceCents exactly.
    const raw = pieces.map((p) => (p.baseTotal / base) * pieceCents);
    const cents = raw.map((x) => Math.floor(x));
    let leftover = pieceCents - cents.reduce((s, x) => s + x, 0);

    // Rank by fractional remainder (desc), ties by original index for a stable,
    // side-independent result.
    const ranked = raw
      .map((x, i) => ({ i, frac: x - Math.floor(x) }))
      .sort((a, b) => b.frac - a.frac || a.i - b.i);
    for (let k = 0; leftover > 0 && ranked.length > 0; k += 1, leftover -= 1) {
      cents[ranked[k % ranked.length]!.i]! += 1;
    }
    // Defensive: float underflow (leftover < 0) claws single cents back from the
    // smallest remainders that still have a cent to give.
    for (let k = ranked.length - 1; leftover < 0 && k >= 0; k -= 1) {
      const idx = ranked[k]!.i;
      if (cents[idx]! > 0) { cents[idx]! -= 1; leftover += 1; }
    }

    // Group identical (name, unit) pieces, preserving first-seen order.
    const groups = new Map<string, BuiltInvoiceLine>();
    for (let i = 0; i < pieces.length; i += 1) {
      const description = pieces[i]!.name.trim() || "Printed piece";
      const key = `${description}::${cents[i]}`;
      const existing = groups.get(key);
      if (existing) existing.quantity += 1;
      else groups.set(key, { description, quantity: 1, unitPrice: cents[i]! / 100 });
    }
    lines.push(...groups.values());
  }

  for (const c of customLines) {
    lines.push({ description: c.label.trim() || "Custom charge", quantity: 1, unitPrice: Math.round(Number(c.amount) * 100) / 100 });
  }

  return lines;
}
