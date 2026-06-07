import { z } from "zod";

const uuidSchema = z.string().uuid();

export const customerTypeSchema = z.enum(["b2b", "b2c"]);

const customerBaseSchema = z
  .object({
    customer_type: customerTypeSchema,
    first_name: z.string().trim().min(1).optional(),
    last_name: z.string().trim().min(1).optional(),
    business_name: z.string().trim().min(1).optional(),
    tax_id: z.string().trim().min(1).optional(),
    email: z.string().trim().email(),
    phone: z.string().trim().min(1).optional(),
    secondary_phone: z.string().trim().min(1).optional(),
    address_line1: z.string().trim().min(1).optional(),
    address_line2: z.string().trim().min(1).optional(),
    city: z.string().trim().min(1).optional(),
    country_code: z
      .string()
      .trim()
      .length(2)
      .transform((value) => value.toUpperCase())
      .optional(),
    is_active: z.boolean().optional(),
    notes: z.string().optional()
  })
  .superRefine((value, ctx) => {
    if (value.customer_type === "b2b" && !value.business_name) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["business_name"],
        message: "business_name is required for b2b customers."
      });
    }

    if (value.customer_type === "b2c" && !value.first_name) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["first_name"],
        message: "first_name is required for b2c customers."
      });
    }
  });

export const listCustomersQuerySchema = z.object({
  customer_type: customerTypeSchema.optional(),
  is_active: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((value) =>
      typeof value === "boolean" ? value : value === "true"
    )
    .optional(),
  search: z.string().trim().min(1).optional()
});

export const createCustomerSchema = customerBaseSchema;

export const updateCustomerSchema = z
  .object({
    customer_type: customerTypeSchema.optional(),
    first_name: z.string().trim().min(1).nullable().optional(),
    last_name: z.string().trim().min(1).nullable().optional(),
    business_name: z.string().trim().min(1).nullable().optional(),
    tax_id: z.string().trim().min(1).nullable().optional(),
    email: z.string().trim().email().optional(),
    phone: z.string().trim().min(1).nullable().optional(),
    secondary_phone: z.string().trim().min(1).nullable().optional(),
    address_line1: z.string().trim().min(1).nullable().optional(),
    address_line2: z.string().trim().min(1).nullable().optional(),
    city: z.string().trim().min(1).nullable().optional(),
    country_code: z
      .string()
      .trim()
      .length(2)
      .transform((value) => value.toUpperCase())
      .nullable()
      .optional(),
    is_active: z.boolean().optional(),
    notes: z.string().nullable().optional()
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required."
  });

export const customerIdParamSchema = z.object({
  customerId: uuidSchema
});

export const createInteractionSchema = z.object({
  interaction_type: z.string().trim().min(1),
  description: z.string().trim().min(1)
});

export const listInteractionsQuerySchema = z.object({
  days: z
    .union([z.string(), z.number()])
    .transform((v) => Number(v))
    .optional(),
  interaction_type: z.string().trim().min(1).optional()
});
