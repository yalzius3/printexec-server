import { z } from "zod";

// Which serial is being changed. Only the two customer-facing numbers are
// exposed — the internal finance serials (bills, payments, expenses, journal
// entries) are never shown to a customer, so there is nothing to reset.
export const numberingKindParamSchema = z.object({
  kind: z.enum(["order", "invoice"])
});

// The serial the NEXT document should receive. "Reset" is simply 1 — the two
// operations the owner sees are one write, which is why there is no separate
// reset endpoint to keep consistent with this one.
export const setNextNumberSchema = z.object({
  next_value: z.coerce.number().int().min(1).max(99_999_999)
});
