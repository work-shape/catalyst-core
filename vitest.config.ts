import { sourceAliases } from "@work-shape/catalyst-quality-config/source-aliases";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { configDefaults, defineConfig } from "vitest/config";
import DurationSequencer from "./scripts/vitest-duration-sequencer";
import {
  connectionsForWorkers,
  defaultTestWorkers,
  workersForConnections
} from "./scripts/test-postgres-capacity.mjs";

const rootDir = dirname(fileURLToPath(import.meta.url));

/**
 * The test files to run side by side: as many as the machine has cores for, and no more than
 * the test server has connections for. `pnpm check:local` starts a server with room for all
 * of them; any other server is asked. A server that cannot be asked limits nothing here, and
 * the tests then say what is wrong with it.
 */
async function testWorkers(): Promise<number> {
  const wanted = defaultTestWorkers();
  const url = process.env.POSTGRES_STORE_TEST_DATABASE_URL;
  if (!url) return wanted;
  const sql = postgres(url, { max: 1, connect_timeout: 5, onnotice() {} });
  try {
    const [row] = await sql<{ setting: string }[]>`
      select setting from pg_settings where name = 'max_connections'`;
    const maxConnections = Number(row?.setting);
    if (!Number.isInteger(maxConnections)) return wanted;
    const workers = Math.min(wanted, workersForConnections(maxConnections));
    if (workers < wanted)
      console.warn(
        `The test Postgres has max_connections ${maxConnections}: running ${workers} test files side by side instead of ${wanted}. ` +
          `Start it with "-c max_connections=${connectionsForWorkers(wanted)}" for all of them, as pnpm check:local does.`
      );
    return workers;
  } catch {
    return wanted;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}

const maxWorkers = await testWorkers();

export default defineConfig({
  resolve: {
    alias: sourceAliases(rootDir)
  },
  test: {
    globalSetup: ["tests/support/postgres-global-setup.ts"],
    // See scripts/test-postgres-capacity.mjs for the arithmetic.
    maxWorkers,
    // Close suite connections/held transactions before the file fixture is reset or dropped.
    sequence: { hooks: "stack", sequencer: DurationSequencer },
    hookTimeout: 60000, // check-limit
    testTimeout: 30000, // check-limit
    include: ["tests/**/*.test.ts"],
    // A scale test proves a property at the volume a customer reaches and takes minutes. It runs
    // in the nightly hosted check and before a release, which set CATALYST_SCALE_TESTS=1, and not
    // in the lander's gate or a PR's checks.
    exclude:
      process.env.CATALYST_SCALE_TESTS === "1"
        ? configDefaults.exclude
        : [...configDefaults.exclude, "tests/**/*.scale.test.ts"]
  }
});
