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
          op.cost,
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

  // Soft bulk-assign to a printer: no time, no scheduling. The only hard block
  // is a print-technology FAMILY mismatch (FDM ⇄ resin ⇄ SLS) — the
  // physically-impossible case. Everything else (multicolor, material) is the
  // operator's call. Incompatible pieces are skipped and reported, not thrown,
  // so the rest still assign.
  //
  // Nozzle: each piece is stamped with the nozzle matching ITS OWN
  // required diameter + material — not a single nozzle shared across the whole
  // batch. So a bulk assign of (hardened-steel 0.4 / brass 0.5 / stainless 0.6)
  // lands each piece on its correct nozzle, which is what makes the per-nozzle
  // timeline read correctly afterwards. `nozzleIds` carries the operator's
  // explicit picks (one per requirement from the bulk picker); `nozzleId` is the
  // legacy single-pick. Either is matched per piece; anything unmatched falls
  // back to an auto-resolved compatible nozzle, then the printer default.
  async assign(
    companyId: string,
    pieceIds: string[],
    printerId: string,
    nozzleId?: string,
    nozzleIds?: string[]
  ) {
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

    // Every nozzle compatible with this printer, with spec + stock state.
    // Pre-sorted available-first then smallest-diameter so the first match is
    // the sensible default / auto-pick. Used to (a) validate explicit picks and
    // (b) resolve a per-piece nozzle below. May be empty for printers with no
    // nozzle concept (e.g. resin) — then pieces keep whatever nozzle they have.
    const printerNozzles = await this.db.query<{
      nozzle_asset_id: string;
      nozzle_diameter_mm: number | null;
      nozzle_material: string | null;
      nozzle_status: string;
    }>(
      `
        SELECT pnc.nozzle_asset_id,
               ai.nozzle_diameter_mm,
               ai.nozzle_material,
               COALESCE(asto.status, 'available') AS nozzle_status
        FROM printer_nozzle_compatibility pnc
        JOIN asset_instances ai ON ai.asset_id = pnc.nozzle_asset_id
        LEFT JOIN asset_stock asto ON asto.asset_id = pnc.nozzle_asset_id
        WHERE pnc.company_id = $1 AND pnc.printer_id = $2
        ORDER BY (COALESCE(asto.status, 'available') = 'available') DESC,
                 ai.nozzle_diameter_mm ASC NULLS LAST
      `,
      [companyId, printerId]
    );
    const compatById = new Map(printerNozzles.rows.map((n) => [n.nozzle_asset_id, n]));
    const defaultNozzleId = printerNozzles.rows[0]?.nozzle_asset_id ?? null;

    // The operator's explicit picks (bulk: one per requirement). De-duped.
    // Every pick must be compatible with the chosen printer.
    const chosenIds = Array.from(new Set([...(nozzleIds ?? []), ...(nozzleId ? [nozzleId] : [])]));
    for (const id of chosenIds) {
      if (!compatById.has(id)) {
        throw new BadRequestException("Selected nozzle is not compatible with the selected printer.");
      }
    }

    // A nozzle satisfies a requirement when its diameter matches (when the piece
    // states one) and its material matches (when both state one — a material-less
    // nozzle is treated as a wildcard, mirroring the Advanced filter).
    const nozzleMatches = (
      n: { nozzle_diameter_mm: number | null; nozzle_material: string | null },
      diaReq: number | null,
      matReq: string | null
    ): boolean => {
      if (diaReq != null && Number(n.nozzle_diameter_mm) !== Number(diaReq)) return false;
      if (matReq && n.nozzle_material && n.nozzle_material.toLowerCase() !== matReq.toLowerCase()) return false;
      return true;
    };
    // Best nozzle for one piece: an explicit pick that fits → any compatible
    // nozzle that fits (available-first via the query order) → printer default.
    const resolveNozzleFor = (dia: number | null, mat: string | null): string | null => {
      const picked = chosenIds.find((id) => {
        const n = compatById.get(id);
        return n ? nozzleMatches(n, dia, mat) : false;
      });
      if (picked) return picked;
      const auto = printerNozzles.rows.find((n) => nozzleMatches(n, dia, mat));
      return auto?.nozzle_asset_id ?? defaultNozzleId;
    };

    const pieceResult = await this.db.query<{
      piece_id: string;
      piece_name: string;
      required_print_technology: string | null;
      required_nozzle_diameter_mm: number | null;
      required_nozzle_material: string | null;
      status: string;
    }>(
      `
        SELECT piece_id, piece_name, required_print_technology,
               required_nozzle_diameter_mm, required_nozzle_material, status
        FROM order_pieces
        WHERE company_id = $1
          AND piece_id = ANY($2::uuid[])
      `,
      [companyId, pieceIds]
    );

    const skipped: { piece_id: string; piece_name: string; reason: string }[] = [];
    // Group assignable pieces by the nozzle they resolve to so each distinct
    // nozzle is a single UPDATE (key null = no nozzle resolved → keep existing).
    const byNozzle = new Map<string | null, string[]>();
    let assignedCount = 0;
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
      const nozzle = resolveNozzleFor(
        piece.required_nozzle_diameter_mm,
        piece.required_nozzle_material
      );
      const arr = byNozzle.get(nozzle) ?? [];
      arr.push(piece.piece_id);
      byNozzle.set(nozzle, arr);
      assignedCount++;
    }

    // One UPDATE per resolved nozzle. Mark the pieces 'assigned' (so the queue
    // shows it and the Schedule button unlocks) and stamp the per-piece nozzle so
    // the schedule wizard has everything it needs. COALESCE keeps any nozzle
    // already on the piece when none could be resolved (printer has no nozzle).
    for (const [nozzle, ids] of byNozzle) {
      if (ids.length === 0) continue;
      await this.db.query(
        `
          UPDATE order_pieces
          SET assigned_printer_id = $3,
              assigned_nozzle_asset_id = COALESCE($4::uuid, assigned_nozzle_asset_id),
              -- A fresh assignment starts with NO slicer file. Pending pieces can
              -- still carry a stale slicer_file_url (a prior unassign keeps it),
              -- which would make the piece look already-schedulable with last
              -- session's g-code. Clear it so a g-code is only ever present once
              -- it's been explicitly dropped/attached for THIS assignment.
              slicer_file_url            = NULL,
              slicer_file_uploaded_at    = NULL,
              slicer_print_time_minutes  = NULL,
              slicer_filament_used_grams = NULL,
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
        [companyId, ids, printerId, nozzle]
      );
    }

    return { assigned: assignedCount, skipped };
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

  // Bulk-unassign: for every piece on the selected printers whose status is
  // BELOW printing (assigned / ready / scheduled), drop the printer + nozzle,
  // clear any schedule window + the slicer file, release reserved spools, and
  // return it to 'pending'. Printing/done/failed/cancelled pieces are left
  // untouched. Clearing the slicer is deliberate: a re-assigned piece must start
  // clean rather than resurrect a previous session's g-code.
  async bulkUnassign(companyId: string, printerIds: string[]) {
    let unassigned = 0;
    await this.db.transaction(async (client) => {
      const found = await client.query<{ piece_id: string }>(
        `
          SELECT piece_id
          FROM order_pieces
          WHERE company_id = $1
            AND assigned_printer_id = ANY($2::uuid[])
            AND status IN ('assigned', 'ready', 'scheduled')
        `,
        [companyId, printerIds]
      );
      const pieceIds = found.rows.map((r) => r.piece_id);
      if (pieceIds.length === 0) return;

      // Releasing the reservations fires the reserved-grams recalc trigger.
      await client.query(
        `DELETE FROM order_piece_spools WHERE company_id = $1 AND piece_id = ANY($2::uuid[])`,
        [companyId, pieceIds]
      );
      await client.query(
        `
          UPDATE order_pieces
          SET assigned_printer_id        = NULL,
              assigned_nozzle_asset_id   = NULL,
              scheduled_start_at         = NULL,
              scheduled_end_at           = NULL,
              scheduled_at               = NULL,
              slicer_file_url            = NULL,
              slicer_file_uploaded_at    = NULL,
              slicer_print_time_minutes  = NULL,
              slicer_filament_used_grams = NULL,
              status                     = 'pending'
          WHERE company_id = $1 AND piece_id = ANY($2::uuid[])
        `,
        [companyId, pieceIds]
      );
      unassigned = pieceIds.length;
    });
    return { unassigned };
  }

  // Informational printer availability for the assign picker — every printer in
  // the fleet (no filtering), each with: when it next goes idle (end of the
  // block running now, else now), and how many free minutes remain in the
  // chosen window. Pure wall-clock math against the scheduled/printing blocks;
  // no constraints, no optimization.
  async printerAvailability(
    companyId: string,
    horizon: "day" | "week" | "month" | "deadline",
    deadlineIso?: string,
    pieceIds?: string[]
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

    // Combined requirements across the selected pieces. The picker must only
    // surface printers compatible with EVERY one of them.
    let requireMulticolor = false;
    const techFamilies = new Set<string>();
    // Distinct NOZZLE requirements across the selection. A single piece yields
    // one (or zero, if it states no nozzle); a bulk selection of three pieces
    // needing three different nozzles yields three — and the picker then asks
    // the operator to pick a nozzle for each. Keyed by diameter+material so the
    // same need across pieces collapses to one requirement (with a count).
    const nozzleReq = new Map<string, { key: string; diameter_mm: number | null; material: string | null; label: string; piece_count: number }>();
    const reqKey = (dia: number | null, mat: string | null) =>
      `${dia != null ? Number(dia) : ""}|${(mat ?? "").trim().toLowerCase()}`;
    if (pieceIds && pieceIds.length > 0) {
      const reqRes = await this.db.query<{
        required_print_technology: string | null;
        required_multicolor_capable: boolean | null;
        requires_multicolor: boolean | null;
        required_nozzle_diameter_mm: number | null;
        required_nozzle_material: string | null;
      }>(
        `
          SELECT required_print_technology, required_multicolor_capable, requires_multicolor,
                 required_nozzle_diameter_mm, required_nozzle_material
          FROM order_pieces
          WHERE company_id = $1 AND piece_id = ANY($2::uuid[])
        `,
        [companyId, pieceIds]
      );
      for (const r of reqRes.rows) {
        if (r.required_print_technology) techFamilies.add(techFamily(r.required_print_technology));
        if (r.required_multicolor_capable || r.requires_multicolor) requireMulticolor = true;
        // Only pieces that actually state a nozzle need constrain the picker.
        const dia = r.required_nozzle_diameter_mm != null ? Number(r.required_nozzle_diameter_mm) : null;
        const mat = r.required_nozzle_material;
        if (dia == null && !mat) continue;
        const key = reqKey(dia, mat);
        const existing = nozzleReq.get(key);
        if (existing) existing.piece_count += 1;
        else
          nozzleReq.set(key, {
            key,
            diameter_mm: dia,
            material: mat,
            label: [dia != null ? `${dia}mm` : null, mat].filter(Boolean).join(" ") || "Any nozzle",
            piece_count: 1,
          });
      }
    }
    const requirements = Array.from(nozzleReq.values()).sort(
      (a, b) => (a.diameter_mm ?? 0) - (b.diameter_mm ?? 0) || a.label.localeCompare(b.label)
    );
    const requirementKeys = requirements.map((r) => r.key);
    // Does a nozzle satisfy a requirement? Diameter must match when stated;
    // material must match when both state one (a material-less nozzle is a
    // wildcard) — same soft rule the Advanced filter uses.
    const nozzleSatisfies = (
      n: { nozzle_diameter_mm: number | null; nozzle_material: string | null },
      req: { diameter_mm: number | null; material: string | null }
    ): boolean => {
      if (req.diameter_mm != null && Number(n.nozzle_diameter_mm) !== Number(req.diameter_mm)) return false;
      if (req.material && n.nozzle_material && n.nozzle_material.toLowerCase() !== req.material.toLowerCase()) return false;
      return true;
    };
    // The selection spans more than one technology family (e.g. an FDM piece and
    // a resin piece) — no single printer can run them all.
    if (techFamilies.size > 1) {
      return { window_end: windowEnd.toISOString(), printers: [] };
    }
    const requiredFamily = techFamilies.size === 1 ? [...techFamilies][0] : null;

    // $1 = company, $2 = window end. Compatibility filters add params after.
    const params: unknown[] = [companyId, windowEnd.toISOString()];
    const filters: string[] = [
      "pi.company_id = $1",
      // Offline / under-maintenance printers are omitted.
      "COALESCE(ps.is_offline, false) = false",
      "COALESCE(ps.is_under_maintenance, false) = false",
    ];
    if (requiredFamily) {
      params.push(requiredFamily);
      filters.push(
        `CASE WHEN COALESCE(pr.print_technology, pi.print_technology) IN ('SLA','MSLA')
              THEN 'RESIN'
              ELSE COALESCE(pr.print_technology, pi.print_technology) END = $${params.length}`
      );
    }
    if (requireMulticolor) {
      filters.push("COALESCE(pr.is_multicolor, pi.is_multicolor) = true");
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
        INNER JOIN printer_stock ps
          ON ps.printer_id = pi.printer_id
        LEFT JOIN printer_reference pr
          ON pr.printer_ref_id = pi.printer_ref_id
        LEFT JOIN order_pieces op
          ON op.assigned_printer_id = pi.printer_id
          AND op.company_id = pi.company_id
          AND op.status IN ('scheduled', 'printing')
          AND op.scheduled_start_at IS NOT NULL
          AND op.scheduled_end_at IS NOT NULL
        WHERE ${filters.join(" AND ")}
        GROUP BY pi.printer_id, pi.brand, pi.model
        ORDER BY pi.brand, pi.model
      `,
      params
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
    type NozzleOut = {
      nozzle_asset_id: string;
      nozzle_diameter_mm: number | null;
      nozzle_material: string | null;
      nozzle_status: string;
      // Requirement keys this nozzle satisfies (empty when there are no nozzle
      // requirements — single un-constrained piece, or none selected).
      satisfies: string[];
    };
    const nozzlesByPrinter = new Map<string, NozzleOut[]>();
    for (const n of nozzlesResult.rows) {
      const arr = nozzlesByPrinter.get(n.printer_id) ?? [];
      arr.push({
        nozzle_asset_id: n.nozzle_asset_id,
        nozzle_diameter_mm: n.nozzle_diameter_mm,
        nozzle_material: n.nozzle_material,
        nozzle_status: n.nozzle_status,
        satisfies: requirements.filter((req) => nozzleSatisfies(n, req)).map((req) => req.key),
      });
      nozzlesByPrinter.set(n.printer_id, arr);
    }

    const windowMinutes = (windowEnd.getTime() - now.getTime()) / 60000;
    const printers = result.rows.map((r) => {
      const busy = Number(r.busy_minutes) || 0;
      const nozzles = nozzlesByPrinter.get(r.printer_id) ?? [];
      // Which requirements this printer can satisfy (has ≥1 compatible nozzle),
      // and the subset whose matching nozzle is actually AVAILABLE right now.
      const satisfiedKeys = new Set<string>();
      const availableKeys = new Set<string>();
      for (const n of nozzles) {
        for (const k of n.satisfies) {
          satisfiedKeys.add(k);
          if (n.nozzle_status === "available") availableKeys.add(k);
        }
      }
      return {
        printer_id: r.printer_id,
        brand: r.brand,
        model: r.model,
        // null = idle now; otherwise when the current block ends.
        next_idle_at: r.running_until,
        free_minutes: Math.max(0, Math.round(windowMinutes - busy)),
        nozzles,
        satisfied_keys: [...satisfiedKeys],
        // Compatible with every needed nozzle; "available" further requires the
        // matching nozzle be in stock. Both feed the picker — covers_all is the
        // soft default surface, available is the gold-star.
        covers_all: requirementKeys.every((k) => satisfiedKeys.has(k)),
        covers_all_available: requirementKeys.every((k) => availableKeys.has(k)),
      };
    });
    // Surface the fullest-coverage printers first (covered+available → covered →
    // partial), preserving the SQL brand/model order within each tier. Soft, not
    // a hard filter — the picker can still reveal partial-coverage printers.
    const tier = (p: { covers_all: boolean; covers_all_available: boolean }) =>
      p.covers_all_available ? 0 : p.covers_all ? 1 : 2;
    printers.sort((a, b) => tier(a) - tier(b));
    return {
      window_end: windowEnd.toISOString(),
      requirements,
      printers,
    };
  }
}
