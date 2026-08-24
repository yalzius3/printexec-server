import { Controller, Get } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { Public } from "../auth/public.decorator";

/**
 * GET /api/health/schema — "is this database actually ready for the code that
 * is running against it?"
 *
 * Migrations here are applied BY HAND (there is no runner on deploy), so the
 * code and the schema drift independently. When they disagree the symptom is a
 * bare 500: Postgres raises undefined_column or a check violation, and the
 * browser shows "Internal server error" with nothing else. Diagnosing that has
 * repeatedly meant guessing, because the answer lives in a log the person
 * hitting the bug usually cannot read.
 *
 * The subtle case this exists for: a column can be present while the CONSTRAINT
 * that governs it is still the old one. `order_pieces.resin_tank_id` shipped in
 * the original resin stub, but `chk_ready_requires_core_data` was only taught
 * about resin by 2026-07-27_resin_tech.sql. Apply the columns without the
 * constraint rewrite and every resin piece that becomes 'ready' violates a rule
 * demanding a NOZZLE and FILAMENT GRAMS — which resin can never have. The
 * feature looks half-installed and fails in a way no amount of application code
 * can fix.
 *
 * Public and boolean-only: it reports schema shape, never data.
 */
@Controller("health/schema")
export class SchemaHealthController {
  constructor(private readonly db: DatabaseService) {}

  @Public()
  @Get()
  async getSchemaHealth() {
    const [cols, constraint] = await Promise.all([
      this.db.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND (
              (table_name = 'order_pieces' AND column_name IN ('resin_tank_id', 'slicer_resin_used_ml'))
              OR (table_name = 'print_beds' AND column_name IN ('resin_tank_id', 'slicer_resin_used_ml'))
              OR (table_name = 'asset_instances' AND column_name IN ('resin_color', 'resin_hex'))
            )`
      ),
      // The definition TEXT is the only way to tell these apart — every version
      // of this rule has shipped under the same constraint NAME, so presence
      // proves nothing about which rule is actually live.
      // EVERY check constraint on the two tables, not just the readiness pair.
      // Several of these are older than any migration in the repository, so the
      // only place their text exists is the database — and the one that governs
      // 'done' had to be discovered from a 500 on a shop floor, because nothing
      // here would show it. A constraint you cannot read is one you write code
      // against by guessing.
      this.db.query<{ conname: string; definition: string }>(
        `SELECT conname, pg_get_constraintdef(oid) AS definition
           FROM pg_constraint
          WHERE contype = 'c'
            AND conrelid IN ('public.order_pieces'::regclass, 'public.print_beds'::regclass)
          ORDER BY conrelid::regclass::text, conname`
      ),
    ]);

    const has = (table: string, column: string) =>
      cols.rows.some((r) => r.table_name === table && r.column_name === column);

    const readyRow = constraint.rows.find(
      (r) => r.conname === "chk_ready_requires_core_data"
    );
    const readyConstraint = readyRow?.definition ?? null;
    // The rewrite branches on the technology; the original never mentioned it.
    const readyConstraintKnowsResin = !!readyConstraint && /MSLA/i.test(readyConstraint);

    // The rule this whole subsystem has been fighting. Three versions have
    // shipped under one name:
    //   1. original      — gated on the slicer FILE (slicer_file_url NOT NULL)
    //   2. 2026-06-30    — gated on the slicer METADATA instead (time + grams)
    //   3. 2026-07-27    — same, but branching per technology (resin: ml + tank)
    //
    // If (1) is still live, typing print data can NEVER satisfy it: the file is
    // optional in the UI and bulk-assign explicitly nulls slicer_file_url, so
    // every save that promotes a piece to 'ready' without an uploaded file
    // violates the constraint and returns a bare 500. That is indistinguishable
    // from an application bug from the outside, which is exactly why this
    // reports it rather than leaving it to be inferred.
    const readyConstraintStillWantsFile =
      !!readyConstraint && /slicer_file_url/i.test(readyConstraint);
    // Dropped by 2026-06-30 and re-added by 2026-07-01; without it, bed-owned
    // pieces (whose own fields are nulled) cannot be scheduled at all.
    const readyConstraintHasBedEscape =
      !!readyConstraint && /bed_id/i.test(readyConstraint);

    const checks = {
      "order_pieces.resin_tank_id": has("order_pieces", "resin_tank_id"),
      "order_pieces.slicer_resin_used_ml": has("order_pieces", "slicer_resin_used_ml"),
      "print_beds.resin_tank_id": has("print_beds", "resin_tank_id"),
      "print_beds.slicer_resin_used_ml": has("print_beds", "slicer_resin_used_ml"),
      "asset_instances.resin_color": has("asset_instances", "resin_color"),
      "asset_instances.resin_hex": has("asset_instances", "resin_hex"),
      "chk_ready_requires_core_data.knows_resin": readyConstraintKnowsResin,
      // Inverted deliberately: every entry here is "true = healthy", so the
      // `missing` list below reads as a to-do without special-casing.
      "chk_ready_requires_core_data.metadata_gated_not_file_gated":
        !!readyConstraint && !readyConstraintStillWantsFile,
      "chk_ready_requires_core_data.has_bed_escape": readyConstraintHasBedEscape,
    };

    // Which migration to run for whatever is missing — the whole point is that
    // the answer is actionable without opening the repo.
    const remedies: Record<string, string> = {
      "order_pieces.resin_tank_id": "migrations/2026-07-27_resin_tech.sql",
      "order_pieces.slicer_resin_used_ml": "migrations/2026-07-27_resin_tech.sql",
      "chk_ready_requires_core_data.knows_resin": "migrations/2026-07-27_resin_tech.sql",
      "print_beds.resin_tank_id": "migrations/2026-07-29_resin_beds.sql",
      "print_beds.slicer_resin_used_ml": "migrations/2026-07-29_resin_beds.sql",
      "asset_instances.resin_color": "migrations/2026-08-13_resin_color.sql",
      "asset_instances.resin_hex": "migrations/2026-08-13_resin_color.sql",
      "chk_ready_requires_core_data.metadata_gated_not_file_gated":
        "migrations/2026-06-30_metadata_driven_readiness.sql, THEN 2026-07-01_readiness_bed_escape_fix.sql",
      "chk_ready_requires_core_data.has_bed_escape":
        "migrations/2026-07-01_readiness_bed_escape_fix.sql",
    };
    const missing = Object.entries(checks)
      .filter(([, ok]) => !ok)
      .map(([name]) => ({ check: name, apply: remedies[name] ?? "see migrations/" }));

    return {
      status: missing.length === 0 ? "ok" : "migrations_pending",
      // Whatever the platform exposes; Railway sets the first.
      build:
        process.env.RAILWAY_GIT_COMMIT_SHA ??
        process.env.GIT_COMMIT_SHA ??
        process.env.SOURCE_VERSION ??
        null,
      resin: checks,
      missing,
      // Verbatim, so a mismatch these booleans do not model is still visible.
      constraints: Object.fromEntries(
        constraint.rows.map((r) => [r.conname, r.definition])
      ),
      timestamp: new Date().toISOString(),
    };
  }
}
