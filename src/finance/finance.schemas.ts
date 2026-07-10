import { z } from "zod";

const uuidSchema = z.string().uuid();

// Money arrives as a JS number from the client; every arithmetic decision in
// the service happens in integer cents, so here we only guard shape/range.
const moneySchema = z.number().finite().nonnegative().max(999_999_999_999);
const positiveMoneySchema = moneySchema.refine((v) => v > 0, {
  message: "Amount must be greater than zero."
});
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD.");

export const accountTypeSchema = z.enum([
  "asset",
  "liability",
  "equity",
  "revenue",
  "expense"
]);

// ── Chart of accounts ────────────────────────────────────────────────────────

export const listAccountsQuerySchema = z.object({
  include_balances: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .optional(),
  is_active: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .optional()
});

export const createAccountSchema = z.object({
  code: z.string().trim().min(1).max(12),
  name: z.string().trim().min(1),
  account_type: accountTypeSchema,
  description: z.string().trim().min(1).optional(),
  parent_account_id: uuidSchema.optional()
});

export const updateAccountSchema = z
  .object({
    code: z.string().trim().min(1).max(12).optional(),
    name: z.string().trim().min(1).optional(),
    description: z.string().trim().nullable().optional(),
    parent_account_id: uuidSchema.nullable().optional(),
    is_active: z.boolean().optional()
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field is required."
  });

export const accountIdParamSchema = z.object({ accountId: uuidSchema });

// ── Vendors ──────────────────────────────────────────────────────────────────

export const listVendorsQuerySchema = z.object({
  is_active: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .optional(),
  search: z.string().trim().min(1).optional()
});

export const createVendorSchema = z.object({
  name: z.string().trim().min(1),
  email: z.string().trim().email().optional(),
  phone: z.string().trim().min(1).optional(),
  tax_id: z.string().trim().min(1).optional(),
  address_line1: z.string().trim().min(1).optional(),
  address_line2: z.string().trim().min(1).optional(),
  city: z.string().trim().min(1).optional(),
  country_code: z
    .string()
    .trim()
    .length(2)
    .transform((v) => v.toUpperCase())
    .optional(),
  notes: z.string().optional()
});

export const updateVendorSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    email: z.string().trim().email().nullable().optional(),
    phone: z.string().trim().min(1).nullable().optional(),
    tax_id: z.string().trim().min(1).nullable().optional(),
    address_line1: z.string().trim().min(1).nullable().optional(),
    address_line2: z.string().trim().min(1).nullable().optional(),
    city: z.string().trim().min(1).nullable().optional(),
    country_code: z
      .string()
      .trim()
      .length(2)
      .transform((v) => v.toUpperCase())
      .nullable()
      .optional(),
    notes: z.string().nullable().optional(),
    is_active: z.boolean().optional()
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field is required."
  });

export const vendorIdParamSchema = z.object({ vendorId: uuidSchema });

// ── Tax rates ────────────────────────────────────────────────────────────────

export const createTaxRateSchema = z.object({
  name: z.string().trim().min(1),
  rate_pct: z.number().finite().min(0).max(100)
});

export const updateTaxRateSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    rate_pct: z.number().finite().min(0).max(100).optional(),
    is_active: z.boolean().optional()
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field is required."
  });

export const taxRateIdParamSchema = z.object({ taxRateId: uuidSchema });

// ── Settings ─────────────────────────────────────────────────────────────────

export const updateFinanceSettingsSchema = z
  .object({
    currency_code: z.string().trim().min(1).max(8).optional(),
    lock_date: dateSchema.nullable().optional(),
    default_terms: z.string().trim().nullable().optional(),
    default_tax_rate_id: uuidSchema.nullable().optional()
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field is required."
  });

// ── Document lines (shared by invoices and bills) ───────────────────────────

const documentLineSchema = z.object({
  description: z.string().trim().min(1),
  quantity: z.number().finite().positive().default(1),
  unit_price: moneySchema,
  account_id: uuidSchema.optional(),
  tax_rate_id: uuidSchema.optional()
});

export type DocumentLineInput = z.infer<typeof documentLineSchema>;

// ── Invoices ─────────────────────────────────────────────────────────────────

export const listInvoicesQuerySchema = z.object({
  status: z.enum(["draft", "open", "partial", "paid", "void"]).optional(),
  customer_id: uuidSchema.optional(),
  order_id: uuidSchema.optional(),
  search: z.string().trim().min(1).optional()
});

export const createInvoiceSchema = z
  .object({
    customer_id: uuidSchema.optional(),
    counterparty_name: z.string().trim().min(1).optional(),
    order_id: uuidSchema.optional(),
    issue_date: dateSchema.optional(),
    due_date: dateSchema.optional(),
    memo: z.string().trim().optional(),
    terms: z.string().trim().optional(),
    lines: z.array(documentLineSchema).min(1)
  })
  .refine((v) => v.customer_id || v.counterparty_name, {
    message: "Provide a customer or a counterparty name."
  });

export const updateInvoiceSchema = z
  .object({
    customer_id: uuidSchema.nullable().optional(),
    counterparty_name: z.string().trim().min(1).nullable().optional(),
    issue_date: dateSchema.optional(),
    due_date: dateSchema.nullable().optional(),
    memo: z.string().trim().nullable().optional(),
    terms: z.string().trim().nullable().optional(),
    lines: z.array(documentLineSchema).min(1).optional()
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field is required."
  });

export const invoiceIdParamSchema = z.object({ invoiceId: uuidSchema });
export const orderIdParamSchema = z.object({ orderId: uuidSchema });

// ── Bills ────────────────────────────────────────────────────────────────────

export const listBillsQuerySchema = z.object({
  status: z.enum(["draft", "open", "partial", "paid", "void"]).optional(),
  vendor_id: uuidSchema.optional(),
  search: z.string().trim().min(1).optional()
});

export const createBillSchema = z
  .object({
    vendor_id: uuidSchema.optional(),
    vendor_name: z.string().trim().min(1).optional(),
    vendor_reference: z.string().trim().min(1).optional(),
    issue_date: dateSchema.optional(),
    due_date: dateSchema.optional(),
    memo: z.string().trim().optional(),
    lines: z.array(documentLineSchema).min(1)
  })
  .refine((v) => v.vendor_id || v.vendor_name, {
    message: "Provide a vendor or a vendor name."
  });

export const updateBillSchema = z
  .object({
    vendor_id: uuidSchema.nullable().optional(),
    vendor_name: z.string().trim().min(1).nullable().optional(),
    vendor_reference: z.string().trim().min(1).nullable().optional(),
    issue_date: dateSchema.optional(),
    due_date: dateSchema.nullable().optional(),
    memo: z.string().trim().nullable().optional(),
    lines: z.array(documentLineSchema).min(1).optional()
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field is required."
  });

export const billIdParamSchema = z.object({ billId: uuidSchema });

// ── Payments ─────────────────────────────────────────────────────────────────

const paymentApplicationSchema = z
  .object({
    invoice_id: uuidSchema.optional(),
    bill_id: uuidSchema.optional(),
    amount: positiveMoneySchema
  })
  .refine((v) => (v.invoice_id ? !v.bill_id : Boolean(v.bill_id)), {
    message: "Each application targets exactly one invoice or bill."
  });

export const listPaymentsQuerySchema = z.object({
  direction: z.enum(["in", "out"]).optional(),
  status: z.enum(["recorded", "void"]).optional(),
  search: z.string().trim().min(1).optional()
});

export const createPaymentSchema = z.object({
  direction: z.enum(["in", "out"]),
  method: z
    .enum(["cash", "bank_transfer", "card", "cheque", "other"])
    .default("cash"),
  payment_date: dateSchema.optional(),
  amount: positiveMoneySchema,
  deposit_account_id: uuidSchema,
  customer_id: uuidSchema.optional(),
  vendor_id: uuidSchema.optional(),
  counterparty_name: z.string().trim().min(1).optional(),
  reference: z.string().trim().min(1).optional(),
  memo: z.string().trim().optional(),
  applications: z.array(paymentApplicationSchema).default([])
});

export const paymentIdParamSchema = z.object({ paymentId: uuidSchema });

// ── Expenses ─────────────────────────────────────────────────────────────────

export const listExpensesQuerySchema = z.object({
  status: z.enum(["recorded", "void"]).optional(),
  search: z.string().trim().min(1).optional()
});

export const createExpenseSchema = z.object({
  vendor_id: uuidSchema.optional(),
  vendor_name: z.string().trim().min(1).optional(),
  expense_date: dateSchema.optional(),
  amount: positiveMoneySchema,
  category_account_id: uuidSchema,
  paid_from_account_id: uuidSchema,
  description: z.string().trim().min(1).optional(),
  reference: z.string().trim().min(1).optional()
});

export const expenseIdParamSchema = z.object({ expenseId: uuidSchema });

// ── Journal ──────────────────────────────────────────────────────────────────

export const listJournalQuerySchema = z.object({
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  source_type: z
    .enum(["manual", "invoice", "bill", "payment", "expense", "reversal"])
    .optional(),
  account_id: uuidSchema.optional(),
  limit: z
    .union([z.string(), z.number()])
    .transform((v) => Number(v))
    .pipe(z.number().int().min(1).max(200))
    .optional(),
  offset: z
    .union([z.string(), z.number()])
    .transform((v) => Number(v))
    .pipe(z.number().int().min(0))
    .optional()
});

const journalLineInputSchema = z
  .object({
    account_id: uuidSchema,
    debit: moneySchema.default(0),
    credit: moneySchema.default(0),
    description: z.string().trim().min(1).optional()
  })
  .refine((v) => (v.debit > 0) !== (v.credit > 0), {
    message: "Each line must have exactly one of debit or credit."
  });

export const createJournalEntrySchema = z.object({
  entry_date: dateSchema.optional(),
  memo: z.string().trim().min(1).optional(),
  lines: z.array(journalLineInputSchema).min(2)
});

export const entryIdParamSchema = z.object({ entryId: uuidSchema });

// ── Reports ──────────────────────────────────────────────────────────────────

export const periodQuerySchema = z.object({
  from: dateSchema.optional(),
  to: dateSchema.optional()
});

export const asOfQuerySchema = z.object({
  as_of: dateSchema.optional()
});

// ── Costing variables (capital-recovery / margin calculators) ───────────────

export const createCostingSchema = z
  .object({
    name: z.string().trim().min(1),
    kind: z.enum(["asset_recovery", "manual"]).default("asset_recovery"),
    asset_id: uuidSchema.optional(),
    asset_kind: z.enum(["printer", "spool", "other"]).optional(),
    asset_label: z.string().trim().min(1).optional(),
    asset_cost: z.number().finite().nonnegative().optional(),
    payback_months: z.number().int().positive().optional(),
    expected_volume_per_month: z.number().finite().positive().optional(),
    // For kind = 'manual': the per-order margin entered directly.
    manual_value: z.number().finite().nonnegative().optional(),
    notes: z.string().trim().optional()
  })
  .superRefine((v, ctx) => {
    if (v.kind === "asset_recovery") {
      if (v.asset_cost == null || v.payback_months == null || v.expected_volume_per_month == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["asset_cost"],
          message: "Asset cost, payback months, and monthly volume are all required."
        });
      }
    } else if (v.manual_value == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["manual_value"],
        message: "A per-order margin amount is required."
      });
    }
  });

export const updateCostingSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    kind: z.enum(["asset_recovery", "manual"]).optional(),
    asset_id: uuidSchema.nullable().optional(),
    asset_kind: z.enum(["printer", "spool", "other"]).nullable().optional(),
    asset_label: z.string().trim().min(1).nullable().optional(),
    asset_cost: z.number().finite().nonnegative().nullable().optional(),
    payback_months: z.number().int().positive().nullable().optional(),
    expected_volume_per_month: z.number().finite().positive().nullable().optional(),
    manual_value: z.number().finite().nonnegative().optional(),
    is_active: z.boolean().optional(),
    notes: z.string().trim().nullable().optional()
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field is required."
  });

export const costingIdParamSchema = z.object({ costingId: uuidSchema });

export const ledgerQuerySchema = z.object({
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  limit: z
    .union([z.string(), z.number()])
    .transform((v) => Number(v))
    .pipe(z.number().int().min(1).max(500))
    .optional()
});
