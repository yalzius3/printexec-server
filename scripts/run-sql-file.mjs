import { readFile } from "node:fs/promises";
import { Client } from "pg";

const databaseUrl = process.env.DATABASE_URL;
const targetFile = process.argv[2];

if (!databaseUrl) {
  console.error("DATABASE_URL is missing.");
  process.exit(1);
}

if (!targetFile) {
  console.error("Usage: node --env-file=.env scripts/run-sql-file.mjs <path-to-sql>");
  process.exit(1);
}

const sql = await readFile(targetFile, "utf8");

const client = new Client({
  connectionString: databaseUrl,
  ssl: {
    rejectUnauthorized: false
  }
});

try {
  await client.connect();
  await client.query(sql);
  console.log(`Executed SQL file: ${targetFile}`);
} finally {
  await client.end().catch(() => undefined);
}
