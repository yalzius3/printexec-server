import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type {
  AttachmentKind,
  CreateAttachmentInput,
  UpdateAttachmentInput,
} from "./order-attachments.schemas";

interface AttachmentRow {
  attachment_id: string;
  company_id: string;
  order_id: string;
  file_url: string;
  original_name: string;
  mime_type: string | null;
  size_bytes: number | null;
  kind: AttachmentKind;
  uploaded_at: string;
  uploaded_by: string | null;
  notes: string | null;
}

@Injectable()
export class OrderAttachmentsService {
  constructor(private readonly databaseService: DatabaseService) {}

  /** Confirm the order belongs to the caller's company before any I/O. */
  private async assertOrderInCompany(companyId: string, orderId: string): Promise<void> {
    const res = await this.databaseService.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM orders WHERE order_id = $1 AND company_id = $2
       ) AS exists`,
      [orderId, companyId]
    );
    if (!res.rows[0]?.exists) {
      throw new NotFoundException("Order not found.");
    }
  }

  async list(companyId: string, orderId: string): Promise<AttachmentRow[]> {
    await this.assertOrderInCompany(companyId, orderId);
    const res = await this.databaseService.query<AttachmentRow>(
      `SELECT attachment_id, company_id, order_id, file_url, original_name,
              mime_type, size_bytes, kind, uploaded_at, uploaded_by, notes
         FROM order_attachments
        WHERE company_id = $1 AND order_id = $2
        ORDER BY uploaded_at DESC`,
      [companyId, orderId]
    );
    return res.rows;
  }

  async create(
    companyId: string,
    orderId: string,
    input: CreateAttachmentInput,
    uploadedBy?: string
  ): Promise<AttachmentRow> {
    await this.assertOrderInCompany(companyId, orderId);
    // Infer the `kind` from the filename extension if the caller didn't supply one.
    // This keeps the frontend simple — just upload and link, the kind sorts itself out.
    const kind = input.kind ?? this.inferKind(input.original_name, input.mime_type);
    const res = await this.databaseService.query<AttachmentRow>(
      `INSERT INTO order_attachments (
         company_id, order_id, file_url, original_name,
         mime_type, size_bytes, kind, uploaded_by, notes
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING attachment_id, company_id, order_id, file_url, original_name,
                 mime_type, size_bytes, kind, uploaded_at, uploaded_by, notes`,
      [
        companyId,
        orderId,
        input.file_url,
        input.original_name,
        input.mime_type ?? null,
        input.size_bytes ?? null,
        kind,
        uploadedBy ?? null,
        input.notes ?? null,
      ]
    );
    return res.rows[0]!;
  }

  async update(
    companyId: string,
    orderId: string,
    attachmentId: string,
    input: UpdateAttachmentInput
  ): Promise<AttachmentRow> {
    await this.assertOrderInCompany(companyId, orderId);
    if (input.original_name === undefined) {
      throw new BadRequestException("No fields to update.");
    }
    const res = await this.databaseService.query<AttachmentRow>(
      `UPDATE order_attachments
          SET original_name = $4
        WHERE attachment_id = $1 AND order_id = $2 AND company_id = $3
        RETURNING attachment_id, company_id, order_id, file_url, original_name,
                  mime_type, size_bytes, kind, uploaded_at, uploaded_by, notes`,
      [attachmentId, orderId, companyId, input.original_name]
    );
    if (res.rowCount === 0) {
      throw new NotFoundException("Attachment not found.");
    }
    return res.rows[0]!;
  }

  async remove(companyId: string, orderId: string, attachmentId: string): Promise<void> {
    await this.assertOrderInCompany(companyId, orderId);
    const res = await this.databaseService.query(
      `DELETE FROM order_attachments
        WHERE attachment_id = $1 AND order_id = $2 AND company_id = $3`,
      [attachmentId, orderId, companyId]
    );
    if (res.rowCount === 0) {
      throw new NotFoundException("Attachment not found.");
    }
  }

  /** Cheap heuristic — file extension + mime type → bucket. */
  private inferKind(originalName: string, mimeType: string | null | undefined): AttachmentKind {
    const ext = originalName.toLowerCase().split(".").pop() ?? "";
    if (ext === "stl" || ext === "3mf") return "stl";
    if (ext === "pdf" || mimeType === "application/pdf") return "pdf";
    if (
      ["jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "svg"].includes(ext) ||
      (mimeType ?? "").startsWith("image/")
    ) return "image";
    if (["doc", "docx", "txt", "rtf", "md", "odt", "xls", "xlsx", "csv", "ppt", "pptx"].includes(ext)) {
      return "document";
    }
    if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return "archive";
    return "other";
  }
}
