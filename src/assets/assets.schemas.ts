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
// spools/tanks in real life (e.g. "A2", "1B", "X"). Kept short so it reads as a tag.
const markerSchema = z.string().trim().min(1).max(16).optional();
// A resin tank is not universally compatible: some resins are formulated for a
// specific light source. "both" is the permissive default.
const resinTechCompatSchema = z.enum(["MSLA", "SLA", "both"]);
// Multiplier shared by every asset intake: create N identical instances from one
// form submission (a box of four spools, four tanks, four nozzles).
const quantitySchema = z.coerce.number().int().min(1).max(100).optional();
// Assets → Finance rider. Naming a vendor books the intake as an itemized
// purchase bill (see FinanceService.recordInventoryPurchase); every field is
// optional so plain intake is unaffected.
const purchaseBillFields = {
  // Free-text vendor; matched case-insensitively against existing finance
  // vendors, registering a new one when nothing matches.
  vendor_name: z.string().trim().min(1).max(200).optional(),
  // Optional shipping/handling charge, booked as its own bill line.
  delivery_cost: z.coerce.number().min(0).max(999999999).optional(),
  // "Purchase Price already includes tax" — true suppresses tax (the price is
  // the gross line total); false/absent adds the company default tax rate.
  price_includes_tax: z.boolean().optional(),
  // "Already paid" — true posts the bill AND settles it from Cash in one step;
  // false/absent leaves it as an open payable.
  already_paid: z.boolean().optional()
} as const;

export const listAssetsQuerySchema = z.object({
  asset_type: z.enum(["filament_spool", "nozzle", "resin_tank", "spare_part"]).optional(),
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
    purchase_price: z.coerce.number().nullable().optional(),
    purchase_date: dateSchema,
    production_date: dateSchema,
    location: locationSchema,
    marker: markerSchema,
    // Multiplier: create this many identical spool instances from one form
    // submission (e.g. a box of 4). Defaults to 1. Each spool becomes its own
    // physical inventory row; they share the resolved filament reference.
    quantity: quantitySchema,
    notes: z.string().optional(),
    ...purchaseBillFields
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
  // Optional identity: a freeform display name and a brand. Neither is
  // mandatory — an unnamed nozzle keeps its "<material> <diameter>mm Nozzle"
  // derived label everywhere.
  nozzle_name: z.string().trim().min(1).max(120).optional(),
  nozzle_brand: z.string().trim().min(1).max(120).optional(),
  nozzle_diameter_mm: boundedNumber(0.1, 2),
  nozzle_material: nozzleMaterialSchema,
  nozzle_max_temp: boundedInt(100, 600).optional(),
  purchase_price: z.coerce.number().min(0).nullable().optional(),
  location: locationSchema,
  // Multiplier: create this many identical nozzle instances from one form
  // submission (same convention as spools). Defaults to 1.
  quantity: z.coerce.number().int().min(1).max(100).optional(),
  notes: z.string().optional()
});

// Spare parts (fans, belts, PTFE tubes — any loose replacement piece) are the
// simplest asset shape: a required name, an optional brand, a price, and an
// optional description (stored in the shared notes column). Same ×N multiplier
// and finance-purchase riders as spools/nozzles.
export const createSparePartSchema = z.object({
  spare_part_name: z.string().trim().min(1).max(160),
  spare_part_brand: z.string().trim().min(1).max(120).optional(),
  purchase_price: z.coerce.number().min(0).nullable().optional(),
  location: locationSchema,
  // Multiplier: create this many identical spare-part instances from one form
  // submission (same convention as spools/nozzles). Defaults to 1.
  quantity: quantitySchema,
  // The form's "Description" — persisted in asset_instances.notes like every
  // other asset's freeform text.
  notes: z.string().optional(),
  ...purchaseBillFields
});

// A resin tank is the resin analogue of a filament spool: a consumable bought
// by the bottle, drawn down by jobs, and worth exactly the same intake
// affordances (×N multiplier, marker, price, purchase bill). The one thing it
// has that filament doesn't is a shelf life that starts when the bottle is
// opened, not when it was bought.
export const createResinTankSchema = z
  .object({
    resin_brand: z.string().trim().min(1),
    resin_type: z.string().trim().min(1),
    resin_color: z.string().trim().min(1).optional(),
    resin_hex: hexColorSchema.optional(),
    // Which light source this resin is formulated for. Defaults to "both".
    resin_tech_compat: resinTechCompatSchema.optional(),
    resin_uv_wavelength_nm: boundedInt(200, 600).optional(),
    resin_uv_reactive: z.boolean().optional(),
    // g/ml — varies per material (standard ≈ 1.1, tough ≈ 1.05), so it is a
    // per-tank field and never a hardcoded constant.
    resin_density: boundedNumber(0.1, 10).optional(),
    resin_initial_volume_ml: boundedNumber(1, 100000),
    // Bottle size, for restock reference. Defaults to the initial volume.
    resin_total_volume_ml: boundedNumber(1, 100000).optional(),
    purchase_price: z.coerce.number().min(0).nullable().optional(),
    resin_purchase_date: dateSchema,
    resin_production_date: dateSchema,
    resin_opened_at: dateSchema,
    resin_expiry_date: dateSchema,
    resin_datasheet_url: z.string().trim().url().max(2000).optional(),
    location: locationSchema,
    marker: markerSchema,
    // Multiplier: create this many identical tanks from one submission (same
    // convention as spools/nozzles/spare parts). Defaults to 1.
    quantity: quantitySchema,
    notes: z.string().optional(),
    ...purchaseBillFields
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

    if (
      value.resin_expiry_date &&
      value.resin_opened_at &&
      value.resin_expiry_date < value.resin_opened_at
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resin_expiry_date"],
        message: "resin_expiry_date cannot be earlier than resin_opened_at."
      });
    }

    if (
      value.resin_total_volume_ml !== undefined &&
      value.resin_total_volume_ml < value.resin_initial_volume_ml
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resin_total_volume_ml"],
        message: "resin_total_volume_ml cannot be smaller than the volume this tank was filled with."
      });
    }
  });

export const updateAssetSchema = z
  .object({
    initial_grams: boundedNumber(1, 100000).optional(),
    purchase_price: z.coerce.number().nullable().optional(),
    purchase_date: dateSchema,
    production_date: dateSchema,
    nozzle_diameter_mm: boundedNumber(0.1, 2).optional(),
    nozzle_material: nozzleMaterialSchema.optional(),
    nozzle_max_temp: boundedInt(100, 600).optional(),
    // Nullable so the editor can CLEAR the name/brand (client sends null).
    nozzle_name: z.string().trim().min(1).max(120).nullable().optional(),
    nozzle_brand: z.string().trim().min(1).max(120).nullable().optional(),
    // A spare part's name is its whole identity, so it can be changed but not
    // cleared (the client drops the field when the input is emptied); the
    // brand is clearable like the nozzle one.
    spare_part_name: z.string().trim().min(1).max(160).optional(),
    spare_part_brand: z.string().trim().min(1).max(120).nullable().optional(),
    resin_brand: z.string().trim().min(1).optional(),
    resin_type: z.string().trim().min(1).optional(),
    // Nullable so the editor can CLEAR an optional resin descriptor.
    resin_color: z.string().trim().min(1).nullable().optional(),
    resin_hex: hexColorSchema.nullable().optional(),
    resin_tech_compat: resinTechCompatSchema.optional(),
    resin_uv_wavelength_nm: boundedInt(200, 600).nullable().optional(),
    resin_uv_reactive: z.boolean().optional(),
    resin_density: boundedNumber(0.1, 10).nullable().optional(),
    resin_initial_volume_ml: boundedNumber(1, 100000).optional(),
    resin_total_volume_ml: boundedNumber(1, 100000).nullable().optional(),
    resin_purchase_date: dateSchema,
    resin_production_date: dateSchema,
    // Opening a tank starts its shelf life, so both are editable after intake —
    // an operator typically opens a tank days after buying it.
    resin_opened_at: baseDateSchema.nullable().optional(),
    resin_expiry_date: baseDateSchema.nullable().optional(),
    resin_datasheet_url: z.string().trim().url().max(2000).nullable().optional(),
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
  asset_type: z.enum(["filament_spool", "nozzle", "resin_tank", "spare_part"]).optional(),
  days: z.coerce.number().int().min(1).max(365).optional().default(30)
});

export const assetsOverviewQuerySchema = z.object({
  period: z.enum(["week", "month", "year", "all"]).optional().default("week")
});

// Split an idle bulk consumable into N children — a filament spool decanted into
// smaller spools, or a resin bottle poured into several tanks. `children` is the
// per-child allocation in the parent's own unit (grams for a spool, millilitres
// for a tank); its sum must equal the parent's current remaining quantity
// (enforced in the service against the live stock value, with a small rounding
// tolerance).
export const splitAssetSchema = z.object({
  children: z
    .array(boundedNumber(0.01, 100000))
    .min(2, "A split must produce at least 2 children.")
    .max(50, "A split can produce at most 50 children.")
});
