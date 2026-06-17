import { BadRequestException, Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";

// Simple mode treats both resin technologies as one family — assigning an SLA
// part to an MSLA printer (or vice-versa) is fine; only cross-family is
// physically impossible and gets blocked.
function techFamily(tech: string): string {
  const t = tech.trim().toUpperCase();
  if (t === "SLA" || t === "MSLA") return "RESIN";
  return t; // FDM, SLS, …
}

@Injectable()
export class SimpleJobsService {
  constructor(private readonly db: DatabaseService) {}

  // Pieces for orders that live in the company's CURRENT mode — so Simple only
  // ever sees Simple work (and vice-versa), reversibly. Shape matches the
  // JobRow the Advanced queue returns, so the grid is interchangeable.
  async listQueue(companyId: string) {
    const result = await this.db.query(
      `
        SELECT
          op.piece_id,
          op.order_id,
          o.order_number AS order_reference,
          op.piece_name,
          op.status,
          op.assigned_printer_id,
          CASE
            WHEN pi.printer_id IS NOT NULL
              THEN NULLIF(TRIM(CONCAT_WS(' ', pi.brand, pi.model)), '')
            ELSE NULL
          END AS assigned_printer_label,
          op.required_print_technology,
          op.required_filament_material,
          op.required_color,
          op.slicer_filament_used_grams::double precision AS slicer_filament_used_grams,
          CASE
            WHEN c.customer_type = 'b2b' THEN c.business_name
            ELSE concat_ws(' ', c.first_name, c.last_name)
          END AS customer_name
        FROM order_pieces op
        INNER JOIN orders o
          ON o.order_id = op.order_id
        INNER JOIN customers c
          ON c.customer_id = o.customer_id
        LEFT JOIN printer_instances pi
          ON pi.printer_id = op.assigned_printer_id
        WHERE op.company_id = $1
          AND o.operation_mode = (SELECT operation_mode FROM companies WHERE company_id = $1)
        ORDER BY LOWER(op.piece_name) ASC, op.created_at ASC
      `,
      [companyId]
    );
    return result.rows;
  }

  // Soft bulk-assign to a printer: no nozzle, no time, no scheduling. The only
  // hard block is a print-technology FAMILY mismatch (FDM ⇄ resin ⇄ SLS) — the
  // physically-impossible case. Everything else (nozzle, multicolor, material)
  // is the operator's call. Incompatible pieces are skipped and reported, not
  // thrown, so the rest still assign.
  async assign(companyId: string, pieceIds: string[], printerId: string) {
    const printerResult = await this.db.query<{ print_technology: string | null }>(
      `
        SELECT COALESCE(pr.print_technology, pi.print_technology) AS print_technology
        FROM printer_instances pi
        LEFT JOIN printer_reference pr
          ON pr.printer_ref_id = pi.printer_ref_id
        WHERE pi.company_id = $1
          AND pi.printer_id = $2
      `,
      [companyId, printerId]
    );
    const printer = printerResult.rows[0];
    if (!printer) {
      throw new BadRequestException("Printer does not exist for this company.");
    }
    const printerFamily = printer.print_technology ? techFamily(printer.print_technology) : null;

    const pieceResult = await this.db.query<{
      piece_id: string;
      piece_name: string;
      required_print_technology: string | null;
      status: string;
    }>(
      `
        SELECT piece_id, piece_name, required_print_technology, status
        FROM order_pieces
        WHERE company_id = $1
          AND piece_id = ANY($2::uuid[])
      `,
      [companyId, pieceIds]
    );

    const skipped: { piece_id: string; piece_name: string; reason: string }[] = [];
    const assignable: string[] = [];
    for (const piece of pieceResult.rows) {
      if (piece.status === "printing" || piece.status === "done") {
        skipped.push({ piece_id: piece.piece_id, piece_name: piece.piece_name, reason: "already in production" });
        continue;
      }
      if (
        piece.required_print_technology &&
        printerFamily &&
        techFamily(piece.required_print_technology) !== printerFamily
      ) {
        skipped.push({
          piece_id: piece.piece_id,
          piece_name: piece.piece_name,
          reason: `needs ${piece.required_print_technology}, printer is ${printer.print_technology}`,
        });
        continue;
      }
      assignable.push(piece.piece_id);
    }

    if (assignable.length > 0) {
      await this.db.query(
        `
          UPDATE order_pieces
          SET assigned_printer_id = $3
          WHERE company_id = $1
            AND piece_id = ANY($2::uuid[])
        `,
        [companyId, assignable, printerId]
      );
    }

    return { assigned: assignable.length, skipped };
  }
}
