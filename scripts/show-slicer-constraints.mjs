// READ-ONLY. Prints the CHECK constraints that gate piece/bed readiness on the
// slicer file, plus a count of existing rows that would violate the NEW
// metadata-based rule (ready/scheduled/printing without slicer time + grams).
//
// Run:  npm run db:show-slicer-constraints   (or: node --env-file=.env scripts/show-slicer-constraints.mjs)
//
// Nothing is written. Use this to confirm the exact constraint DDL before
// applying the metadata-readiness migration.
import { Client } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is missing.");
  process.exit(1);
}

const client = new Client({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false }
});

const tables = ["order_pieces", "print_beds"];
const inList = tables.map((t) => `'public.${t}'::regclass`).join(", ");

try {
  await client.connect();

  // 1) Every CHECK constraint on the two tables, with full DDL. We want the
  //    exact definitions of chk_ready_requires_core_data /
  //    chk_scheduled_requires_core_data, and whether print_beds has analogues.
  const constraints = await client.query(`
    SELECT conrelid::regclass::text AS table_name,
           conname,
           pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE contype = 'c'
      AND conrelid IN (${inList})
    ORDER BY table_name, conname;
  `);

  console.log("\n=== CHECK constraints on order_pieces / print_beds ===\n");
  for (const row of constraints.rows) {
    const flags = /slicer_file_url/i.test(row.definition) ? "  <-- references slicer_file_url" : "";
    console.log(`[${row.table_name}] ${row.conname}${flags}`);
    console.log(`    ${row.definition}\n`);
  }

  // 2) Rows that would violate the NEW rule: anything at ready/scheduled/printing
  //    that is missing slicer time or filament grams. These must be reconciled
  //    (or the new constraint added NOT VALID) before VALIDATE.
  for (const table of tables) {
    const res = await client.query(`
      SELECT status, count(*)::int AS n
      FROM public.${table}
      WHERE status IN ('ready','scheduled','printing')
        AND (slicer_print_time_minutes IS NULL OR slicer_filament_used_grams IS NULL)
      GROUP BY status
      ORDER BY status;
    `);
    const total = res.rows.reduce((s, r) => s + r.n, 0);
    console.log(`=== ${table}: rows that would violate the metadata rule: ${total} ===`);
    for (const r of res.rows) console.log(`    ${r.status}: ${r.n}`);
    console.log("");
  }
} catch (err) {
  console.error("Introspection failed:", err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
