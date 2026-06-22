import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineClientInstance } from "@vivd-catalyst/client-assembly";

describe("client instance environment loading", () => {
  it("keeps explicit process env above workspace and client .env files", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "vivd-client-env-"));
    const clientRoot = join(workspaceRoot, "clients", "demo");
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousClientOnly = process.env.VIVD_CLIENT_ENV_TEST_ONLY;

    try {
      await mkdir(clientRoot, { recursive: true });
      await writeFile(
        join(workspaceRoot, ".env"),
        [
          "DATABASE_URL=postgres://workspace@example.test/workspace",
          "VIVD_CLIENT_ENV_TEST_ONLY=workspace"
        ].join("\n")
      );
      await writeFile(
        join(clientRoot, ".env"),
        [
          "DATABASE_URL=postgres://client@example.test/client",
          "VIVD_CLIENT_ENV_TEST_ONLY=client"
        ].join("\n")
      );

      process.env.DATABASE_URL = "postgres://explicit@example.test/explicit";
      delete process.env.VIVD_CLIENT_ENV_TEST_ONLY;

      const client = defineClientInstance({
        rootDir: clientRoot,
        workspaceRoot
      });
      const env = client.loadEnvironment();

      expect(env.DATABASE_URL).toBe("postgres://explicit@example.test/explicit");
      expect(env.VIVD_CLIENT_ENV_TEST_ONLY).toBe("client");
    } finally {
      restoreProcessEnv("DATABASE_URL", previousDatabaseUrl);
      restoreProcessEnv("VIVD_CLIENT_ENV_TEST_ONLY", previousClientOnly);
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });
});

function restoreProcessEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
