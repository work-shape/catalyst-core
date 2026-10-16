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
  "@work-shape/catalyst-cli": "packages/config-cli/src/index.ts",
  "@work-shape/catalyst-agent-runtime": "packages/agent-runtime/src/index.ts",
  "@work-shape/catalyst-asset-repo": "packages/asset-repo/src/index.ts",
  "@work-shape/catalyst-asset-schemas": "packages/asset-schemas/src/index.ts",
  "@work-shape/catalyst-api-contract": "packages/api-contract/src/index.ts",
  "@work-shape/catalyst-api-client": "packages/api-client/src/index.ts",
  "@work-shape/catalyst-app-kit/client": "packages/app-kit/src/client.ts",
  "@work-shape/catalyst-app-kit/protocol": "packages/app-kit/src/protocol.ts",
  "@work-shape/catalyst-app-kit": "packages/app-kit/src/index.ts",
  "@work-shape/catalyst-app-build/build": "packages/app-build/src/build.ts",
  "@work-shape/catalyst-app-build": "packages/app-build/src/index.ts",
  "@work-shape/catalyst-auth": "packages/auth/src/index.ts",
  "@work-shape/catalyst-core": "packages/core/src/index.ts",
  "@work-shape/catalyst-server": "packages/chat-server/src/index.ts",
  "@work-shape/catalyst-chat-ui/access": "packages/chat-ui/src/admin/access/index.ts",
  "@work-shape/catalyst-chat-ui/build-area": "packages/chat-ui/src/studio/build-area/index.ts",
  "@work-shape/catalyst-chat-ui/operations": "packages/chat-ui/src/admin/operations/index.ts",
  "@work-shape/catalyst-chat-ui/agents": "packages/chat-ui/src/studio/agents/index.ts",
  "@work-shape/catalyst-chat-ui/apps": "packages/chat-ui/src/studio/apps/index.ts",
  "@work-shape/catalyst-chat-ui/workflows": "packages/chat-ui/src/studio/workflows/index.ts",
  "@work-shape/catalyst-chat-ui/pages": "packages/chat-ui/src/studio/pages/index.ts",
  "@work-shape/catalyst-chat-ui/shell": "packages/chat-ui/src/shell.tsx",
  "@work-shape/catalyst-chat-ui/reading-place":
    "packages/chat-ui/src/chat/assistant/reading-place.ts",
  "@work-shape/catalyst-chat-ui/surface-layout":
    "packages/chat-ui/src/chat/surface/surface-layout.ts",
  "@work-shape/catalyst-chat-ui/dock-state": "packages/chat-ui/src/chat/workspace/dock-state.ts",
  "@work-shape/catalyst-chat-ui/subject-run":
    "packages/chat-ui/src/chat/conversation/subject-run.ts",
  "@work-shape/catalyst-chat-ui/open-move": "packages/chat-ui/src/chat/conversation/open-move.ts",
  "@work-shape/catalyst-chat-ui/asset-tool-lines":
    "packages/chat-ui/src/chat/conversation/asset-tool-lines.ts",
  "@work-shape/catalyst-chat-ui/tool-call": "packages/chat-ui/src/chat/tools/tool-call.tsx",
  "@work-shape/catalyst-chat-ui/tool-display-panel":
    "packages/chat-ui/src/chat/tools/tool-display-panel.tsx",
  "@work-shape/catalyst-chat-ui/admin": "packages/chat-ui/src/admin.tsx",
  "@work-shape/catalyst-chat-ui/vite": "packages/chat-ui/src/vite.js",
  "@work-shape/catalyst-chat-ui": "packages/chat-ui/src/index.tsx",
  "@work-shape/catalyst-chat-widget": "packages/chat-widget/src/index.tsx",
  "@work-shape/catalyst-capability-sdk": "packages/capability-sdk/src/index.ts",
  "@work-shape/catalyst-client-assembly": "packages/client-assembly/src/index.ts",
  "@work-shape/catalyst-config-schema": "packages/config-schema/src/index.ts",
  "@work-shape/catalyst-connections": "packages/connections/src/index.ts",
  "@work-shape/catalyst-data-stores": "packages/data-stores/src/index.ts",
  "@work-shape/catalyst-data-source": "packages/data-source/src/index.ts",
  "@work-shape/catalyst-demo/sample-mcp": "clients/demo/sample-mcp/index.ts",
  "@work-shape/catalyst-demo/seed": "clients/demo/src/seed/index.ts",
  "@work-shape/catalyst-document-execution": "packages/document-execution/src/index.ts",
  "@work-shape/catalyst-mail": "packages/mail/src/index.ts",
  "@work-shape/catalyst-model-provider": "packages/model-provider/src/index.ts",
  "@work-shape/catalyst-object-storage": "packages/object-storage/src/index.ts",
  "@work-shape/catalyst-postgres-connector": "packages/postgres-connector/src/index.ts",
  "@work-shape/catalyst-postgres-store/migration-statements":
    "packages/postgres-store/src/migration-statements.js",
  "@work-shape/catalyst-postgres-store": "packages/postgres-store/src/index.ts",
  "@work-shape/catalyst-tool-execution": "packages/tool-execution/src/index.ts",
  "@work-shape/catalyst-tool-sdk": "packages/tool-sdk/src/index.ts",
  "@work-shape/catalyst-ui/chart-engine": "packages/ui/src/data/chart-engine.ts",
  "@work-shape/catalyst-ui/flow-layout": "packages/ui/src/flow/flow-layout.ts",
  "@work-shape/catalyst-ui/gallery": "packages/ui/src/gallery/index.tsx",
  "@work-shape/catalyst-ui/theme": "packages/ui/src/theme/index.ts",
  "@work-shape/catalyst-ui": "packages/ui/src/index.ts",
  "@work-shape/catalyst-usage-governance": "packages/usage-governance/src/index.ts",
  "@work-shape/catalyst-web-access": "packages/web-access/src/index.ts",
  "@work-shape/catalyst-workflows": "packages/workflows/src/index.ts"
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
