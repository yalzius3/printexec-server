import { z } from "zod";

const uuidSchema = z.string().uuid();
const earliestReasonableDate = "2000-01-01";
const latestReasonableDate = "2100-12-31";
const baseDateSchema = z.iso
  .date()
  .refine(
    (value) => value >= earliestReasonableDate && value <= latestReasonableDate,
    `Date must be between ${earliestReasonableDate} and ${latestReasonableDate}.`
  );
const dateSchema = baseDateSchema.optional();
const timestampSchema = z.iso.datetime({ offset: true }).optional();
const boundedInt = (min: number, max: number) =>
  z.coerce.number().int().min(min).max(max);
const boundedNumber = (min: number, max: number) =>
  z.coerce.number().min(min).max(max);
const hexColorSchema = z
  .string()
  .trim()
  .regex(/^[A-Fa-f0-9]{6}$/, "Must be a 6-character hexadecimal color.");
const orderedIntRangeSchema = (min: number, max: number, label: string) =>
  z
    .array(boundedInt(min, max))
    .length(2)
    .refine((range) => {
      const start = range[0];
      const end = range[1];
      return start !== undefined && end !== undefined && start <= end;
    }, `${label} must be an ascending range.`);
const nozzleMaterialSchema = z.enum([
  "brass",
  "stainless_steel",
  "hardened_steel",
  "tungsten_carbide",
  "ruby_tipped",
  "copper_alloy"
]);
// Optional free-text physical location of an asset instance (e.g. "Shelf B3").
// Nullable, non-mandatory — just a meaningful identifier for duplicate assets.
const locationSchema = z.string().trim().min(1).max(120).optional();
// Optional short freeform marker to physically distinguish otherwise-identical
// spools in real life (e.g. "A2", "1B", "X"). Kept short so it reads as a tag.
const markerSchema = z.string().trim().min(1).max(16).optional();

export const listAssetsQuerySchema = z.object({
  asset_type: z.enum(["filament_spool", "nozzle", "resin_tank"]).optional(),
  status: z.enum(["available", "in_use", "installed", "empty", "damaged"]).optional(),
  search: z.string().trim().min(1).optional()
});

export const createFilamentReferenceSchema = z
  .object({
    brand: z.string().trim().min(1),
    material_type: z.string().trim().min(1),
    color: z.string().trim().min(1),
    diameter: boundedNumber(1, 3),
    melting_temp: boundedInt(120, 450).optional(),
    max_print_speed_mm_s: boundedInt(1, 2000).optional(),
    hex: hexColorSchema.optional(),
    density: boundedNumber(0.1, 10).optional(),
    bed_temp: boundedInt(0, 200).optional(),
    bed_temp_range: orderedIntRangeSchema(0, 200, "bed_temp_range").optional(),
    extruder_temp_range: orderedIntRangeSchema(100, 500, "extruder_temp_range").optional(),
    finish: z.enum(["matte", "glossy"]).optional(),
    fill: z.enum(["glass fiber", "carbon fiber", "wood"]).optional(),
    pattern: z.enum(["marble", "sparkle"]).optional(),
    multi_color_direction: z.enum(["coaxial", "longitudinal"]).optional(),
    translucent: z.boolean().optional(),
    glow: z.boolean().optional(),
    description: z.string().optional(),
    notes: z.string().optional()
  })
  .superRefine((value, ctx) => {
    if (value.bed_temp !== undefined && value.bed_temp_range) {
      const min = value.bed_temp_range[0];
      const max = value.bed_temp_range[1];

      if (min !== undefined && max !== undefined && (value.bed_temp < min || value.bed_temp > max)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["bed_temp"],
          message: "bed_temp must fall inside bed_temp_range."
        });
      }
    }

    if (value.melting_temp !== undefined && value.extruder_temp_range) {
      const min = value.extruder_temp_range[0];
      const max = value.extruder_temp_range[1];

      if (
        min !== undefined &&
        max !== undefined &&
        (value.melting_temp < min || value.melting_temp > max)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["melting_temp"],
          message: "melting_temp must fall inside extruder_temp_range."
        });
      }
    }
  });

const customFilamentReferenceSchema = createFilamentReferenceSchema.optional();

export const createSpoolSchema = z
  .object({
    filament_ref_id: uuidSchema.optional(),
    custom_reference: customFilamentReferenceSchema,
    initial_grams: boundedNumber(1, 100000),
    purchase_date: dateSchema,
    production_date: dateSchema,
    location: locationSchema,
    marker: markerSchema,
    notes: z.string().optional()
  })
  .superRefine((value, ctx) => {
    if (!value.filament_ref_id && !value.custom_reference) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide filament_ref_id or custom_reference."
      });
    }

    if (value.filament_ref_id && value.custom_reference) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["custom_reference"],
        message: "Provide either filament_ref_id or custom_reference, not both."
      });
    }

    if (value.purchase_date && value.production_date && value.purchase_date < value.production_date) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["purchase_date"],
        message: "purchase_date cannot be earlier than production_date."
      });
    }
  });

export const createNozzleSchema = z.object({
  nozzle_diameter_mm: boundedNumber(0.1, 2),
  nozzle_material: nozzleMaterialSchema,
  nozzle_max_temp: boundedInt(100, 600).optional(),
  location: locationSchema,
  notes: z.string().optional()
});

export const createResinTankSchema = z
  .object({
    resin_brand: z.string().trim().min(1),
    resin_type: z.string().trim().min(1),
    resin_color: z.string().trim().min(1).optional(),
    resin_hex: hexColorSchema.optional(),
    resin_uv_wavelength_nm: boundedInt(200, 600).optional(),
    resin_uv_reactive: z.boolean().optional(),
    resin_density: boundedNumber(0.1, 10).optional(),
    resin_initial_volume_ml: boundedNumber(1, 100000),
    resin_purchase_date: dateSchema,
    resin_production_date: dateSchema,
    location: locationSchema,
    notes: z.string().optional()
  })
  .superRefine((value, ctx) => {
    if (
      value.resin_purchase_date &&
      value.resin_production_date &&
      value.resin_purchase_date < value.resin_production_date
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resin_purchase_date"],
        message: "resin_purchase_date cannot be earlier than resin_production_date."
      });
    }
  });

export const updateAssetSchema = z
  .object({
    initial_grams: boundedNumber(1, 100000).optional(),
    purchase_date: dateSchema,
    production_date: dateSchema,
    nozzle_diameter_mm: boundedNumber(0.1, 2).optional(),
    nozzle_material: nozzleMaterialSchema.optional(),
    nozzle_max_temp: boundedInt(100, 600).optional(),
    resin_brand: z.string().trim().min(1).optional(),
    resin_type: z.string().trim().min(1).optional(),
    resin_color: z.string().trim().min(1).optional(),
    resin_hex: hexColorSchema.optional(),
    resin_uv_wavelength_nm: boundedInt(200, 600).optional(),
    resin_uv_reactive: z.boolean().optional(),
    resin_density: boundedNumber(0.1, 10).optional(),
    resin_initial_volume_ml: boundedNumber(1, 100000).optional(),
    resin_purchase_date: dateSchema,
    resin_production_date: dateSchema,
    location: z.string().trim().min(1).max(120).nullable().optional(),
    // Nullable so the editor can CLEAR the marker (client sends null for empty).
    marker: z.string().trim().min(1).max(16).nullable().optional(),
    // Nullable so the editor can CLEAR notes (the client sends null for an empty
    // field). Without this, saving an asset with an empty Notes box 400s.
    notes: z.string().nullable().optional()
  })
  .superRefine((value, ctx) => {
    if (value.purchase_date && value.production_date && value.purchase_date < value.production_date) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["purchase_date"],
        message: "purchase_date cannot be earlier than production_date."
      });
    }

    if (
      value.resin_purchase_date &&
      value.resin_production_date &&
      value.resin_purchase_date < value.resin_production_date
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resin_purchase_date"],
        message: "resin_purchase_date cannot be earlier than resin_production_date."
      });
    }
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required."
  });

export const updateAssetStockSchema = z
  .object({
    status: z.enum(["available", "in_use", "installed", "empty", "damaged"]).optional(),
    remaining_grams: z.coerce.number().min(0).nullable().optional(),
    remaining_volume_ml: z.coerce.number().min(0).nullable().optional(),
    currently_used_in_piece_id: uuidSchema.nullable().optional(),
    in_use_since: timestampSchema.nullable().optional(),
    installed_on_asset_id: uuidSchema.nullable().optional(),
    next_free_at: timestampSchema.nullable().optional()
  })
  .superRefine((value, ctx) => {
    if (value.status === "empty") {
      if (value.remaining_grams !== undefined && value.remaining_grams !== null && value.remaining_grams !== 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["remaining_grams"],
          message: "remaining_grams must be 0 when status is empty."
        });
      }

      if (
        value.remaining_volume_ml !== undefined &&
        value.remaining_volume_ml !== null &&
        value.remaining_volume_ml !== 0
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["remaining_volume_ml"],
          message: "remaining_volume_ml must be 0 when status is empty."
        });
      }
    }

    if (
      value.status === "available" &&
      ((value.currently_used_in_piece_id !== undefined && value.currently_used_in_piece_id !== null) ||
        (value.installed_on_asset_id !== undefined && value.installed_on_asset_id !== null))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "available assets cannot also be marked as used or installed."
      });
    }

    if (
      value.currently_used_in_piece_id === null &&
      value.in_use_since !== undefined &&
      value.in_use_since !== null &&
      value.status !== "installed"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["in_use_since"],
        message: "in_use_since requires a linked piece or an installed status."
      });
    }
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one stock field is required."
  });

export const listFilamentReferencesQuerySchema = z.object({
  brand: z.string().trim().min(1).optional(),
  material_type: z.string().trim().min(1).optional(),
  search: z.string().trim().min(1).optional()
});

export const listAssetHistoryQuerySchema = z.object({
  event_type: z.enum(["addition", "edit", "assignation"]).optional(),
  asset_type: z.enum(["filament_spool", "nozzle", "resin_tank"]).optional(),
  days: z.coerce.number().int().min(1).max(365).optional().default(30)
});
