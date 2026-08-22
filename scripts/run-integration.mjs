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
import { readdirSync, rmSync } from "node:fs";
import net from "node:net";

/**
 * A data directory unique to THIS run.
 *
 * A single fixed path collides in a way that reads like a broken install: a
 * postmaster left behind by a killed run still holds the shared-memory segment
 * keyed to that path, so `initdb` refuses the next run with "pre-existing
 * shared memory block is still in use" even after the directory itself has been
 * deleted. Unique per run means a leftover process can never block the next
 * attempt — it only wastes memory until the machine is restarted.
 */
const DATA_DIR = `./.pgtest-${process.pid}`;

/** Can anything listen here? */
function bindable(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

/**
 * The first port this machine will actually give us.
 *
 * 5433 stays the default — deliberately not 5432, so this cannot collide with a
 * development database someone happens to be running. But a single hard-coded
 * port makes the whole suite unrunnable on a machine that refuses that one, and
 * "refuses that one" is common on Windows: a firewall rule, a security product,
 * or a reserved range (`netsh interface ipv4 show excludedportrange`) can take a
 * port out of circulation with no way to ask for it back. Postgres reports that
 * as a bare "could not bind ... Permission denied", which reads like a broken
 * install rather than a busy port.
 *
 * So: probe, and say which port we settled on. Override with TEST_PG_PORT.
 */
async function choosePort() {
  const preferred = Number(process.env.TEST_PG_PORT ?? 5433);
  for (const port of [preferred, 5544, 6543, 15432, 25432]) {
    if (await bindable(port)) {
      if (port !== preferred) {
        console.log(`Port ${preferred} is not available on this machine — using ${port} instead.`);
      }
      return port;
    }
  }
  console.error(
    `\nNo usable port for the throwaway Postgres (tried ${preferred}, 5544, 6543, 15432, 25432).\n` +
    `Set TEST_PG_PORT to one this machine will allow.\n`,
  );
  process.exit(2);
}

const PORT = await choosePort();

// Sweep directories left by earlier runs, including the old fixed `.pgtest`.
// Every one of them is throwaway by construction. One that is still locked
// (its postmaster survived a kill) is SKIPPED rather than fatal — this run does
// not need it, which is the whole reason the path above carries the pid.
for (const entry of readdirSync(".", { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.startsWith(".pgtest")) continue;
  try {
    rmSync(entry.name, { recursive: true, force: true });
  } catch {
    /* still held by a stray postmaster — leave it, we are not using it */
  }
}

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

/**
 * Every integration test in test/, discovered rather than listed.
 *
 * This used to be a hand-maintained array, and the failure mode was silent in
 * the worst direction: a new *.integration.test.ts file that nobody remembered
 * to add here simply never ran, while the suite reported green. A test that does
 * not run is worse than no test, because it is counted as evidence. Sorted so
 * the run order is stable across machines.
 */
const INTEGRATION_TESTS = readdirSync("test")
  .filter((f) => f.endsWith(".integration.test.ts"))
  .sort()
  .map((f) => `test/${f}`);

if (INTEGRATION_TESTS.length === 0) {
  console.error("No *.integration.test.ts files found in test/ — nothing to run.");
  await pg.stop();
  rmSync(DATA_DIR, { recursive: true, force: true });
  process.exit(2);
}
console.log(`Running ${INTEGRATION_TESTS.length} integration test files:`);
for (const t of INTEGRATION_TESTS) console.log(`  · ${t}`);

let failed = false;
try {
  execFileSync(
    process.execPath,
    [
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      "--test",
      ...INTEGRATION_TESTS,
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
