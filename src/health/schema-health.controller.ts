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
      // The definition text is the only way to tell the resin-aware rewrite from
      // the original FDM-only rule — both share the constraint NAME.
      this.db.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition
           FROM pg_constraint
          WHERE conname = 'chk_ready_requires_core_data'
            AND conrelid = 'public.order_pieces'::regclass`
      ),
    ]);

    const has = (table: string, column: string) =>
      cols.rows.some((r) => r.table_name === table && r.column_name === column);

    const readyConstraint = constraint.rows[0]?.definition ?? null;
    // The rewrite branches on the technology; the original never mentioned it.
    const readyConstraintKnowsResin = !!readyConstraint && /MSLA/i.test(readyConstraint);

    const checks = {
      "order_pieces.resin_tank_id": has("order_pieces", "resin_tank_id"),
      "order_pieces.slicer_resin_used_ml": has("order_pieces", "slicer_resin_used_ml"),
      "print_beds.resin_tank_id": has("print_beds", "resin_tank_id"),
      "print_beds.slicer_resin_used_ml": has("print_beds", "slicer_resin_used_ml"),
      "asset_instances.resin_color": has("asset_instances", "resin_color"),
      "asset_instances.resin_hex": has("asset_instances", "resin_hex"),
      "chk_ready_requires_core_data.knows_resin": readyConstraintKnowsResin,
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
      // Verbatim, so a mismatch that these booleans do not model is still visible.
      ready_constraint: readyConstraint,
      timestamp: new Date().toISOString(),
    };
  }
}
