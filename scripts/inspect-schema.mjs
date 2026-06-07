import { Client } from "pg";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("DATABASE_URL is missing.");
  process.exit(1);
}

const client = new Client({
  connectionString: databaseUrl,
  ssl: {
    rejectUnauthorized: false
  }
});

const tableNames = [
  "filament_reference",
  "printer_reference",
  "asset_stock",
  "order_pieces",
  "order_piece_spools",
  "printer_instances",
  "printer_stock",
  "printer_nozzle_compatibility",
  "customers",
  "orders"
];

const inList = tableNames.map((name) => `'${name}'`).join(", ");

const tableQuery = `
  SELECT table_name
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN (${inList})
  ORDER BY table_name;
`;

const columnQuery = `
  SELECT table_name, column_name, data_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name IN (${inList})
  ORDER BY table_name, ordinal_position;
`;

const constraintQuery = `
  SELECT conname, conrelid::regclass AS table_name
  FROM pg_constraint
  WHERE conrelid::regclass::text IN (${inList})
  ORDER BY table_name, conname;
`;

try {
  await client.connect();

  const tables = await client.query(tableQuery);
  const columns = await client.query(columnQuery);
  const constraints = await client.query(constraintQuery);

  console.log("Tables");
  console.table(tables.rows);

  console.log("Columns");
  console.table(columns.rows);

  console.log("Constraints");
  console.table(constraints.rows);
} finally {
  await client.end().catch(() => undefined);
}
