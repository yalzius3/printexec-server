/* ════════════════════════════════════════════════════════════════
   NOZZLE POOLS — "which nozzles on this printer are the same thing?"
   ────────────────────────────────────────────────────────────────
   A workshop with ten 0.4mm brass nozzles has ten identical ways to run a
   0.4mm brass job. The operator does not know which one is fitted and does not
   care: they all print the part the same. The board, however, used to treat the
   one asset row a human happened to pick as a hard physical constraint, so a
   piece dropped at 14:00 would be shoved forward because THAT nozzle was
   committed elsewhere — while nine identical ones sat idle.

   This module is the shared ground for fixing that in two places at once:

     · JobsService.resolveNozzleForWindow — the write path. A busy nozzle is
       substituted for a free twin at commit time.
     · JobsService.printerTimeline        — the read path. The board is told
       about the whole pool so it can PLACE the chip where the operator dropped
       it, instead of dodging a conflict the server no longer has.

   Everything here is pure or a SQL string, deliberately: it lives outside
   jobs.service.ts so `node --test` can import it. jobs.service.ts declares a
   Nest service with constructor parameter properties, which Node's strip-only
   TypeScript loader refuses — importing it from a test dies with
   ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX before a single assertion runs. Same reason
   matching.ts and run-store.ts exist. Covered by test/nozzle-pool.test.ts and
   test/nozzle-pool.integration.test.ts (the latter executes the statements
   below against a real Postgres).

   The interchangeability RULE itself is not here — it is nozzleSpecOf() in
   simple-jobs/packing.ts, where the auto-packer has always kept it. One rule,
   one home; a drop and the ⚡ packer must not be able to disagree.
   ════════════════════════════════════════════════════════════════ */

/** One physical nozzle in a spec pool, with what it is already committed to. */
export interface NozzlePoolMember {
  nozzle_asset_id: string;
  label: string;
  /** The printer it is currently fitted to, when inventory records one. */
  installed_on_printer_id: string | null;
  /** Committed windows across the WHOLE fleet — a nozzle is not the printer's,
   *  it just happens to be mountable on it. `ref_id` is the piece or bed that
   *  holds it, so a board can discount a job's own block. */
  busy: Array<{ ref_id: string; start_at: string; end_at: string }>;
}

/**
 * Every nozzle on a printer that is the SAME THING as far as printing goes,
 * grouped so a board can answer "is this spec available at 14:00?" instead of
 * the much narrower "is nozzle #7 available at 14:00?".
 *
 * The board is handed the whole pool rather than a precomputed verdict because
 * the job it is asking about may itself be one of the things holding a nozzle,
 * and only the board knows which block is its own.
 */
export interface NozzlePool {
  /** nozzleSpecOf(diameter, material) — the interchangeability key. */
  spec: string;
  nozzle_diameter_mm: number | null;
  nozzle_material: string | null;
  members: NozzlePoolMember[];
}

/**
 * What the board did INSTEAD of refusing a placement: the nozzle a human picked
 * was committed elsewhere, so an identical one took its place.
 *
 * Reported all the way to the operator on purpose. Ten 0.4mm brass nozzles all
 * render as "0.4mm brass", so a switch that isn't named is a hardware change
 * nobody can act on — hence the name, the bin location, and (when the stand-in
 * is fitted to another machine) which machine to fetch it from.
 */
export interface NozzleSwitch {
  from_nozzle_asset_id: string;
  from_label: string | null;
  to_nozzle_asset_id: string;
  to_label: string;
  /** Where the stand-in is stored, when inventory records it. */
  to_location: string | null;
  /** Set ONLY when the stand-in is currently fitted to a different printer —
   *  i.e. this switch implies someone physically carrying it over. */
  moved_from_printer_id: string | null;
  moved_from_printer_label: string | null;
  /** The job holding the originally-chosen nozzle. */
  displaced_by: string | null;
}

/**
 * How a nozzle should read to the person who has to go and fit it.
 *
 * Spec alone ("0.4mm brass") is exactly what makes this feature necessary and
 * exactly what makes it unusable if repeated back — the whole point is that ten
 * of them are indistinguishable by spec. Identity first (the name someone gave
 * it, or its brand), spec second.
 */
export function nozzleIdentityLabel(n: {
  nozzle_name?: string | null;
  nozzle_brand?: string | null;
  nozzle_diameter_mm?: string | number | null;
  nozzle_material?: string | null;
  nozzle_asset_id: string;
}): string {
  const dia = n.nozzle_diameter_mm != null ? `${Number(n.nozzle_diameter_mm)}mm` : null;
  const spec = [dia, n.nozzle_material].filter(Boolean).join(" ");
  const named = n.nozzle_name?.trim() || null;
  if (named) return spec ? `${named} (${spec})` : named;
  const branded = n.nozzle_brand?.trim() || null;
  if (branded) return [branded, spec].filter(Boolean).join(" ");
  // Nothing but a spec — and the spec is exactly what does NOT tell two of
  // these apart. "Fit the 0.4mm brass one" is not an instruction in a drawer of
  // ten 0.4mm brass nozzles, so a stable short handle is appended: it is the
  // only thing left that is unique, and it matches what the Assets page shows.
  // A shop that names or locates its nozzles never sees this.
  const short = n.nozzle_asset_id.slice(0, 6);
  return spec ? `${spec} · ${short}` : `Nozzle ${short}`;
}

// ────────────────────────────────────────────────────────────
// SQL. Each builder takes `hasBeds` because print_beds is behind a migration
// that not every deployment has applied — the piece half alone is correct, just
// incomplete, so a missing table degrades rather than throws.
//
// Every statement is filtered to ONE printer's compatibility roster before it
// looks at any schedule, so the window scans ride
// idx_order_pieces_nozzle_schedule_window (assigned_nozzle_asset_id,
// scheduled_start_at, scheduled_end_at) rather than walking a tenant's pieces.
// ────────────────────────────────────────────────────────────

/** Rows `nozzlePoolSql` returns — one per (nozzle × committed block), plus one
 *  with null bounds for a nozzle holding nothing. That null row is the case
 *  that matters most: it is the free twin. */
export interface NozzlePoolRow {
  nozzle_asset_id: string;
  nozzle_diameter_mm: string | number | null;
  nozzle_material: string | null;
  nozzle_name: string | null;
  nozzle_brand: string | null;
  installed_on: string | null;
  ref_id: string | null;
  start_at: string | null;
  end_at: string | null;
}

/**
 * Every usable nozzle this printer can mount, with the windows it is already
 * committed to across the whole fleet.
 *
 * Params: $1 company, $2 printer, $3 window from, $4 window to.
 */
export function nozzlePoolSql(hasBeds: boolean): string {
  return `WITH roster AS (
           SELECT pnc.nozzle_asset_id,
                  ai.nozzle_diameter_mm,
                  ai.nozzle_material,
                  ai.nozzle_name,
                  ai.nozzle_brand,
                  asto.installed_on_asset_id AS installed_on
             FROM printer_nozzle_compatibility pnc
             JOIN asset_instances ai ON ai.asset_id = pnc.nozzle_asset_id
             LEFT JOIN asset_stock asto ON asto.asset_id = pnc.nozzle_asset_id
            WHERE pnc.company_id = $1
              AND pnc.printer_id = $2
              -- 'damaged' is the only status that rules a nozzle out; a fitted
              -- or in-use one is the common, perfectly usable case.
              AND COALESCE(asto.status, 'available') <> 'damaged'
         )
         SELECT r.nozzle_asset_id, r.nozzle_diameter_mm, r.nozzle_material,
                r.nozzle_name, r.nozzle_brand, r.installed_on,
                blk.ref_id, blk.start_at::text AS start_at, blk.end_at::text AS end_at
           FROM roster r
           LEFT JOIN (
             SELECT op.assigned_nozzle_asset_id AS nz, op.piece_id::text AS ref_id,
                    op.scheduled_start_at AS start_at, op.scheduled_end_at AS end_at
               FROM order_pieces op
              WHERE op.company_id = $1
                AND op.assigned_nozzle_asset_id IN (SELECT nozzle_asset_id FROM roster)
                AND op.status IN ('scheduled','printing')
                AND op.scheduled_start_at < $4
                AND op.scheduled_end_at   > $3
             ${hasBeds ? `UNION ALL
             SELECT pb.assigned_nozzle_asset_id, pb.bed_id::text,
                    pb.scheduled_start_at, pb.scheduled_end_at
               FROM print_beds pb
              WHERE pb.company_id = $1
                AND pb.assigned_nozzle_asset_id IN (SELECT nozzle_asset_id FROM roster)
                AND pb.status IN ('scheduled','printing')
                AND pb.scheduled_start_at < $4
                AND pb.scheduled_end_at   > $3` : ""}
           ) blk ON blk.nz = r.nozzle_asset_id`;
}

/**
 * The earliest job holding one specific nozzle inside a window, or no row when
 * it is free. Named rather than counted so a refusal can say what is in the way.
 *
 * Params: $1 company, $2 nozzle, $3 from, $4 to, $5 exclude piece (nullable),
 * and — only when `hasBeds` — $6 exclude bed (nullable).
 */
export function nozzleBusyProbeSql(hasBeds: boolean): string {
  return `SELECT label FROM (
         SELECT op.piece_name AS label, op.scheduled_start_at AS s
           FROM order_pieces op
          WHERE op.company_id = $1
            AND op.assigned_nozzle_asset_id = $2
            AND op.status IN ('scheduled','printing')
            AND op.scheduled_start_at < $4
            AND op.scheduled_end_at   > $3
            AND ($5::uuid IS NULL OR op.piece_id <> $5::uuid)
         ${hasBeds ? `UNION ALL
         SELECT pb.bed_name AS label, pb.scheduled_start_at AS s
           FROM print_beds pb
          WHERE pb.company_id = $1
            AND pb.assigned_nozzle_asset_id = $2
            AND pb.status IN ('scheduled','printing')
            AND pb.scheduled_start_at < $4
            AND pb.scheduled_end_at   > $3
            AND ($6::uuid IS NULL OR pb.bed_id <> $6::uuid)` : ""}
       ) x
       ORDER BY s ASC
       LIMIT 1`;
}

/**
 * The printer's whole nozzle roster with identity, stock state and a per-nozzle
 * "is it busy in this window?" — everything a substitution decision needs, in
 * one round trip.
 *
 * Params: $1 company, $2 printer, $3 from, $4 to, $5 exclude piece (nullable),
 * and — only when `hasBeds` — $6 exclude bed (nullable).
 */
export function nozzleRosterSql(hasBeds: boolean): string {
  return `SELECT pnc.nozzle_asset_id,
              ai.nozzle_diameter_mm,
              ai.nozzle_material,
              ai.nozzle_name,
              ai.nozzle_brand,
              ai.location,
              COALESCE(asto.status, 'available') AS status,
              asto.installed_on_asset_id AS installed_on,
              NULLIF(TRIM(CONCAT_WS(' ', pi2.brand, pi2.model)), '') AS installed_on_label,
              (EXISTS (
                 SELECT 1 FROM order_pieces op
                  WHERE op.company_id = pnc.company_id
                    AND op.assigned_nozzle_asset_id = pnc.nozzle_asset_id
                    AND op.status IN ('scheduled','printing')
                    AND op.scheduled_start_at < $4
                    AND op.scheduled_end_at   > $3
                    AND ($5::uuid IS NULL OR op.piece_id <> $5::uuid)
               )${hasBeds ? ` OR EXISTS (
                 SELECT 1 FROM print_beds pb
                  WHERE pb.company_id = pnc.company_id
                    AND pb.assigned_nozzle_asset_id = pnc.nozzle_asset_id
                    AND pb.status IN ('scheduled','printing')
                    AND pb.scheduled_start_at < $4
                    AND pb.scheduled_end_at   > $3
                    AND ($6::uuid IS NULL OR pb.bed_id <> $6::uuid)
               )` : ""}) AS busy
         FROM printer_nozzle_compatibility pnc
         JOIN asset_instances ai ON ai.asset_id = pnc.nozzle_asset_id
         LEFT JOIN asset_stock asto ON asto.asset_id = pnc.nozzle_asset_id
         LEFT JOIN printer_instances pi2
           ON pi2.printer_id = asto.installed_on_asset_id
          AND pi2.company_id = pnc.company_id
        WHERE pnc.company_id = $1 AND pnc.printer_id = $2`;
}

/**
 * Fold the flat roster×blocks rows into one entry per nozzle, grouped by spec.
 *
 * `specOf` is passed in rather than imported so this module never owns a second
 * opinion about what makes two nozzles the same — the caller hands it the one
 * from the scheduling kernel.
 */
export function foldNozzlePools(
  rows: readonly NozzlePoolRow[],
  specOf: (dia: number | null, mat: string | null) => string,
): NozzlePool[] {
  const byNozzle = new Map<
    string,
    NozzlePoolMember & { spec: string; dia: number | null; mat: string | null }
  >();
  for (const r of rows) {
    const dia = r.nozzle_diameter_mm != null ? Number(r.nozzle_diameter_mm) : null;
    let entry = byNozzle.get(r.nozzle_asset_id);
    if (!entry) {
      entry = {
        nozzle_asset_id: r.nozzle_asset_id,
        label: nozzleIdentityLabel({ ...r, nozzle_diameter_mm: dia }),
        installed_on_printer_id: r.installed_on,
        busy: [],
        spec: specOf(dia, r.nozzle_material),
        dia,
        mat: r.nozzle_material,
      };
      byNozzle.set(r.nozzle_asset_id, entry);
    }
    if (r.ref_id && r.start_at && r.end_at) {
      entry.busy.push({ ref_id: r.ref_id, start_at: r.start_at, end_at: r.end_at });
    }
  }
  const poolsBySpec = new Map<string, NozzlePool>();
  for (const e of byNozzle.values()) {
    const pool = poolsBySpec.get(e.spec) ?? {
      spec: e.spec,
      nozzle_diameter_mm: e.dia,
      nozzle_material: e.mat,
      members: [],
    };
    pool.members.push({
      nozzle_asset_id: e.nozzle_asset_id,
      label: e.label,
      installed_on_printer_id: e.installed_on_printer_id,
      busy: e.busy,
    });
    poolsBySpec.set(e.spec, pool);
  }
  return [...poolsBySpec.values()];
}

export interface MsInterval {
  start: number;
  end: number;
}

/**
 * When is a whole POOL unavailable — i.e. when is EVERY nozzle in it busy?
 *
 * This is the interval set a board must place around, and it is the honest one:
 * a job blocked by its own nozzle is not blocked at all if a twin is free, so
 * the only genuine obstruction is the pool running out. With one member it
 * reduces to that member's own commitments, which is precisely the old
 * behaviour — so a printer with a single 0.4mm brass nozzle schedules exactly
 * as it always did.
 *
 * `excludeRefIds` drops a job's own blocks: a piece being dragged must not
 * count its current placement against itself.
 *
 * Computed as the INTERSECTION of the members' busy sets rather than by
 * counting overlaps, because "all N busy" and "N overlapping blocks" are not
 * the same statement — two blocks on one nozzle and none on another would
 * satisfy the count while leaving the pool free.
 *
 * The client mirrors this exactly (printexec-client src/jobs/nozzlePool.ts).
 * Keep the two in sync: if they disagree, the board places chips the server
 * then rejects, which is the failure this whole change exists to remove.
 */
export function poolBusyIntervals(
  members: ReadonlyArray<{ busy: ReadonlyArray<{ ref_id: string; start_at: string; end_at: string }> }>,
  excludeRefIds: ReadonlySet<string> = new Set(),
): MsInterval[] {
  if (members.length === 0) return [];
  let acc: MsInterval[] | null = null;
  for (const m of members) {
    const own = mergeIntervals(
      m.busy
        .filter((b) => !excludeRefIds.has(b.ref_id))
        .map((b) => ({ start: Date.parse(b.start_at), end: Date.parse(b.end_at) }))
        .filter((iv) => Number.isFinite(iv.start) && Number.isFinite(iv.end) && iv.end > iv.start),
    );
    // A free member frees the pool outright — no need to look at the rest.
    if (own.length === 0) return [];
    acc = acc === null ? own : intersectIntervals(acc, own);
    if (acc.length === 0) return [];
  }
  return acc ?? [];
}

/** Sorted, non-overlapping union of a list of intervals. */
function mergeIntervals(list: readonly MsInterval[]): MsInterval[] {
  if (list.length === 0) return [];
  const sorted = [...list].sort((a, b) => a.start - b.start);
  const out: MsInterval[] = [{ ...sorted[0]! }];
  for (let i = 1; i < sorted.length; i++) {
    const iv = sorted[i]!;
    const last = out[out.length - 1]!;
    if (iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else out.push({ ...iv });
  }
  return out;
}

/** Overlap of two sorted, non-overlapping interval lists. */
function intersectIntervals(a: readonly MsInterval[], b: readonly MsInterval[]): MsInterval[] {
  const out: MsInterval[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i]!.start, b[j]!.start);
    const end = Math.min(a[i]!.end, b[j]!.end);
    if (end > start) out.push({ start, end });
    if (a[i]!.end < b[j]!.end) i++;
    else j++;
  }
  return out;
}
