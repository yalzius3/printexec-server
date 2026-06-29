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
const queryBooleanSchema = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((value) => value === true || value === "true");
const serialNumberSchema = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._/-]{4,31}$/,
    "serial_number must be 5-32 characters using letters, numbers, dots, underscores, slashes, or dashes."
  );
const boundedInt = (min: number, max: number) =>
  z.coerce.number().int().min(min).max(max);
const boundedNumber = (min: number, max: number) =>
  z.coerce.number().min(min).max(max);
const nozzleDiameterListSchema = z.array(boundedNumber(0.1, 2)).max(12).optional();

export const createPrinterReferenceSchema = z
  .object({
    brand: z.string().trim().min(1),
    model: z.string().trim().min(1),
    print_technology: z.enum(["FDM", "MSLA", "SLA", "SLS"]),
    build_volume_x_mm: boundedNumber(1, 5000),
    build_volume_y_mm: boundedNumber(1, 5000),
    build_volume_z_mm: boundedNumber(1, 5000),
    max_hotend_temp: boundedInt(0, 600).nullable().optional(),
    max_bed_temp: boundedInt(0, 250).nullable().optional(),
    extruder_type: z.enum(["direct_drive", "bowden"]).nullable().optional(),
    nozzle_count: boundedInt(0, 32).optional(),
    compatible_nozzle_diameters: nozzleDiameterListSchema,
    compatible_materials: z.array(z.string().trim().min(1)).max(32).optional(),
    max_filament_diameter: boundedNumber(1, 4).nullable().optional(),
    is_multicolor: z.boolean().optional(),
    ams_unit_count: boundedInt(0, 32).nullable().optional(),
    max_color_count: boundedInt(0, 64).nullable().optional(),
    uv_wavelength_nm: boundedInt(200, 600).nullable().optional(),
    build_platform_type: z.string().trim().min(1).max(120).nullable().optional(),
    has_camera: z.boolean().optional(),
    has_enclosure: z.boolean().optional(),
    has_filament_sensor: z.boolean().optional(),
    network_capability: z
      .enum(["wifi", "ethernet", "wifi_ethernet", "usb_only"])
      .nullable()
      .optional(),
    description: z.string().optional(),
    notes: z.string().optional()
  })
  .superRefine((value, ctx) => {
    const isFdm = value.print_technology === "FDM";
    const isResin = value.print_technology === "MSLA" || value.print_technology === "SLA";

    if (
      value.max_hotend_temp !== null &&
      value.max_hotend_temp !== undefined &&
      value.max_bed_temp !== null &&
      value.max_bed_temp !== undefined &&
      value.max_bed_temp > value.max_hotend_temp
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["max_bed_temp"],
        message: "max_bed_temp cannot exceed max_hotend_temp."
      });
    }

    if (isFdm) {
      if (!value.extruder_type) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["extruder_type"],
          message: "extruder_type is required for FDM printers."
        });
      }

      if (value.nozzle_count === undefined || value.nozzle_count < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nozzle_count"],
          message: "nozzle_count must be at least 1 for FDM printers."
        });
      }

      if (value.max_filament_diameter === null || value.max_filament_diameter === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["max_filament_diameter"],
          message: "max_filament_diameter is required for FDM printers."
        });
      }

      if (!value.compatible_nozzle_diameters?.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["compatible_nozzle_diameters"],
          message: "Provide at least one compatible nozzle diameter for FDM printers."
        });
      }

      if (value.uv_wavelength_nm !== null && value.uv_wavelength_nm !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["uv_wavelength_nm"],
          message: "uv_wavelength_nm applies to resin printers, not FDM."
        });
      }
    }

    if (isResin) {
      if (value.uv_wavelength_nm === null || value.uv_wavelength_nm === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["uv_wavelength_nm"],
          message: "uv_wavelength_nm is required for resin printers."
        });
      }

      if (value.extruder_type) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["extruder_type"],
          message: "extruder_type applies only to FDM printers."
        });
      }

      if (value.max_filament_diameter !== null && value.max_filament_diameter !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["max_filament_diameter"],
          message: "max_filament_diameter applies only to FDM printers."
        });
      }

      if (value.compatible_nozzle_diameters?.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["compatible_nozzle_diameters"],
          message: "compatible_nozzle_diameters apply only to FDM printers."
        });
      }

      if (value.nozzle_count !== undefined && value.nozzle_count !== 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nozzle_count"],
          message: "nozzle_count must be 0 or omitted for resin printers."
        });
      }
    }

    if (value.print_technology === "SLS") {
      if (value.extruder_type) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["extruder_type"],
          message: "extruder_type does not apply to SLS printers."
        });
      }

      if (value.max_filament_diameter !== null && value.max_filament_diameter !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["max_filament_diameter"],
          message: "max_filament_diameter does not apply to SLS printers."
        });
      }

      if (value.compatible_nozzle_diameters?.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["compatible_nozzle_diameters"],
          message: "compatible_nozzle_diameters do not apply to SLS printers."
        });
      }

      if (value.uv_wavelength_nm !== null && value.uv_wavelength_nm !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["uv_wavelength_nm"],
          message: "uv_wavelength_nm does not apply to SLS printers."
        });
      }
    }

    if (value.is_multicolor) {
      if (!isFdm) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["is_multicolor"],
          message: "Multicolor support is only tracked for FDM printers in phase 1."
        });
      }

      if (value.max_color_count === null || value.max_color_count === undefined || value.max_color_count < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["max_color_count"],
          message: "max_color_count must be at least 2 when is_multicolor is true."
        });
      }
    } else {
      if (value.ams_unit_count !== null && value.ams_unit_count !== undefined && value.ams_unit_count > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ams_unit_count"],
          message: "ams_unit_count should be 0 or omitted unless the printer is multicolor."
        });
      }

      if (value.max_color_count !== null && value.max_color_count !== undefined && value.max_color_count > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["max_color_count"],
          message: "max_color_count should be 1 or omitted unless the printer is multicolor."
        });
      }
    }
  });

export const createPrinterSchema = z
  .object({
    printer_ref_id: uuidSchema.optional(),
    custom_reference: createPrinterReferenceSchema.optional(),
    serial_number: serialNumberSchema.optional(),
    purchase_date: dateSchema,
    purchase_price: z.coerce.number().min(0).nullable().optional(),
    power_watts: z.coerce.number().nullable().optional(),
    location: z.string().trim().min(1).optional(),
    notes: z.string().optional(),
    // Operator-set starting meter for hours already worked before this printer
    // was added to the system. Editable later via the stock PATCH.
    total_print_hours: z.coerce.number().min(0).optional()
  })
  .superRefine((value, ctx) => {
    if (!value.printer_ref_id && !value.custom_reference) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide printer_ref_id or custom_reference."
      });
    }

    if (value.printer_ref_id && value.custom_reference) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["custom_reference"],
        message: "Provide either printer_ref_id or custom_reference, not both."
      });
    }
  });

export const listPrinterReferencesQuerySchema = z.object({
  brand: z.string().trim().min(1).optional(),
  technology: z.enum(["FDM", "MSLA", "SLA", "SLS"]).optional(),
  search: z.string().trim().min(1).optional()
});

export const listPrintersQuerySchema = z.object({
  search: z.string().trim().min(1).optional(),
  is_in_use: queryBooleanSchema.optional(),
  is_under_maintenance: queryBooleanSchema.optional(),
  is_offline: queryBooleanSchema.optional()
});

export const updatePrinterSchema = z
  .object({
    printer_ref_id: uuidSchema.optional(),
    custom_reference: createPrinterReferenceSchema.optional(),
    serial_number: serialNumberSchema.nullable().optional(),
    purchase_date: baseDateSchema.nullable().optional(),
    purchase_price: z.coerce.number().min(0).nullable().optional(),
    power_watts: z.coerce.number().nullable().optional(),
    location: z.string().trim().min(1).nullable().optional(),
    notes: z.string().nullable().optional(),
    // Optional short freeform marker to physically distinguish otherwise-identical
    // printers. Nullable so the editor can CLEAR it (client sends null for empty).
    marker: z.string().trim().min(1).max(16).nullable().optional()
  })
  .superRefine((value, ctx) => {
    if (value.printer_ref_id && value.custom_reference) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["custom_reference"],
        message: "Provide either printer_ref_id or custom_reference, not both."
      });
    }
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required."
  });

export const updatePrinterStockSchema = z
  .object({
    is_in_use: z.boolean().optional(),
    is_under_maintenance: z.boolean().optional(),
    is_offline: z.boolean().optional(),
    currently_printing_order_id: uuidSchema.nullable().optional(),
    currently_printing_piece_id: uuidSchema.nullable().optional(),
    print_started_at: timestampSchema.nullable().optional(),
    estimated_print_end_at: timestampSchema.nullable().optional(),
    next_free_at: timestampSchema.nullable().optional(),
    last_available_at: timestampSchema.nullable().optional(),
    current_nozzle_asset_id: uuidSchema.nullable().optional(),
    maintenance_started_at: timestampSchema.nullable().optional(),
    maintenance_reason: z.string().nullable().optional(),
    total_print_hours: z.coerce.number().min(0).optional(),
    last_maintenance_at: timestampSchema.nullable().optional()
  })
  .superRefine((value, ctx) => {
    if (
      value.print_started_at &&
      value.estimated_print_end_at &&
      value.estimated_print_end_at < value.print_started_at
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["estimated_print_end_at"],
        message: "estimated_print_end_at cannot be earlier than print_started_at."
      });
    }

    if (
      value.is_in_use === false &&
      ((value.currently_printing_order_id !== undefined &&
        value.currently_printing_order_id !== null) ||
        (value.currently_printing_piece_id !== undefined &&
          value.currently_printing_piece_id !== null) ||
        (value.print_started_at !== undefined && value.print_started_at !== null) ||
        (value.estimated_print_end_at !== undefined && value.estimated_print_end_at !== null))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["is_in_use"],
        message: "A printer marked as not in use cannot also hold active printing fields."
      });
    }

    if (
      value.is_under_maintenance === false &&
      ((value.maintenance_started_at !== undefined && value.maintenance_started_at !== null) ||
        (value.maintenance_reason !== undefined && value.maintenance_reason !== null))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["is_under_maintenance"],
        message: "Maintenance fields require is_under_maintenance to be true."
      });
    }

    if (value.is_offline === true && value.is_in_use === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["is_offline"],
        message: "A printer cannot be marked offline and in use at the same time."
      });
    }
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required."
  });

export const addCompatibleNozzleSchema = z.object({
  nozzle_asset_id: uuidSchema,
  notes: z.string().optional()
});
