/* Run the integration tests against a throwaway Postgres.
   ────────────────────────────────────────────────────────────────────────
   The *.integration.test.ts files are skipped unless TEST_DATABASE_URL is set,
   and they deliberately do not fall back to DATABASE_URL, so they can never
   touch production. This starts a real Postgres, points them at it, and throws
   it away afterwards.

   `persistent: false` means the data directory goes when the process does.
   The port is deliberately not 5432, so this cannot collide with a local
   development database someone happens to be running.

   Usage:  npm run test:integration
*/
import EmbeddedPostgres from "embedded-postgres";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

const DATA_DIR = "./.pgtest";
const PORT = 5433;

// A leftover data directory from a killed run makes initialise() fail. It is
// throwaway by construction, so clearing it is safe and saves a confusing error.
rmSync(DATA_DIR, { recursive: true, force: true });

const pg = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: "postgres",
  password: "pw",
  port: PORT,
  persistent: false,
});

await pg.initialise();
try {
  await pg.start();
} catch (e) {
  // embedded-postgres rejects with undefined when the server exits during
  // startup, so the default report is a bare "undefined" above a wall of
  // Postgres log lines. The overwhelmingly common cause on Windows is the OS
  // or a security product refusing the binary a listen socket ("could not bind
  // IPv4 address 127.0.0.1: Permission denied"), which no amount of retrying
  // fixes and which says nothing about the code under test.
  console.error(
    `\nCould not start the throwaway Postgres on port ${PORT}.\n` +
    `If the log above says "could not bind ... Permission denied", this machine is\n` +
    `refusing the Postgres binary a listen socket — the integration tests cannot run\n` +
    `here, and that is an environment problem rather than a test failure.\n` +
    `Otherwise: check nothing else is on port ${PORT}.\n` +
    (e ? `\nUnderlying error: ${e}\n` : ""),
  );
  rmSync(DATA_DIR, { recursive: true, force: true });
  process.exit(2);
}

let failed = false;
try {
  execFileSync(
    process.execPath,
    [
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      "--test",
      "test/order-numbering.integration.test.ts",
      "test/batch-runs.integration.test.ts",
      "test/invite-expiry.integration.test.ts",
    ],
    {
      stdio: "inherit",
      env: { ...process.env, TEST_DATABASE_URL: `postgres://postgres:pw@localhost:${PORT}/postgres` },
    },
  );
} catch {
  failed = true;
} finally {
  await pg.stop();
  rmSync(DATA_DIR, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
