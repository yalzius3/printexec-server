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
  // Post-production fulfilment lifecycle. Added without any auto-transition
  // logic yet — the allowed transitions between these are still to be defined.
  "ready_for_shipping",
  "out_for_shipping",
  "returned",
  "fulfilled",
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

// Per-piece shipping lifecycle, tracked separately from production `status`
// (the piece stays `done`). 'none' is accepted as a TARGET — that is a piece
// being pulled back out of shipping to a plain done print, the undo of the first
// forward step. Which pairs are actually legal is the service's call
// (PIECE_FULFILMENT_TRANSITIONS); this only bounds the vocabulary.
export const pieceFulfilmentTargetSchema = z.enum([
  "none",
  "ready_for_shipping",
  "out_for_shipping",
  "fulfilled"
]);

export const transitionPieceFulfilmentSchema = z.object({
  status: pieceFulfilmentTargetSchema
});

// Resin post-processing. A resin print isn't a finished part when the printer
// stops — it comes off the plate coated in uncured resin and has to be washed,
// then cured. Tracked separately from production `status` (the piece stays
// 'done') for the same reason fulfilment is: it is an orthogonal lifecycle, and
// forcing it into `status` would break every existing status query.
//
// Every transition is a manual operator action. No durations, no thresholds,
// no overdue flags — deliberately, because wash and cure times vary by resin,
// part geometry and equipment, and a wrong automatic deadline is worse than none.
export const postProcessStateSchema = z.enum(["print_done", "washed", "cured"]);

// 'print_done' is accepted only as the undo of "marked washed" — the system
// stamps it when a resin print completes, and an operator reaches it by walking
// back, never by picking it as a forward step. The service's transition table
// enforces that; this only bounds the vocabulary.
export const postProcessTargetSchema = z.enum(["print_done", "washed", "cured"]);

export const transitionPiecePostProcessSchema = z.object({
  state: postProcessTargetSchema
});

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
    // Guest capture, used only when customer_id is absent. A CHECK constraint
    // on the orders table (chk_orders_customer_or_guest, added NOT VALID in
    // 2026-07-03_orders_guest_info.sql) backstops this at the DB layer.
    guest_name: z.string().trim().min(1).max(200).optional(),
    guest_email: z.string().trim().email().optional(),
    guest_phone: z.string().trim().min(1).max(40).optional(),
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

    // Require guest info whenever no existing customer was picked.
    if (!value.customer_id) {
      if (!value.guest_name) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["guest_name"],
          message: "Provide a customer name, or pick an existing customer."
        });
      }
      if (!value.guest_email && !value.guest_phone) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["guest_email"],
          message: "Provide a phone number or email for the customer."
        });
      }
    }
  });

// Per-order pricing tweak persisted on orders.costing_config. variable_ids fold
// Finance costing variables into the equation's `variables`; custom_lines are
// ad-hoc charges; margin_override_pct mirrors profit_pct (the canonical override).
const costingCustomLineSchema = z.object({
  label: z.string().trim().min(1).max(120),
  amount: boundedNumber(0, 100000000)
});
const costingConfigSchema = z
  .object({
    variable_ids: z.array(uuidSchema).max(64).optional(),
    custom_lines: z.array(costingCustomLineSchema).max(32).optional(),
    margin_override_pct: boundedNumber(0, 1000000).nullable().optional()
  })
  .strip();

export const updateOrderSchema = z
  .object({
    // Assigning a customer to an order that was created without one (and, after
    // the first assignment, changing it). Optional so other PATCHes are unaffected.
    customer_id: uuidSchema.optional(),
    // Editable on drafts (e.g. fixing a typo before confirm). Nullable so they
    // can be cleared once a customer_id is assigned another way. No
    // guest-required refine here — this schema backs every PATCH (including
    // ones unrelated to customer/status) and can't see the current row; that
    // check lives in OrdersService.updateOrder instead.
    guest_name: z.string().trim().min(1).max(200).nullable().optional(),
    guest_email: z.string().trim().email().nullable().optional(),
    guest_phone: z.string().trim().min(1).max(40).nullable().optional(),
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
    labor_cost: boundedNumber(0, 100000000).nullable().optional(),
    // Operator-entered profit margin (%) for the order (nullable to clear).
    profit_pct: boundedNumber(0, 1000000).nullable().optional(),
    // Which pricing preset prices this order (null clears → legacy pricing).
    costing_preset_id: uuidSchema.nullable().optional(),
    // Per-order costing tweak: selected variables + custom charges (null clears).
    costing_config: costingConfigSchema.nullable().optional()
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
    // ── Resin (MSLA/SLA) ────────────────────────────────────────────────────
    // The physical tank feeding this job — the resin analogue of a spool
    // reservation, except a resin job draws from exactly one tank, so it lives
    // on the piece rather than in a join table.
    resin_tank_id: uuidSchema.optional(),
    // The slicer's volume estimate. Resin slicers report millilitres, and resin
    // is bought by the litre, so mL is the unit end to end — it is never
    // converted into slicer_filament_used_grams.
    slicer_resin_used_ml: boundedNumber(0.01, 100000).optional(),
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
    // The slicer file is an optional attachment — slicer metadata (time, grams,
    // profile, …) can be entered or parsed without ever storing the file, so we
    // no longer require slicer_file_url alongside it. The uploaded-at timestamp,
    // however, only makes sense when a file actually exists.
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

    // Resin fields belong to resin jobs, exactly as nozzle fields belong to FDM
    // ones. Enforced symmetrically so a piece can never carry both a spool
    // allocation and a tank.
    const usesResinFields =
      value.resin_tank_id !== undefined && value.resin_tank_id !== null
        ? true
        : value.slicer_resin_used_ml !== undefined && value.slicer_resin_used_ml !== null;

    if (
      usesResinFields &&
      value.required_print_technology &&
      value.required_print_technology !== "MSLA" &&
      value.required_print_technology !== "SLA"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["required_print_technology"],
        message: "Resin tanks and resin volume only apply to MSLA/SLA pieces."
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
    // Nullable so the editor can UNLINK the tank / clear the volume.
    resin_tank_id: uuidSchema.nullable().optional(),
    slicer_resin_used_ml: boundedNumber(0.01, 100000).nullable().optional(),
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
