/* ── piece-edit-lock ─────────────────────────────────────────────────────────
   Which parts of a piece's specification may still be edited, given where that
   piece is in production.

   A PURE module, deliberately. These rules decide whether an operator can
   change what a part will be printed in while machines are running, and being
   wrong in either direction is expensive: too loose and a plate prints in the
   wrong filament, too tight and a colour change costs the shop an unassign,
   a re-slice and a re-schedule. Rules like that need tests, and a Nest service
   cannot be imported by `node --test` — its constructor parameter properties
   are not erasable syntax, so type-stripping refuses the file. Same reason
   jobs/matching.ts exists as its own module.

   OrderPiecesService owns everything else about a patch — the order-level
   locks, the workflow-status guards, the printing-piece guards. This module
   answers exactly one question: is this FIELD editable at this STATUS.
   ──────────────────────────────────────────────────────────────────────────── */

/** The technology spec: what the piece is printed ON, and in what. */
export const TECH_FIELDS = [
  "required_print_technology",
  "requires_multicolor",
  "required_filament_material",
  "required_color",
  "required_nozzle_diameter_mm",
  "required_nozzle_material",
  "required_multicolor_capable",
  "stl_file_url",
  "stl_file_uploaded_at"
] as const;

/** The slicer output: the numbers a schedule and a reservation are built from. */
export const SLICER_FIELDS = [
  "slicer_file_url",
  "slicer_file_uploaded_at",
  "slicer_print_time_minutes",
  "slicer_filament_used_grams",
  "slicer_filament_used_mm",
  "slicer_support_grams",
  "slicer_layer_height_mm",
  "slicer_infill_percent",
  "slicer_wall_loops",
  "slicer_supports_enabled",
  "slicer_support_type",
  "slicer_part_weight_grams",
  "color_slots",
  "color_slot_grams",
  // Resin's counterpart of slicer_filament_used_grams — same lock, same reason:
  // once a piece is scheduled, the quantity it reserved must not move under it.
  "slicer_resin_used_ml"
] as const;

/**
 * The MATERIAL SPECIFICATION — what the piece must be printed in.
 *
 * Carved out of TECH_FIELDS because it is the one part of the spec that keeps
 * changing after a piece is prepared, and for a reason that has nothing to do
 * with the machine: the customer changes their mind about the colour. That is
 * an ordinary Tuesday in a print shop, and it used to mean unassigning the
 * piece, editing it and assigning it again — losing the printer, the nozzle and
 * the slicer numbers on the way, all to change one word.
 *
 * So these two stay editable one status longer than the rest of the tech spec:
 * through 'ready', up to but not including 'scheduled'.
 *
 * Everything else in TECH_FIELDS keeps the old lock, and deliberately:
 *   · required_print_technology — a ready piece has an assigned printer, and
 *     the printer's technology is what made it the right machine.
 *   · required_nozzle_* — likewise: the assigned nozzle was chosen to match.
 *   · requires_multicolor / required_multicolor_capable — flipping these
 *     restructures the colour slots and changes which printers can take the
 *     job at all.
 *   · stl_file_* — the slicer numbers a 'ready' piece carries were produced
 *     from a specific model; swapping the model silently invalidates them.
 */
export const MATERIAL_SPEC_FIELDS = ["required_filament_material", "required_color"] as const;

/**
 * Statuses at which the technology spec is frozen.
 *
 * 'ready' means "assigned and quantified" — a printer, a nozzle, a print time
 * and a filament weight — but NOT scheduled: nothing holds a slot on the
 * timeline. That is why the material spec can still move here.
 */
export const TECH_LOCKED_STATUSES = new Set([
  "ready",
  "scheduled",
  "printing",
  "done",
  "failed",
  "cancelled"
]);

/** Where the material spec stops being editable too. 'ready' is absent — that
 *  is the whole of the change. From 'scheduled' onward the piece is a
 *  commitment other plans have been built around. */
export const MATERIAL_SPEC_LOCKED_STATUSES = new Set([
  "scheduled",
  "printing",
  "done",
  "failed",
  "cancelled"
]);

export const SLICER_LOCKED_STATUSES = new Set([
  "scheduled",
  "printing",
  "done",
  "failed",
  "cancelled"
]);

/** Post-production order statuses (added 2026-06-26). The order has left
 *  production: like completed/cancelled they are closed to structural piece
 *  changes, and they additionally forbid tech & slicer edits regardless of the
 *  individual piece's status — "no tech edits". */
export const POST_PRODUCTION_ORDER_STATUSES = [
  "ready_for_shipping",
  "out_for_shipping",
  "returned",
  "fulfilled"
] as const;

/** Orders closed to structural piece changes (add / delete / duplicate). */
export const PIECE_CHANGE_LOCKED_ORDER_STATUSES = new Set<string>([
  "completed",
  "cancelled",
  ...POST_PRODUCTION_ORDER_STATUSES
]);

/** Orders that lock tech/slicer edits at the order level. completed/cancelled
 *  are intentionally excluded: their pieces are already done/cancelled, so the
 *  per-piece lock covers them and their behaviour is unchanged. */
export const PIECE_SPEC_LOCKED_ORDER_STATUSES = new Set<string>(POST_PRODUCTION_ORDER_STATUSES);

/** What the caller needs to know about the piece to decide. Structural, so a
 *  test can build one without a database and a service can pass its row
 *  straight in. */
export interface PieceEditContext {
  status: string;
  order_status: string;
  /** Present only once the print_beds migration has run — the column is read
   *  off `op.*` and never named in SQL, so an un-migrated deploy simply has no
   *  field here. Treated as "not on a plate", which is what it means. */
  bed_id?: string | null;
}

export interface EditRefusal {
  /** 403 for "you may not change this", 400 for "this request does not make
   *  sense here". Kept as data so the pure module never imports Nest. */
  kind: "forbidden";
  message: string;
}

/**
 * May this patch touch the fields it touches?
 *
 * Returns the refusal, or null when the edit is allowed. Order matters: the
 * order-level lock is checked first because it is the broadest statement ("this
 * order has left production"), and a message about the piece's own status would
 * be misleading there.
 */
export function pieceSpecEditRefusal(
  piece: PieceEditContext,
  patchedFields: readonly string[]
): EditRefusal | null {
  const patched = new Set(patchedFields);
  const touches = (fields: readonly string[]) => fields.some((f) => patched.has(f));

  const materialSpec = new Set<string>(MATERIAL_SPEC_FIELDS);
  // What is left of the tech spec once the material spec is taken out of it —
  // the part that describes the MACHINE, and that a ready piece's assignment
  // was chosen to satisfy.
  const hardTechFields = TECH_FIELDS.filter((f) => !materialSpec.has(f));

  if (
    PIECE_SPEC_LOCKED_ORDER_STATUSES.has(piece.order_status) &&
    touches([...TECH_FIELDS, ...SLICER_FIELDS])
  ) {
    return {
      kind: "forbidden",
      message: "Tech and slicer details cannot be edited once the order has left production."
    };
  }

  if (touches(hardTechFields) && TECH_LOCKED_STATUSES.has(piece.status)) {
    return {
      kind: "forbidden",
      message: "Tech details cannot be edited once a piece is ready for production."
    };
  }

  if (touches(MATERIAL_SPEC_FIELDS) && MATERIAL_SPEC_LOCKED_STATUSES.has(piece.status)) {
    return {
      kind: "forbidden",
      message:
        "The material and colour cannot be changed once a piece is scheduled. Unschedule it first."
    };
  }

  // A piece on a PLATE does not get the extra status of leeway.
  //
  // A plate prints as one physical arrangement in one filament — it carries its
  // own `required_filament_material`, inherited from its first piece, and its
  // spool is reserved against the PLATE, not the pieces. So a member piece
  // whose colour moved would state a requirement the plate it is sitting on
  // cannot satisfy, and nobody would find out until the print came off.
  //
  // Written as "keep the old boundary" rather than "refuse outright" on
  // purpose. A bedded piece is normally 'pending' (joining a bed resets it),
  // and editing it there works today; taking that away would be a change nobody
  // asked for. This only declines to EXTEND the window for bedded pieces — the
  // case reachable through a bed reprint, which pushes 'ready' onto its
  // children. Everything that works today still works.
  if (touches(MATERIAL_SPEC_FIELDS) && piece.bed_id && TECH_LOCKED_STATUSES.has(piece.status)) {
    return {
      kind: "forbidden",
      message:
        "This piece is on a plate, which prints as one arrangement in one filament. Change the plate's filament, or take the piece off the plate first."
    };
  }

  if (touches(SLICER_FIELDS) && SLICER_LOCKED_STATUSES.has(piece.status)) {
    return {
      kind: "forbidden",
      message: "Slicer details cannot be edited once a piece is scheduled."
    };
  }

  return null;
}
