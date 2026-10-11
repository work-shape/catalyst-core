import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { defineConfig } from "vitest/config";
import {
  connectionsForWorkers,
  defaultTestWorkers,
  workersForConnections
} from "./scripts/test-postgres-capacity.mjs";

const sourceAlias = {
  "@vivd-catalyst/agent-runtime": "packages/agent-runtime/src/index.ts",
  "@vivd-catalyst/api-contract": "packages/api-contract/src/index.ts",
  "@vivd-catalyst/api-client": "packages/api-client/src/index.ts",
  "@vivd-catalyst/app-kit/client": "packages/app-kit/src/client.ts",
  "@vivd-catalyst/app-kit/protocol": "packages/app-kit/src/protocol.ts",
  "@vivd-catalyst/app-kit": "packages/app-kit/src/index.ts",
  "@vivd-catalyst/app-build/build": "packages/app-build/src/build.ts",
  "@vivd-catalyst/app-build": "packages/app-build/src/index.ts",
  "@vivd-catalyst/auth": "packages/auth/src/index.ts",
  "@vivd-catalyst/core": "packages/core/src/index.ts",
  "@vivd-catalyst/chat-server": "packages/chat-server/src/index.ts",
  "@vivd-catalyst/chat-ui/access": "packages/chat-ui/src/access/index.ts",
  "@vivd-catalyst/chat-ui/build-area": "packages/chat-ui/src/build-area/index.ts",
  "@vivd-catalyst/chat-ui/operations": "packages/chat-ui/src/operations/index.ts",
  "@vivd-catalyst/chat-ui/pages": "packages/chat-ui/src/pages/index.ts",
  "@vivd-catalyst/chat-ui/shell": "packages/chat-ui/src/shell.tsx",
  "@vivd-catalyst/chat-ui/admin": "packages/chat-ui/src/admin.tsx",
  "@vivd-catalyst/chat-ui/vite": "packages/chat-ui/src/vite.js",
  "@vivd-catalyst/chat-ui": "packages/chat-ui/src/index.tsx",
  "@vivd-catalyst/chat-widget": "packages/chat-widget/src/index.tsx",
  "@vivd-catalyst/capability-sdk": "packages/capability-sdk/src/index.ts",
  "@vivd-catalyst/client-assembly": "packages/client-assembly/src/index.ts",
  "@vivd-catalyst/config-schema": "packages/config-schema/src/index.ts",
  "@vivd-catalyst/data-source": "packages/data-source/src/index.ts",
  "@vivd-catalyst/document-execution": "packages/document-execution/src/index.ts",
  "@vivd-catalyst/mail": "packages/mail/src/index.ts",
  "@vivd-catalyst/model-provider": "packages/model-provider/src/index.ts",
  "@vivd-catalyst/object-storage": "packages/object-storage/src/index.ts",
  "@vivd-catalyst/postgres-connector": "packages/postgres-connector/src/index.ts",
  "@vivd-catalyst/postgres-store/migration-statements":
    "packages/postgres-store/src/migration-statements.js",
  "@vivd-catalyst/postgres-store": "packages/postgres-store/src/index.ts",
  "@vivd-catalyst/tool-execution": "packages/tool-execution/src/index.ts",
  "@vivd-catalyst/tool-sdk": "packages/tool-sdk/src/index.ts",
  "@vivd-catalyst/ui/chart-engine": "packages/ui/src/data/chart-engine.ts",
  "@vivd-catalyst/ui/gallery": "packages/ui/src/gallery/index.tsx",
  "@vivd-catalyst/ui/theme": "packages/ui/src/theme/index.ts",
  "@vivd-catalyst/ui": "packages/ui/src/index.ts",
  "@vivd-catalyst/usage-governance": "packages/usage-governance/src/index.ts"
};

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
    alias: Object.fromEntries(
      Object.entries(sourceAlias).map(([name, path]) => [name, resolve(rootDir, path)])
    )
  },
  test: {
    globalSetup: ["tests/support/postgres-global-setup.ts"],
    // See scripts/test-postgres-capacity.mjs for the arithmetic.
    maxWorkers,
    // Close suite connections/held transactions before the file fixture is reset or dropped.
    sequence: { hooks: "stack" },
    hookTimeout: 60000,
    testTimeout: 30000,
    include: ["tests/**/*.test.ts"]
  }
});
