import { z } from "zod";

/**
 * Operator-facing kinds — must mirror the DB CHECK constraint exactly so the
 * server doesn't smuggle a value the database will reject.
 */
export const ATTACHMENT_KINDS = ["stl", "pdf", "image", "document", "archive", "other"] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];
export const attachmentKindSchema = z.enum(ATTACHMENT_KINDS);

/** Path or URL — the uploads controller returns `/api/uploads/...` so plain
 *  z.string().url() is too strict. */
const fileUrl = z
  .string()
  .min(1)
  .refine((v) => /^(https?:\/\/|\/)/.test(v), "Must be a URL or absolute path.");

export const createAttachmentSchema = z.object({
  file_url: fileUrl,
  original_name: z.string().min(1).max(255),
  mime_type: z.string().max(255).nullable().optional(),
  size_bytes: z.number().int().nonnegative().nullable().optional(),
  kind: attachmentKindSchema.optional(),
  notes: z.string().max(1000).nullable().optional(),
}).strict();
export type CreateAttachmentInput = z.infer<typeof createAttachmentSchema>;

export const updateAttachmentSchema = z.object({
  original_name: z.string().min(1).max(255).optional(),
}).strict();
export type UpdateAttachmentInput = z.infer<typeof updateAttachmentSchema>;
