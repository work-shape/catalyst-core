import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const sourceAlias = {
  "@vivd-catalyst/agent-runtime": "packages/agent-runtime/src/index.ts",
  "@vivd-catalyst/api-contract": "packages/api-contract/src/index.ts",
  "@vivd-catalyst/api-client": "packages/api-client/src/index.ts",
  "@vivd-catalyst/core/testing": "packages/core/src/testing.ts",
  "@vivd-catalyst/auth": "packages/auth/src/index.ts",
  "@vivd-catalyst/core": "packages/core/src/index.ts",
  "@vivd-catalyst/chat-server": "packages/chat-server/src/index.ts",
  "@vivd-catalyst/chat-ui/shell": "packages/chat-ui/src/shell.tsx",
  "@vivd-catalyst/chat-ui/admin": "packages/chat-ui/src/admin.tsx",
  "@vivd-catalyst/chat-ui": "packages/chat-ui/src/index.tsx",
  "@vivd-catalyst/chat-widget": "packages/chat-widget/src/index.tsx",
  "@vivd-catalyst/capability-sdk": "packages/capability-sdk/src/index.ts",
  "@vivd-catalyst/client-assembly": "packages/client-assembly/src/index.ts",
  "@vivd-catalyst/config-schema": "packages/config-schema/src/index.ts",
  "@vivd-catalyst/data-source": "packages/data-source/src/index.ts",
  "@vivd-catalyst/model-provider": "packages/model-provider/src/index.ts",
  "@vivd-catalyst/postgres-store": "packages/postgres-store/src/index.ts",
  "@vivd-catalyst/tool-execution": "packages/tool-execution/src/index.ts",
  "@vivd-catalyst/tool-sdk": "packages/tool-sdk/src/index.ts",
  "@vivd-catalyst/usage-governance": "packages/usage-governance/src/index.ts"
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
