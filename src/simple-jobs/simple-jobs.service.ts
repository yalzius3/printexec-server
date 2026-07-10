import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { JobsService } from "../jobs/jobs.service";
import { BedsService } from "../beds/beds.service";
import {
  propagateSlicerMetaToDuplicatesTx,
  quoteAssumedMeta,
  recomputeOrderStatusTx,
  releasePrinterForPieceTx,
} from "../common/cascade";

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
  constructor(
    private readonly db: DatabaseService,
    private readonly jobsService: JobsService,
    private readonly bedsService: BedsService
  ) {}

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
        LEFT JOIN customers c
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
      requires_multicolor: boolean | null;
      cost_inputs: { grams?: string[]; time?: string; failure?: string } | null;
    }>(
      `
        SELECT piece_id, piece_name, required_print_technology,
               required_nozzle_diameter_mm, required_nozzle_material, status,
               requires_multicolor, cost_inputs
        FROM order_pieces
        WHERE company_id = $1
          AND piece_id = ANY($2::uuid[])
      `,
      [companyId, pieceIds]
    );

    const skipped: { piece_id: string; piece_name: string; reason: string }[] = [];
    // Group assignable pieces by (nozzle, assumed time, assumed grams) so each
    // distinct combination is a single UPDATE (nozzle null = none resolved →
    // keep existing).
    type SeedGroup = { nozzle: string | null; minutes: number | null; grams: number | null; ids: string[] };
    const groups = new Map<string, SeedGroup>();
    // Multicolor pieces whose quote grams can seed the per-slot demand.
    const slotSeeds: { piece_id: string; grams: number[] }[] = [];
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
      // Seed the schedulable metadata from the piece's QUOTE (the time + grams
      // the operator entered while costing it in the Orders page). These are
      // assumed values — a later g-code drop or manual edit overrides them —
      // but they let a quoted piece land 'ready' in this single click instead
      // of parking at 'assigned' until someone re-types numbers that already
      // exist. Pieces with no quote keep the old NULL wipe.
      const assumed = quoteAssumedMeta(piece.cost_inputs);
      const key = `${nozzle ?? ""}|${assumed.minutes ?? ""}|${assumed.grams ?? ""}`;
      let g = groups.get(key);
      if (!g) {
        g = { nozzle, minutes: assumed.minutes, grams: assumed.grams, ids: [] };
        groups.set(key, g);
      }
      g.ids.push(piece.piece_id);
      if (piece.requires_multicolor && piece.cost_inputs?.grams?.length) {
        const slotGrams = piece.cost_inputs.grams.map((v) => Number(v));
        if (slotGrams.every((n) => Number.isFinite(n) && n > 0)) {
          slotSeeds.push({ piece_id: piece.piece_id, grams: slotGrams });
        }
      }
      assignedCount++;
    }

    // One UPDATE per (nozzle, seed) group. Mark the pieces 'assigned' — or
    // straight to 'ready' when the quote supplied both numbers — and stamp the
    // per-piece nozzle so the schedule wizard has everything it needs. COALESCE
    // keeps any nozzle already on the piece when none could be resolved
    // (printer has no nozzle). The slicer FILE is still cleared: a fresh
    // assignment must never resurrect a previous session's g-code.
    for (const g of groups.values()) {
      if (g.ids.length === 0) continue;
      await this.db.query(
        `
          UPDATE order_pieces
          SET assigned_printer_id = $3,
              assigned_nozzle_asset_id = COALESCE($4::uuid, assigned_nozzle_asset_id),
              slicer_file_url            = NULL,
              slicer_file_uploaded_at    = NULL,
              slicer_print_time_minutes  = $5,
              slicer_filament_used_grams = $6,
              status = CASE
                -- 'ready' needs (printer, nozzle, time, grams) per
                -- chk_ready_requires_core_data; 'assigned' needs printer +
                -- nozzle. If no nozzle could be resolved, leave the status
                -- as-is rather than risk an inconsistent 'assigned'.
                WHEN COALESCE($4::uuid, assigned_nozzle_asset_id) IS NOT NULL
                 AND $5::int IS NOT NULL AND $6::numeric IS NOT NULL THEN 'ready'
                WHEN COALESCE($4::uuid, assigned_nozzle_asset_id) IS NOT NULL THEN 'assigned'
                ELSE status
              END
          WHERE company_id = $1
            AND piece_id = ANY($2::uuid[])
        `,
        [companyId, g.ids, printerId, g.nozzle, g.minutes, g.grams]
      );
    }

    // Multicolor: mirror the quote's per-slot grams into the color slots (only
    // where still unset, and only when the quote has one figure per slot) so
    // the spool planner sees the same assumed demand.
    for (const seed of slotSeeds) {
      const slotCount = await this.db.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM order_piece_color_slots WHERE company_id = $1 AND piece_id = $2`,
        [companyId, seed.piece_id]
      );
      if (Number(slotCount.rows[0]?.n) !== seed.grams.length) continue;
      for (let i = 0; i < seed.grams.length; i++) {
        await this.db.query(
          `UPDATE order_piece_color_slots cs
              SET slicer_grams = $3
             FROM (
               SELECT color_slot_id, ROW_NUMBER() OVER (ORDER BY sequence_order) AS rn
                 FROM order_piece_color_slots
                WHERE company_id = $1 AND piece_id = $2
             ) ordered
            WHERE cs.color_slot_id = ordered.color_slot_id
              AND ordered.rn = $4
              AND cs.slicer_grams IS NULL`,
          [companyId, seed.piece_id, seed.grams[i], i + 1]
        );
      }
    }

    // The picker chains straight into scheduling for pieces that are already
    // 'ready' (quote-seeded) — report which ones those are.
    const readyRes = await this.db.query<{ piece_id: string }>(
      `SELECT piece_id FROM order_pieces
        WHERE company_id = $1 AND piece_id = ANY($2::uuid[]) AND status = 'ready'`,
      [companyId, pieceIds]
    );

    return {
      assigned: assignedCount,
      skipped,
      ready_ids: readyRes.rows.map((r) => r.piece_id),
    };
  }

  // Bulk g-code drop: attach a slicer file (+ parsed time/grams) to each
  // already-assigned piece in one shot, flipping them to 'ready' when the
  // metadata is present. Pieces that are in production, or that don't yet have a
  // printer + nozzle, are skipped and reported. 'ready' requires (printer,
  // nozzle, slicer time, filament grams) per chk_ready_requires_core_data — so
  // a drop whose parse yielded no time/grams lands the piece at 'assigned'.
  async attachSlicer(
    companyId: string,
    items: {
      piece_id: string;
      // null in headers-only mode: the text g-code was parsed locally and never
      // uploaded, so there's no stored file — just the metadata below.
      slicer_file_url: string | null;
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
              -- Keep the uploaded-at stamp consistent with the file's presence:
              -- headers-only attaches (null URL) leave it null.
              slicer_file_uploaded_at    = CASE WHEN $3::text IS NOT NULL THEN now() ELSE NULL END,
              slicer_print_time_minutes  = COALESCE($4, slicer_print_time_minutes),
              slicer_filament_used_grams = COALESCE($5, slicer_filament_used_grams),
              status                     = CASE
                WHEN COALESCE($4, slicer_print_time_minutes) IS NOT NULL
                 AND COALESCE($5, slicer_filament_used_grams) IS NOT NULL THEN 'ready'
                ELSE 'assigned'
              END
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

    // Literal duplicates of the updated pieces (same order/name/spec, still
    // missing metadata) inherit the time/grams — one drop covers the whole run.
    const propagated = new Set<string>();
    for (const id of updated) {
      for (const dupId of await propagateSlicerMetaToDuplicatesTx(this.db, companyId, id)) {
        propagated.add(dupId);
      }
    }

    return { updated: updated.length, updated_ids: updated, skipped, propagated_ids: [...propagated] };
  }

  // Bulk-unassign: for the targeted pieces — selected individually and/or as
  // "everything on these printers" — whose status is BELOW printing
  // (assigned / ready / scheduled), drop the printer + nozzle, clear any
  // schedule window + the slicer file, release reserved spools, and return
  // them to 'pending'. Printing/done/failed/cancelled pieces are left
  // untouched. Clearing the slicer is deliberate: a re-assigned piece must start
  // clean rather than resurrect a previous session's g-code.
  async bulkUnassign(companyId: string, printerIds: string[], explicitPieceIds: string[] = []) {
    let unassigned = 0;
    await this.db.transaction(async (client) => {
      const found = await client.query<{ piece_id: string }>(
        `
          SELECT piece_id
          FROM order_pieces
          WHERE company_id = $1
            AND assigned_printer_id IS NOT NULL
            AND status IN ('assigned', 'ready', 'scheduled')
            AND (
              assigned_printer_id = ANY($2::uuid[])
              OR piece_id = ANY($3::uuid[])
            )
        `,
        [companyId, printerIds, explicitPieceIds]
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

  // ──────────────────────────────────────────────────────────────────
  // Mark a print FAILED (Simple mode).
  //
  // The operator stopped a print that went wrong, weighed the wasted filament,
  // and wants the piece back in the queue to try again. Unlike the Advanced
  // complete({outcome:'failed'}) — which leaves the piece in a terminal 'failed'
  // status consuming the full *planned* grams — this records the operator's
  // MEASURED waste per spool and re-queues the piece to either 'assigned' (keep
  // its printer/nozzle, re-drop the g-code) or 'pending' (a clean slate).
  //
  // Applies to a piece that's 'printing' OR already 'done' (the operator
  // realised after the fact it had actually failed). For a 'done' piece the
  // planned grams were already deducted from the spool at completion, so we
  // first restore them and then deduct the measured waste — the spool ends in
  // the same place as if the piece had been failed straight from 'printing'.
  //
  // `spoolWaste` carries one grams figure per reserved spool (multicolour
  // pieces reserve several). Spools the operator left out default to 0 waste.
  // ──────────────────────────────────────────────────────────────────
  async markFailed(
    companyId: string,
    pieceId: string,
    requeueTo: "assigned" | "pending",
    spoolWaste: { spool_asset_id: string; grams: number }[]
  ) {
    const pieceRes = await this.db.query<{
      piece_id: string;
      order_id: string;
      order_number: string;
      piece_name: string;
      status: string;
      assigned_printer_id: string | null;
      bed_id: string | null;
    }>(
      `
        SELECT op.piece_id, op.order_id, o.order_number, op.piece_name,
               op.status, op.assigned_printer_id, op.bed_id
          FROM order_pieces op
          JOIN orders o ON o.order_id = op.order_id AND o.company_id = op.company_id
         WHERE op.company_id = $1 AND op.piece_id = $2
      `,
      [companyId, pieceId]
    );
    const piece = pieceRes.rows[0];
    if (!piece) {
      throw new NotFoundException("Piece not found.");
    }
    if (piece.status !== "printing" && piece.status !== "done") {
      throw new ConflictException(
        `Only a printing or completed piece can be marked failed (current: '${piece.status}').`
      );
    }
    if (piece.bed_id) {
      throw new BadRequestException(
        "This piece is part of a bed — mark the bed failed from the Advanced workspace instead."
      );
    }
    if (requeueTo === "assigned" && !piece.assigned_printer_id) {
      throw new BadRequestException(
        "This piece has no assigned printer to return to — send it back to pending instead."
      );
    }

    // Sum the operator's waste per spool (a spool can only appear once per piece
    // via uq_piece_spool_asset, but fold defensively just in case).
    const wasteBySpool = new Map<string, number>();
    for (const w of spoolWaste) {
      wasteBySpool.set(w.spool_asset_id, (wasteBySpool.get(w.spool_asset_id) ?? 0) + w.grams);
    }
    // A 'done' piece already had its planned grams pulled from remaining at
    // completion; restore them so the net deduction equals the measured waste.
    const alreadyConsumed = piece.status === "done";

    await this.db.transaction(async (client) => {
      const reserved = await client.query<{ spool_asset_id: string; planned_grams: string | null }>(
        `SELECT spool_asset_id, planned_grams
           FROM order_piece_spools
          WHERE company_id = $1 AND piece_id = $2`,
        [companyId, pieceId]
      );
      for (const r of reserved.rows) {
        const planned = Number(r.planned_grams) || 0;
        const waste = wasteBySpool.get(r.spool_asset_id) ?? 0;
        const restore = alreadyConsumed ? planned : 0;
        // Net change to the spool's physical remaining grams. Floored at 0 by
        // GREATEST so an over-estimate can't drive a spool negative.
        const delta = restore - waste;
        await client.query(
          `
            UPDATE asset_stock
               SET remaining_grams = GREATEST(0, COALESCE(remaining_grams, 0) + $2),
                   status = CASE
                     WHEN GREATEST(0, COALESCE(remaining_grams, 0) + $2) <= 0 THEN 'empty'
                     WHEN status = 'empty' THEN 'available'
                     ELSE status
                   END
             WHERE asset_id = $1
          `,
          [r.spool_asset_id, delta]
        );
      }
      // Drop the reservation rows BEFORE flipping status. Deleting them lets the
      // reserved-grams recalc trigger release the held grams; doing it first also
      // means the trigger that fires on a 'done'→non-terminal flip finds no rows
      // to re-reserve.
      await client.query(
        `DELETE FROM order_piece_spools WHERE company_id = $1 AND piece_id = $2`,
        [companyId, pieceId]
      );
      // Free the printer this piece was holding (no-op for a 'done' piece whose
      // printer was already released at completion).
      if (piece.assigned_printer_id) {
        await releasePrinterForPieceTx(client, companyId, piece.assigned_printer_id, pieceId);
      }
      // Re-queue. Both targets clear the schedule + execution stamps and the
      // slicer file (a re-print starts clean). 'assigned' keeps the printer +
      // nozzle so the operator just re-drops the g-code; 'pending' wipes them.
      if (requeueTo === "assigned") {
        await client.query(
          `
            UPDATE order_pieces
               SET status                     = 'assigned',
                   slicer_file_url            = NULL,
                   slicer_file_uploaded_at    = NULL,
                   slicer_print_time_minutes  = NULL,
                   slicer_filament_used_grams = NULL,
                   scheduled_at               = NULL,
                   scheduled_start_at         = NULL,
                   scheduled_end_at           = NULL,
                   print_started_at           = NULL,
                   print_completed_at         = NULL,
                   actual_print_time_minutes  = NULL,
                   actual_filament_used_grams = NULL
             WHERE company_id = $1 AND piece_id = $2
          `,
          [companyId, pieceId]
        );
      } else {
        await client.query(
          `
            UPDATE order_pieces
               SET status                     = 'pending',
                   assigned_printer_id        = NULL,
                   assigned_nozzle_asset_id   = NULL,
                   slicer_file_url            = NULL,
                   slicer_file_uploaded_at    = NULL,
                   slicer_print_time_minutes  = NULL,
                   slicer_filament_used_grams = NULL,
                   scheduled_at               = NULL,
                   scheduled_start_at         = NULL,
                   scheduled_end_at           = NULL,
                   print_started_at           = NULL,
                   print_completed_at         = NULL,
                   actual_print_time_minutes  = NULL,
                   actual_filament_used_grams = NULL
             WHERE company_id = $1 AND piece_id = $2
          `,
          [companyId, pieceId]
        );
      }
      // Re-derive the order's rollup status inside the same transaction.
      await recomputeOrderStatusTx(client, companyId, piece.order_id);
    });

    const totalWaste = [...wasteBySpool.values()].reduce((sum, g) => sum + g, 0);
    await this.logFailure(
      companyId,
      piece.order_id,
      piece.order_number,
      pieceId,
      piece.piece_name,
      `Piece "${piece.piece_name}" marked failed — ${Math.round(totalWaste)}g filament wasted, returned to ${requeueTo}.`
    );

    return { piece_id: pieceId, status: requeueTo, waste_grams: totalWaste };
  }

  /** Best-effort failure log into the shared order_history feed. Mirrors the
   *  pattern in TimeStateService — a missing/failed log never blocks the action. */
  private async logFailure(
    companyId: string,
    orderId: string,
    orderNumber: string,
    pieceId: string,
    pieceName: string,
    description: string
  ): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO order_history
           (company_id, entity_type, event_type, order_id, order_number, piece_id, piece_name, description)
         VALUES ($1, 'piece', 'failed', $2, $3, $4, $5, $6)`,
        [companyId, orderId, orderNumber, pieceId, pieceName, description]
      );
    } catch { /* ignore — history is non-critical */ }
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
    pieceIds?: string[],
    bedId?: string
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
    // Bed target: requirements come from the bed row itself (single tech,
    // single nozzle spec spanning the whole plate).
    if (bedId) {
      const bedRes = await this.db.query<{
        required_print_technology: string | null;
        required_multicolor_capable: boolean | null;
        required_nozzle_diameter_mm: number | null;
        required_nozzle_material: string | null;
      }>(
        `
          SELECT required_print_technology, required_multicolor_capable,
                 required_nozzle_diameter_mm, required_nozzle_material
          FROM print_beds
          WHERE company_id = $1 AND bed_id = $2
        `,
        [companyId, bedId]
      );
      for (const r of bedRes.rows) {
        if (r.required_print_technology) techFamilies.add(techFamily(r.required_print_technology));
        if (r.required_multicolor_capable) requireMulticolor = true;
        const dia = r.required_nozzle_diameter_mm != null ? Number(r.required_nozzle_diameter_mm) : null;
        const mat = r.required_nozzle_material;
        if (dia == null && !mat) continue;
        const key = reqKey(dia, mat);
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

    // Beds occupy printers too — fold their scheduled/printing blocks into the
    // same "busy until / busy minutes" figures so a printer running a packed
    // plate doesn't read as free. Merged in JS to keep the piece query simple.
    const bedBusy = new Map<string, { running_until: string | null; busy_minutes: number }>();
    try {
      const bedBusyRes = await this.db.query<{
        printer_id: string;
        running_until: string | null;
        busy_minutes: string | number;
      }>(
        `
          SELECT
            pb.assigned_printer_id AS printer_id,
            MAX(CASE WHEN pb.scheduled_start_at <= now() AND pb.scheduled_end_at > now()
                     THEN pb.scheduled_end_at END) AS running_until,
            COALESCE(SUM(
              EXTRACT(EPOCH FROM (
                LEAST(pb.scheduled_end_at, $2::timestamptz) - GREATEST(pb.scheduled_start_at, now())
              )) / 60.0
            ) FILTER (
              WHERE pb.scheduled_end_at > now() AND pb.scheduled_start_at < $2::timestamptz
            ), 0) AS busy_minutes
          FROM print_beds pb
          WHERE pb.company_id = $1
            AND pb.assigned_printer_id IS NOT NULL
            AND pb.status IN ('scheduled', 'printing')
            AND pb.scheduled_start_at IS NOT NULL
            AND pb.scheduled_end_at IS NOT NULL
          GROUP BY pb.assigned_printer_id
        `,
        [companyId, windowEnd.toISOString()]
      );
      for (const r of bedBusyRes.rows) {
        bedBusy.set(r.printer_id, {
          running_until: r.running_until,
          busy_minutes: Number(r.busy_minutes) || 0,
        });
      }
    } catch { /* print_beds not migrated yet — piece blocks alone are correct */ }

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
      const fromBeds = bedBusy.get(r.printer_id);
      const busy = (Number(r.busy_minutes) || 0) + (fromBeds?.busy_minutes ?? 0);
      // Next idle = when the LAST currently-running block (piece or bed) ends.
      const runningUntil = [r.running_until, fromBeds?.running_until ?? null]
        .filter((v): v is string => !!v)
        .sort()
        .pop() ?? null;
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
        // null = idle now; otherwise when the current block (piece or bed) ends.
        next_idle_at: runningUntil,
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

  // ──────────────────────────────────────────────────────────
  // POST /api/simple-jobs/auto-schedule
  // One-click packing: place each ready item at the EARLIEST instant where its
  // printer AND nozzle AND every reserved spool are simultaneously free —
  // back-to-back, never overlapping any timeline. Placement math runs here
  // against one snapshot of all committed blocks; each commit still goes
  // through jobs/beds schedule() so every server guard re-validates it.
  // Pieces with no spool reservation get the auto-planned spool reserved
  // first (same fallback the manual Reserve button uses).
  // ──────────────────────────────────────────────────────────
  async autoSchedule(
    companyId: string,
    input: { items: Array<{ id: string; is_bed?: boolean | undefined }> }
  ) {
    type Interval = { s: number; e: number };
    const LEAD_MS = 4 * 60_000; // clears schedule()'s past-check + operator lead
    const HORIZON_MS = 60 * 24 * 60 * 60_000;
    const now = Date.now();

    const printerBusy = new Map<string, Interval[]>();
    const nozzleBusy = new Map<string, Interval[]>();
    const spoolBusy = new Map<string, Interval[]>();
    const push = (m: Map<string, Interval[]>, k: string | null, iv: Interval) => {
      if (!k) return;
      const arr = m.get(k) ?? [];
      arr.push(iv);
      m.set(k, arr);
    };

    // ── Snapshot every committed block (pieces + beds), bucketed per resource.
    const pieceWindow = new Map<string, Interval>();
    const pieceBlocks = await this.db.query<{
      piece_id: string; assigned_printer_id: string | null;
      assigned_nozzle_asset_id: string | null; s: string; e: string;
    }>(
      `SELECT piece_id, assigned_printer_id, assigned_nozzle_asset_id,
              scheduled_start_at::text AS s, scheduled_end_at::text AS e
         FROM order_pieces
        WHERE company_id = $1 AND status IN ('scheduled','printing')
          AND scheduled_start_at IS NOT NULL AND scheduled_end_at IS NOT NULL`,
      [companyId]
    );
    for (const r of pieceBlocks.rows) {
      const iv = { s: Date.parse(r.s), e: Date.parse(r.e) };
      pieceWindow.set(r.piece_id, iv);
      push(printerBusy, r.assigned_printer_id, iv);
      push(nozzleBusy, r.assigned_nozzle_asset_id, iv);
    }
    const bedWindow = new Map<string, Interval>();
    try {
      const bedBlocks = await this.db.query<{
        bed_id: string; assigned_printer_id: string | null;
        assigned_nozzle_asset_id: string | null; s: string; e: string;
      }>(
        `SELECT bed_id, assigned_printer_id, assigned_nozzle_asset_id,
                scheduled_start_at::text AS s, scheduled_end_at::text AS e
           FROM print_beds
          WHERE company_id = $1 AND status IN ('scheduled','printing')
            AND scheduled_start_at IS NOT NULL AND scheduled_end_at IS NOT NULL`,
        [companyId]
      );
      for (const r of bedBlocks.rows) {
        const iv = { s: Date.parse(r.s), e: Date.parse(r.e) };
        bedWindow.set(r.bed_id, iv);
        push(printerBusy, r.assigned_printer_id, iv);
        push(nozzleBusy, r.assigned_nozzle_asset_id, iv);
      }
    } catch { /* print_beds not migrated yet */ }
    // Spool reservations occupy the window of their standalone piece — or of
    // their parent BED (bed reservations anchor on a windowless child piece).
    const spoolRes = await this.db.query<{ spool_asset_id: string; piece_id: string; bed_id: string | null }>(
      `SELECT ops.spool_asset_id, ops.piece_id, op.bed_id
         FROM order_piece_spools ops
         JOIN order_pieces op ON op.piece_id = ops.piece_id
        WHERE ops.company_id = $1`,
      [companyId]
    );
    for (const r of spoolRes.rows) {
      const iv = r.bed_id ? bedWindow.get(r.bed_id) : pieceWindow.get(r.piece_id);
      if (iv) push(spoolBusy, r.spool_asset_id, iv);
    }

    // ── Load the candidates (order preserved for ties; deadline rules).
    const ids = input.items.filter((i) => !i.is_bed).map((i) => i.id);
    const bedIds = input.items.filter((i) => i.is_bed).map((i) => i.id);
    type Candidate = {
      id: string; is_bed: boolean; name: string; status: string;
      printer_id: string | null; nozzle_id: string | null;
      minutes: number | null; deadline: string | null;
    };
    const candidates: Candidate[] = [];
    if (ids.length > 0) {
      const r = await this.db.query<{
        piece_id: string; piece_name: string; status: string;
        assigned_printer_id: string | null; assigned_nozzle_asset_id: string | null;
        slicer_print_time_minutes: number | null; deadline: string | null;
      }>(
        `SELECT op.piece_id, op.piece_name, op.status, op.assigned_printer_id,
                op.assigned_nozzle_asset_id, op.slicer_print_time_minutes,
                o.deadline::text AS deadline
           FROM order_pieces op
           JOIN orders o ON o.order_id = op.order_id
          WHERE op.company_id = $1 AND op.piece_id = ANY($2::uuid[])`,
        [companyId, ids]
      );
      for (const p of r.rows) {
        candidates.push({
          id: p.piece_id, is_bed: false, name: p.piece_name, status: p.status,
          printer_id: p.assigned_printer_id, nozzle_id: p.assigned_nozzle_asset_id,
          minutes: p.slicer_print_time_minutes != null ? Number(p.slicer_print_time_minutes) : null,
          deadline: p.deadline,
        });
      }
    }
    if (bedIds.length > 0) {
      const r = await this.db.query<{
        bed_id: string; bed_name: string; status: string;
        assigned_printer_id: string | null; assigned_nozzle_asset_id: string | null;
        slicer_print_time_minutes: number | null; deadline: string | null;
      }>(
        `SELECT bed_id, bed_name, status, assigned_printer_id, assigned_nozzle_asset_id,
                slicer_print_time_minutes, effective_deadline::text AS deadline
           FROM print_beds
          WHERE company_id = $1 AND bed_id = ANY($2::uuid[])`,
        [companyId, bedIds]
      );
      for (const b of r.rows) {
        candidates.push({
          id: b.bed_id, is_bed: true, name: b.bed_name, status: b.status,
          printer_id: b.assigned_printer_id, nozzle_id: b.assigned_nozzle_asset_id,
          minutes: b.slicer_print_time_minutes != null ? Number(b.slicer_print_time_minutes) : null,
          deadline: b.deadline,
        });
      }
    }
    // Deadline-first (nulls last); ties keep the caller's queue order.
    const orderIndex = new Map(input.items.map((i, idx) => [i.id, idx]));
    candidates.sort((a, b) => {
      const da = a.deadline ? Date.parse(a.deadline) : Infinity;
      const db_ = b.deadline ? Date.parse(b.deadline) : Infinity;
      if (da !== db_) return da - db_;
      return (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0);
    });

    const placed: Array<{ id: string; is_bed: boolean; name: string; start_at: string; end_at: string }> = [];
    const skipped: Array<{ id: string; is_bed: boolean; name: string; reason: string }> = [];

    for (const c of candidates) {
      if (c.status !== "ready") {
        skipped.push({
          id: c.id, is_bed: c.is_bed, name: c.name,
          reason: c.status === "scheduled" || c.status === "printing"
            ? "already on the board"
            : `not ready yet ('${c.status}' — needs printer, nozzle and print data)`,
        });
        continue;
      }
      if (!c.printer_id || c.minutes == null || c.minutes <= 0 || (!c.is_bed && !c.nozzle_id)) {
        skipped.push({ id: c.id, is_bed: c.is_bed, name: c.name, reason: "missing printer/nozzle/print time" });
        continue;
      }

      // Ensure a physical spool is reserved (pieces): auto-plan when absent —
      // the same auto-reservation Save uses, so one click is truly enough.
      let mySpools: string[] = [];
      if (!c.is_bed) {
        const cur = await this.db.query<{ spool_asset_id: string }>(
          `SELECT spool_asset_id FROM order_piece_spools WHERE company_id = $1 AND piece_id = $2`,
          [companyId, c.id]
        );
        mySpools = cur.rows.map((r) => r.spool_asset_id);
        if (mySpools.length === 0) {
          try {
            await this.jobsService.reserveSpools(companyId, c.id, {});
            const after = await this.db.query<{ spool_asset_id: string }>(
              `SELECT spool_asset_id FROM order_piece_spools WHERE company_id = $1 AND piece_id = $2`,
              [companyId, c.id]
            );
            mySpools = after.rows.map((r) => r.spool_asset_id);
          } catch (e) {
            skipped.push({
              id: c.id, is_bed: false, name: c.name,
              reason: e instanceof Error ? e.message : "couldn't reserve a spool",
            });
            continue;
          }
        }
      } else {
        const cur = await this.db.query<{ spool_asset_id: string }>(
          `SELECT DISTINCT ops.spool_asset_id
             FROM order_piece_spools ops
             JOIN order_pieces op ON op.piece_id = ops.piece_id
            WHERE ops.company_id = $1 AND op.bed_id = $2`,
          [companyId, c.id]
        );
        mySpools = cur.rows.map((r) => r.spool_asset_id);
      }

      // Earliest instant where printer ∧ nozzle ∧ every spool are free.
      const durMs = Math.max(1, c.minutes) * 60_000;
      const busy: Interval[] = [
        ...(printerBusy.get(c.printer_id) ?? []),
        ...(c.nozzle_id ? nozzleBusy.get(c.nozzle_id) ?? [] : []),
        ...mySpools.flatMap((sid) => spoolBusy.get(sid) ?? []),
      ].sort((a, b) => a.s - b.s);
      let startMs = now + LEAD_MS;
      let moved = true;
      while (moved) {
        moved = false;
        for (const iv of busy) {
          if (startMs < iv.e && startMs + durMs > iv.s) { startMs = iv.e; moved = true; }
        }
      }
      if (startMs + durMs > now + HORIZON_MS) {
        skipped.push({ id: c.id, is_bed: c.is_bed, name: c.name, reason: "no free slot within 60 days" });
        continue;
      }

      // Commit through the guarded schedule() — never around it.
      const startIso = new Date(startMs).toISOString();
      try {
        if (c.is_bed) await this.bedsService.schedule(companyId, c.id, { start_at: startIso });
        else await this.jobsService.schedule(companyId, c.id, { start_at: startIso });
      } catch (e) {
        skipped.push({
          id: c.id, is_bed: c.is_bed, name: c.name,
          reason: e instanceof Error ? e.message : "schedule was rejected",
        });
        continue;
      }
      const iv = { s: startMs, e: startMs + durMs };
      push(printerBusy, c.printer_id, iv);
      push(nozzleBusy, c.nozzle_id, iv);
      for (const sid of mySpools) push(spoolBusy, sid, iv);
      placed.push({
        id: c.id, is_bed: c.is_bed, name: c.name,
        start_at: startIso, end_at: new Date(startMs + durMs).toISOString(),
      });
    }

    return { placed, skipped };
  }
}
