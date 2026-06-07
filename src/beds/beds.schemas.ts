import { z } from "zod";

const uuid = z.string().uuid();

/** A bed is created from ≥2 pieces. All pieces must share the same technology
 *  (validated server-side). Filament/nozzle requirements are inherited from
 *  the first piece and verified consistent across the rest. */
export const createBedSchema = z.object({
  bed_name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  piece_ids: z.array(uuid).min(2),
  // When the selected pieces have no required_print_technology (or the
  // operator wants to force one), this sets the bed's technology AND
  // back-fills it onto any piece that's missing one.
  technology: z.enum(["FDM", "MSLA", "SLA", "SLS"]).optional(),
}).strict();
export type CreateBedInput = z.infer<typeof createBedSchema>;

export const updateBedSchema = z.object({
  bed_name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  required_filament_material: z.string().min(1).max(120).nullable().optional(),
}).strict();
export type UpdateBedInput = z.infer<typeof updateBedSchema>;

/** Mirrors the same shape as jobs.schemas/updatePieceFilesSchema. */
const fileUrl = z
  .string()
  .min(1)
  .refine((v) => /^(https?:\/\/|\/)/.test(v), "Must be a URL or absolute path.");

export const updateBedFilesSchema = z.object({
  slicer_file_url: fileUrl.nullable().optional(),
  stl_file_url: fileUrl.nullable().optional(),
  slicer_print_time_minutes: z.number().int().positive().max(100_000).nullable().optional(),
  slicer_filament_used_grams: z.number().positive().max(100_000).nullable().optional(),
}).strict().refine(
  (v) => Object.values(v).some((x) => x !== undefined),
  { message: "Provide at least one field to update." }
);
export type UpdateBedFilesInput = z.infer<typeof updateBedFilesSchema>;
