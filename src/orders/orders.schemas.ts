import { z } from "zod";

const uuidSchema = z.string().uuid();
const earliestReasonableDate = "2000-01-01";
const latestReasonableDate = "2100-12-31";
const orderNumberPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{3,31}$/;
const dateSchema = z.iso
  .date()
  .refine(
    (value) => value >= earliestReasonableDate && value <= latestReasonableDate,
    `Date must be between ${earliestReasonableDate} and ${latestReasonableDate}.`
  );
const timestampSchema = z.iso.datetime({ offset: true });
const boundedInt = (min: number, max: number) =>
  z.coerce.number().int().min(min).max(max);
const boundedNumber = (min: number, max: number) =>
  z.coerce.number().min(min).max(max);
const nozzleMaterialSchema = z.enum([
  "brass",
  "stainless_steel",
  "hardened_steel",
  "tungsten_carbide",
  "ruby_tipped",
  "copper_alloy"
]);
const slicerAwareStatuses = new Set(["ready", "scheduled", "printing", "done", "failed"]);

// Per-color slot for a MULTICOLOR piece. Material is an abstract catalogue
// value (like required_filament_material); color is free text (like
// required_color). Sequence is the array index + 1.
const colorSlotSchema = z.object({
  slot_material: z.string().trim().min(1).max(120),
  slot_color: z.string().trim().min(1).max(80)
});

// Raw costing-row inputs, stored verbatim (as the operator typed them) so the
// bulk grid can reload them. Values are strings to round-trip exactly.
const costInputsSchema = z
  .object({
    grams: z.array(z.string().max(24)).max(16).optional(),
    time: z.string().max(24).optional(),
    failure: z.string().max(24).optional()
  })
  .strip();

// Per-color slicer demand entered at the slicer step, keyed by the slot's
// sequence_order so it can be matched back to a color slot.
const colorSlotGramsSchema = z.object({
  sequence_order: boundedInt(1, 64),
  grams: boundedNumber(0.01, 100000)
});

export const orderStatusSchema = z.enum([
  "draft",
  "confirmed",
  "in_progress",
  "completed",
  "cancelled"
]);

export const pieceStatusSchema = z.enum([
  "pending",
  "assigned",
  "ready",
  "scheduled",
  "printing",
  "done",
  "failed",
  "cancelled"
]);

export const listOrdersQuerySchema = z.object({
  customer_id: uuidSchema.optional(),
  status: orderStatusSchema.optional(),
  search: z.string().trim().min(1).optional()
});

export const createOrderSchema = z
  .object({
    // Optional: an order may be created with no customer attached and have one
    // assigned later (at confirmation).
    customer_id: uuidSchema.optional(),
    order_number: z
      .string()
      .trim()
      .regex(
        orderNumberPattern,
        "order_number must be 4-32 characters using letters, numbers, dots, underscores, slashes, or dashes."
      )
      .optional(),
    title: z.string().trim().min(1).max(200),
    description: z.string().optional(),
    priority: boundedInt(0, 100).default(0),
    deadline: dateSchema,
    established_at: dateSchema.optional(),
    status: orderStatusSchema.optional(),
    notes: z.string().optional()
  })
  .superRefine((value, ctx) => {
    if (value.established_at && value.established_at > value.deadline) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["established_at"],
        message: "established_at cannot be later than deadline."
      });
    }
  });

export const updateOrderSchema = z
  .object({
    // Assigning a customer to an order that was created without one (and, after
    // the first assignment, changing it). Optional so other PATCHes are unaffected.
    customer_id: uuidSchema.optional(),
    order_number: z
      .string()
      .trim()
      .regex(
        orderNumberPattern,
        "order_number must be 4-32 characters using letters, numbers, dots, underscores, slashes, or dashes."
      )
      .optional(),
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().nullable().optional(),
    priority: boundedInt(0, 100).optional(),
    deadline: dateSchema.optional(),
    established_at: dateSchema.optional(),
    status: orderStatusSchema.optional(),
    notes: z.string().nullable().optional(),
    // Operator-entered labour cost for the whole order (nullable to clear).
    labor_cost: boundedNumber(0, 100000000).nullable().optional()
  })
  .superRefine((value, ctx) => {
    if (value.established_at && value.deadline && value.established_at > value.deadline) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["established_at"],
        message: "established_at cannot be later than deadline."
      });
    }
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required."
  });

export const listOrderPiecesQuerySchema = z.object({
  order_id: uuidSchema.optional(),
  status: pieceStatusSchema.optional(),
  assigned_printer_id: uuidSchema.optional(),
  search: z.string().trim().min(1).optional()
});

export const pieceObjectSchema = z
  .object({
    piece_name: z.string().trim().min(1).max(200),
    description: z.string().optional(),
    required_filament_ref_id: uuidSchema.optional(),
    required_filament_material: z.string().trim().min(1).max(120).optional(),
    required_color: z.string().trim().min(1).max(80).optional(),
    requires_multicolor: z.boolean().optional(),
    color_slots: z.array(colorSlotSchema).max(16).optional(),
    color_slot_grams: z.array(colorSlotGramsSchema).max(16).optional(),
    required_nozzle_diameter_mm: boundedNumber(0.1, 2).optional(),
    required_nozzle_material: nozzleMaterialSchema.optional(),
    assigned_nozzle_asset_id: uuidSchema.optional(),
    required_print_technology: z.enum(["FDM", "MSLA", "SLA", "SLS"]).optional(),
    required_multicolor_capable: z.boolean().optional(),
    assigned_printer_id: uuidSchema.optional(),
    slicer_file_url: z.string().trim().min(1).max(2000).optional(),
    slicer_file_uploaded_at: timestampSchema.optional(),
    // Source 3D model — distinct from the slicer output. Nullable so the
    // orders UI can clear it.
    stl_file_url: z.string().trim().min(1).max(2000).optional(),
    slicer_profile: z.string().trim().min(1).max(120).optional(),
    slicer_print_time_minutes: boundedInt(1, 100000).optional(),
    slicer_filament_used_grams: boundedNumber(0.01, 100000).optional(),
    slicer_filament_used_mm: boundedNumber(0.01, 100000000).optional(),
    slicer_support_grams: boundedNumber(0, 100000).optional(),
    slicer_layer_height_mm: boundedNumber(0.01, 5).optional(),
    slicer_infill_percent: boundedInt(0, 100).optional(),
    slicer_wall_loops: boundedInt(0, 100).optional(),
    slicer_supports_enabled: z.boolean().optional(),
    slicer_support_type: z.string().trim().min(1).max(80).optional(),
    slicer_part_weight_grams: boundedNumber(0, 100000).optional(),
    actual_print_time_minutes: boundedInt(1, 100000).optional(),
    actual_filament_used_grams: boundedNumber(0.01, 100000).optional(),
    print_started_at: timestampSchema.optional(),
    print_completed_at: timestampSchema.optional(),
    status: pieceStatusSchema.optional(),
    notes: z.string().optional(),
    // Per-piece cost (money). Captured directly; nothing derives it server-side.
    cost: boundedNumber(0, 100000000).optional(),
    // Raw costing-row inputs, persisted verbatim so they reload in the grid.
    cost_inputs: costInputsSchema.nullable().optional()
  });

const pieceSuperRefine = (value: any, ctx: z.RefinementCtx) => {
    const hasSlicerCoreData =
      value.slicer_profile !== undefined ||
      value.slicer_print_time_minutes !== undefined ||
      value.slicer_filament_used_grams !== undefined ||
      value.slicer_filament_used_mm !== undefined ||
      value.slicer_support_grams !== undefined ||
      value.slicer_layer_height_mm !== undefined ||
      value.slicer_infill_percent !== undefined ||
      value.slicer_wall_loops !== undefined ||
      value.slicer_supports_enabled !== undefined ||
      value.slicer_support_type !== undefined ||
      value.slicer_part_weight_grams !== undefined;

    if (hasSlicerCoreData && !value.slicer_file_url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["slicer_file_url"],
        message: "slicer_file_url is required when slicer-derived fields are provided."
      });
    }

    if (value.slicer_file_uploaded_at && !value.slicer_file_url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["slicer_file_uploaded_at"],
        message: "slicer_file_uploaded_at requires slicer_file_url."
      });
    }

    if (value.slicer_support_type && value.slicer_supports_enabled === false) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["slicer_support_type"],
        message: "slicer_support_type cannot be set when slicer_supports_enabled is false."
      });
    }

    if (
      value.slicer_support_grams !== undefined &&
      value.slicer_support_grams > 0 &&
      value.slicer_supports_enabled === false
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["slicer_support_grams"],
        message: "slicer_support_grams cannot be greater than 0 when supports are disabled."
      });
    }

    if (value.requires_multicolor && value.required_print_technology && value.required_print_technology !== "FDM") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["required_print_technology"],
        message: "Multicolor requirements are only tracked for FDM pieces in phase 1."
      });
    }

    // Color slots are the per-color requirement for a multicolor piece. They
    // are only meaningful when requires_multicolor is true, and a multicolor
    // piece needs at least two of them. (null is "leave unchanged" on update.)
    if (value.color_slots !== undefined && value.color_slots !== null) {
      if (value.requires_multicolor === false && value.color_slots.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["color_slots"],
          message: "color_slots can only be set when requires_multicolor is true."
        });
      }
      if (value.requires_multicolor === true && value.color_slots.length < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["color_slots"],
          message: "A multicolor piece needs at least two color slots."
        });
      }
    }
    if (
      value.requires_multicolor === true &&
      (value.color_slots === undefined || value.color_slots === null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["color_slots"],
        message: "A multicolor piece must define its color slots."
      });
    }

    if (value.required_multicolor_capable && value.required_print_technology && value.required_print_technology !== "FDM") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["required_multicolor_capable"],
        message: "required_multicolor_capable only applies to FDM pieces in phase 1."
      });
    }

    const usesNozzleFields =
      value.required_nozzle_diameter_mm !== undefined ||
      value.required_nozzle_material !== undefined ||
      value.assigned_nozzle_asset_id !== undefined;

    if (
      usesNozzleFields &&
      value.required_print_technology &&
      value.required_print_technology !== "FDM"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["required_print_technology"],
        message: "Nozzle requirements and assignments only apply to FDM pieces."
      });
    }

    if (value.print_completed_at && !value.print_started_at) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["print_completed_at"],
        message: "print_completed_at requires print_started_at."
      });
    }

    if (
      value.print_started_at &&
      value.print_completed_at &&
      value.print_completed_at < value.print_started_at
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["print_completed_at"],
        message: "print_completed_at cannot be earlier than print_started_at."
      });
    }

    if (value.status && slicerAwareStatuses.has(value.status) && !value.slicer_file_url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "A slicer file is required before a piece can be ready, scheduled, printing, done, or failed."
      });
    }
};

export const pieceBaseSchema = pieceObjectSchema
  .superRefine(pieceSuperRefine);

export const createOrderPieceSchema = pieceBaseSchema;

export const updateOrderPieceSchema = pieceObjectSchema
  .partial()
  .extend({
    description: z.string().nullable().optional(),
    required_filament_ref_id: uuidSchema.nullable().optional(),
    required_filament_material: z.string().trim().min(1).max(120).nullable().optional(),
    required_color: z.string().trim().min(1).nullable().optional(),
    color_slots: z.array(colorSlotSchema).max(16).nullable().optional(),
    color_slot_grams: z.array(colorSlotGramsSchema).max(16).optional(),
    required_nozzle_diameter_mm: boundedNumber(0.1, 2).nullable().optional(),
    required_nozzle_material: nozzleMaterialSchema.nullable().optional(),
    assigned_nozzle_asset_id: uuidSchema.nullable().optional(),
    required_print_technology: z
      .enum(["FDM", "MSLA", "SLA", "SLS"])
      .nullable()
      .optional(),
    assigned_printer_id: uuidSchema.nullable().optional(),
    slicer_file_url: z.string().trim().min(1).nullable().optional(),
    slicer_file_uploaded_at: timestampSchema.nullable().optional(),
    stl_file_url: z.string().trim().min(1).nullable().optional(),
    stl_file_uploaded_at: timestampSchema.nullable().optional(),
    slicer_profile: z.string().trim().min(1).nullable().optional(),
    slicer_print_time_minutes: boundedInt(1, 100000).nullable().optional(),
    slicer_filament_used_grams: boundedNumber(0.01, 100000).nullable().optional(),
    slicer_filament_used_mm: boundedNumber(0.01, 100000000).nullable().optional(),
    slicer_support_grams: boundedNumber(0, 100000).nullable().optional(),
    slicer_layer_height_mm: boundedNumber(0.01, 5).nullable().optional(),
    slicer_infill_percent: boundedInt(0, 100).nullable().optional(),
    slicer_wall_loops: boundedInt(0, 100).nullable().optional(),
    slicer_supports_enabled: z.boolean().nullable().optional(),
    slicer_support_type: z.string().trim().min(1).nullable().optional(),
    slicer_part_weight_grams: boundedNumber(0, 100000).nullable().optional(),
    actual_print_time_minutes: boundedInt(1, 100000).nullable().optional(),
    actual_filament_used_grams: boundedNumber(0.01, 100000).nullable().optional(),
    print_started_at: timestampSchema.nullable().optional(),
    print_completed_at: timestampSchema.nullable().optional(),
    notes: z.string().nullable().optional(),
    // Nullable so the cost can be cleared back to "unpriced".
    cost: boundedNumber(0, 100000000).nullable().optional(),
    cost_inputs: costInputsSchema.nullable().optional()
  })
  .superRefine(pieceSuperRefine)
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required."
  });

export const duplicateOrderPieceSchema = z.object({
  count: boundedInt(1, 100)
});

export const replacePieceSpoolsSchema = z.object({
  spools: z
    .array(
      z.object({
        spool_asset_id: uuidSchema,
        planned_grams: boundedNumber(0.01, 100000),
        sequence_order: boundedInt(1, 100)
      })
    )
    .min(1)
})
.superRefine((value, ctx) => {
  const seenSpools = new Set<string>();
  const seenSequenceOrders = new Set<number>();

  value.spools.forEach((spool, index) => {
    if (seenSpools.has(spool.spool_asset_id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["spools", index, "spool_asset_id"],
        message: "Each spool can appear only once in a piece allocation list."
      });
    }
    seenSpools.add(spool.spool_asset_id);

    if (seenSequenceOrders.has(spool.sequence_order)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["spools", index, "sequence_order"],
        message: "sequence_order values must be unique."
      });
    }
    seenSequenceOrders.add(spool.sequence_order);
  });

  const ordered = value.spools
    .map((spool) => spool.sequence_order)
    .sort((left, right) => left - right);

  ordered.forEach((sequenceOrder, index) => {
    if (sequenceOrder !== index + 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["spools"],
        message: "sequence_order values must start at 1 and increase without gaps."
      });
    }
  });
});

export const schedulePieceSchema = z
  .object({
    scheduled_start_at: timestampSchema,
    scheduled_end_at: timestampSchema
  })
  .superRefine((value, ctx) => {
    if (value.scheduled_end_at <= value.scheduled_start_at) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scheduled_end_at"],
        message: "scheduled_end_at must be later than scheduled_start_at."
      });
    }
  });

export const startPieceExecutionSchema = z.object({
  started_at: timestampSchema
});

export const completePieceExecutionSchema = z.object({
  completed_at: timestampSchema,
  actual_print_time_minutes: boundedInt(1, 100000).optional(),
  actual_filament_used_grams: boundedNumber(0.01, 100000).optional(),
  notes: z.string().nullable().optional()
});

export const failPieceExecutionSchema = z.object({
  failed_at: timestampSchema,
  actual_print_time_minutes: boundedInt(1, 100000).optional(),
  actual_filament_used_grams: boundedNumber(0, 100000).optional(),
  notes: z.string().nullable().optional()
});
