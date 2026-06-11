import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const sourceAlias = {
  "@vivd-stage/agent-runtime": "packages/agent-runtime/src/index.ts",
  "@vivd-stage/api-contract": "packages/api-contract/src/index.ts",
  "@vivd-stage/api-client": "packages/api-client/src/index.ts",
  "@vivd-stage/core/testing": "packages/core/src/testing.ts",
  "@vivd-stage/auth": "packages/auth/src/index.ts",
  "@vivd-stage/core": "packages/core/src/index.ts",
  "@vivd-stage/chat-server": "packages/chat-server/src/index.ts",
  "@vivd-stage/chat-ui/shell": "packages/chat-ui/src/shell.tsx",
  "@vivd-stage/chat-ui/admin": "packages/chat-ui/src/admin.tsx",
  "@vivd-stage/chat-ui": "packages/chat-ui/src/index.tsx",
  "@vivd-stage/chat-widget": "packages/chat-widget/src/index.tsx",
  "@vivd-stage/client-assembly": "packages/client-assembly/src/index.ts",
  "@vivd-stage/config-schema": "packages/config-schema/src/index.ts",
  "@vivd-stage/model-provider": "packages/model-provider/src/index.ts",
  "@vivd-stage/postgres-store": "packages/postgres-store/src/index.ts",
  "@vivd-stage/tool-execution": "packages/tool-execution/src/index.ts",
  "@vivd-stage/tool-sdk": "packages/tool-sdk/src/index.ts",
  "@vivd-stage/usage-governance": "packages/usage-governance/src/index.ts"
};

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: Object.fromEntries(
      Object.entries(sourceAlias).map(([name, path]) => [name, resolve(rootDir, path)])
    )
  },
  test: {
    include: ["tests/**/*.test.ts"]
  }
});
