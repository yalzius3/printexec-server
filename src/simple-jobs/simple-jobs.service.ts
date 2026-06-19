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
          o.deadline AS order_deadline,
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
  async assign(companyId: string, pieceIds: string[], printerId: string, nozzleId?: string) {
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

    // Simple mode hides the nozzle decision, but scheduling (timeline conflict
    // checks) and the reused Advanced wizard both NEED a nozzle on the piece —
    // without one the schedule window opens to an empty step. So resolve a
    // sensible default here: the printer's first available compatible nozzle
    // (smallest diameter as a stable tiebreak). May be null for printers with
    // no nozzle concept (e.g. resin); in that case we leave the nozzle as-is.
    const nozzleResult = await this.db.query<{ nozzle_asset_id: string }>(
      `
        SELECT pnc.nozzle_asset_id
        FROM printer_nozzle_compatibility pnc
        JOIN asset_instances ai ON ai.asset_id = pnc.nozzle_asset_id
        LEFT JOIN asset_stock asto ON asto.asset_id = pnc.nozzle_asset_id
        WHERE pnc.company_id = $1 AND pnc.printer_id = $2
        ORDER BY (COALESCE(asto.status, 'available') = 'available') DESC,
                 ai.nozzle_diameter_mm ASC NULLS LAST
        LIMIT 1
      `,
      [companyId, printerId]
    );
    const defaultNozzleId = nozzleResult.rows[0]?.nozzle_asset_id ?? null;

    // If the operator picked a nozzle explicitly, it must be compatible with
    // the chosen printer. Otherwise fall back to the resolved default.
    let effectiveNozzleId = defaultNozzleId;
    if (nozzleId) {
      const compat = await this.db.query<{ exists: boolean }>(
        `
          SELECT EXISTS(
            SELECT 1 FROM printer_nozzle_compatibility
            WHERE company_id = $1 AND printer_id = $2 AND nozzle_asset_id = $3
          ) AS exists
        `,
        [companyId, printerId, nozzleId]
      );
      if (!compat.rows[0]?.exists) {
        throw new BadRequestException("Selected nozzle is not compatible with the selected printer.");
      }
      effectiveNozzleId = nozzleId;
    }

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
      if (piece.status === "scheduled") {
        skipped.push({ piece_id: piece.piece_id, piece_name: piece.piece_name, reason: "scheduled — unschedule it first" });
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
      // Mark the pieces 'assigned' (so the queue shows it and the Schedule
      // button unlocks) and stamp the resolved default nozzle so the schedule
      // wizard has everything it needs. COALESCE keeps any nozzle already on
      // the piece when the printer has no compatible nozzle to offer.
      await this.db.query(
        `
          UPDATE order_pieces
          SET assigned_printer_id = $3,
              assigned_nozzle_asset_id = COALESCE($4::uuid, assigned_nozzle_asset_id),
              status = CASE
                -- Flip to 'assigned' once the piece has both a printer and a
                -- nozzle (the wizard/scheduler need both). If no nozzle could be
                -- resolved, leave the status as-is rather than risk an
                -- inconsistent 'assigned' with no nozzle.
                WHEN COALESCE($4::uuid, assigned_nozzle_asset_id) IS NOT NULL THEN 'assigned'
                ELSE status
              END
          WHERE company_id = $1
            AND piece_id = ANY($2::uuid[])
        `,
        [companyId, assignable, printerId, effectiveNozzleId]
      );
    }

    return { assigned: assignable.length, skipped };
  }

  // Bulk g-code drop: attach a slicer file (+ parsed time/grams) to each
  // already-assigned piece in one shot, flipping them to 'ready'. Pieces that
  // are in production, or that don't yet have a printer + nozzle, are skipped
  // and reported. status='ready' is safe here — the piece already carries the
  // printer + nozzle, and we set the slicer file, satisfying the DB's
  // chk_ready_requires_core_data constraint.
  async attachSlicer(
    companyId: string,
    items: {
      piece_id: string;
      slicer_file_url: string;
      slicer_print_time_minutes?: number | undefined;
      slicer_filament_used_grams?: number | undefined;
    }[]
  ) {
    const ids = items.map((i) => i.piece_id);
    const rows = await this.db.query<{
      piece_id: string;
      piece_name: string;
      status: string;
      assigned_printer_id: string | null;
      assigned_nozzle_asset_id: string | null;
    }>(
      `
        SELECT piece_id, piece_name, status, assigned_printer_id, assigned_nozzle_asset_id
        FROM order_pieces
        WHERE company_id = $1 AND piece_id = ANY($2::uuid[])
      `,
      [companyId, ids]
    );
    const byId = new Map(rows.rows.map((r) => [r.piece_id, r]));

    const updated: string[] = [];
    const skipped: { piece_id: string; piece_name: string; reason: string }[] = [];
    for (const item of items) {
      const piece = byId.get(item.piece_id);
      if (!piece) {
        skipped.push({ piece_id: item.piece_id, piece_name: item.piece_id, reason: "not found" });
        continue;
      }
      if (piece.status === "printing" || piece.status === "done") {
        skipped.push({ piece_id: piece.piece_id, piece_name: piece.piece_name, reason: "already in production" });
        continue;
      }
      if (!piece.assigned_printer_id || !piece.assigned_nozzle_asset_id) {
        skipped.push({ piece_id: piece.piece_id, piece_name: piece.piece_name, reason: "assign a printer first" });
        continue;
      }
      await this.db.query(
        `
          UPDATE order_pieces
          SET slicer_file_url            = $3,
              slicer_file_uploaded_at    = now(),
              slicer_print_time_minutes  = COALESCE($4, slicer_print_time_minutes),
              slicer_filament_used_grams = COALESCE($5, slicer_filament_used_grams),
              status                     = 'ready'
          WHERE company_id = $1 AND piece_id = $2
        `,
        [
          companyId,
          item.piece_id,
          item.slicer_file_url,
          item.slicer_print_time_minutes ?? null,
          item.slicer_filament_used_grams ?? null,
        ]
      );
      updated.push(item.piece_id);
    }

    return { updated: updated.length, updated_ids: updated, skipped };
  }

  // Informational printer availability for the assign picker — every printer in
  // the fleet (no filtering), each with: when it next goes idle (end of the
  // block running now, else now), and how many free minutes remain in the
  // chosen window. Pure wall-clock math against the scheduled/printing blocks;
  // no constraints, no optimization.
  async printerAvailability(
    companyId: string,
    horizon: "day" | "week" | "month" | "deadline",
    deadlineIso?: string
  ) {
    const now = new Date();
    const dayMs = 24 * 60 * 60 * 1000;
    let windowEnd: Date;
    if (horizon === "day") windowEnd = new Date(now.getTime() + dayMs);
    else if (horizon === "month") windowEnd = new Date(now.getTime() + 30 * dayMs);
    else if (horizon === "deadline") {
      const d = deadlineIso ? new Date(deadlineIso) : null;
      windowEnd = d && !Number.isNaN(d.getTime()) && d.getTime() > now.getTime() ? d : new Date(now.getTime() + 7 * dayMs);
    } else {
      windowEnd = new Date(now.getTime() + 7 * dayMs); // week (default)
    }

    const result = await this.db.query<{
      printer_id: string;
      brand: string;
      model: string;
      running_until: string | null;
      busy_minutes: string | number;
    }>(
      `
        SELECT
          pi.printer_id,
          pi.brand,
          pi.model,
          MAX(CASE WHEN op.scheduled_start_at <= now() AND op.scheduled_end_at > now()
                   THEN op.scheduled_end_at END) AS running_until,
          COALESCE(SUM(
            EXTRACT(EPOCH FROM (
              LEAST(op.scheduled_end_at, $2::timestamptz) - GREATEST(op.scheduled_start_at, now())
            )) / 60.0
          ) FILTER (
            WHERE op.scheduled_end_at > now() AND op.scheduled_start_at < $2::timestamptz
          ), 0) AS busy_minutes
        FROM printer_instances pi
        LEFT JOIN order_pieces op
          ON op.assigned_printer_id = pi.printer_id
          AND op.company_id = pi.company_id
          AND op.status IN ('scheduled', 'printing')
          AND op.scheduled_start_at IS NOT NULL
          AND op.scheduled_end_at IS NOT NULL
        WHERE pi.company_id = $1
        GROUP BY pi.printer_id, pi.brand, pi.model
        ORDER BY pi.brand, pi.model
      `,
      [companyId, windowEnd.toISOString()]
    );

    // Compatible nozzles per printer, so the picker can let the operator choose
    // one explicitly. Ordered smallest-diameter first; available stock first.
    const nozzlesResult = await this.db.query<{
      printer_id: string;
      nozzle_asset_id: string;
      nozzle_diameter_mm: number | null;
      nozzle_material: string | null;
      nozzle_status: string;
    }>(
      `
        SELECT
          pnc.printer_id,
          pnc.nozzle_asset_id,
          ai.nozzle_diameter_mm,
          ai.nozzle_material,
          COALESCE(asto.status, 'available') AS nozzle_status
        FROM printer_nozzle_compatibility pnc
        JOIN asset_instances ai ON ai.asset_id = pnc.nozzle_asset_id
        LEFT JOIN asset_stock asto ON asto.asset_id = pnc.nozzle_asset_id
        WHERE pnc.company_id = $1
        ORDER BY (COALESCE(asto.status, 'available') = 'available') DESC,
                 ai.nozzle_diameter_mm ASC NULLS LAST
      `,
      [companyId]
    );
    const nozzlesByPrinter = new Map<
      string,
      { nozzle_asset_id: string; nozzle_diameter_mm: number | null; nozzle_material: string | null; nozzle_status: string }[]
    >();
    for (const n of nozzlesResult.rows) {
      const arr = nozzlesByPrinter.get(n.printer_id) ?? [];
      arr.push({
        nozzle_asset_id: n.nozzle_asset_id,
        nozzle_diameter_mm: n.nozzle_diameter_mm,
        nozzle_material: n.nozzle_material,
        nozzle_status: n.nozzle_status,
      });
      nozzlesByPrinter.set(n.printer_id, arr);
    }

    const windowMinutes = (windowEnd.getTime() - now.getTime()) / 60000;
    return {
      window_end: windowEnd.toISOString(),
      printers: result.rows.map((r) => {
        const busy = Number(r.busy_minutes) || 0;
        return {
          printer_id: r.printer_id,
          brand: r.brand,
          model: r.model,
          // null = idle now; otherwise when the current block ends.
          next_idle_at: r.running_until,
          free_minutes: Math.max(0, Math.round(windowMinutes - busy)),
          nozzles: nozzlesByPrinter.get(r.printer_id) ?? [],
        };
      }),
    };
  }
}
