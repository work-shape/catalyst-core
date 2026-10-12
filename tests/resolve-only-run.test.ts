import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestConfig } from "./support/fixtures";
import { startTestProcess } from "./support/test-process";

// A bound on a hang: both processes of a test start through the TypeScript loader.
const ENDED_WITHIN_MS = 120_000;

describe("a resolve-only run, as the release gate starts every built entry point", () => {
  let directory = "";
  let configPath = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "catalyst-resolve-only-"));
    configPath = join(directory, "app.yaml");
    // JSON is YAML. The config turns a module on that only a capability ships.
    await writeFile(
      configPath,
      JSON.stringify({ ...createTestConfig(), modules: { documents: { enabled: true } } })
    );
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  /** The environment names no database and no secret: the run ends before one is asked for. */
  async function resolveOnly(name: string, build: "with-capability" | "without-capability") {
    const child = startTestProcess(new URL("./support/resolve-only-process.ts", import.meta.url), {
      args: [name, build],
      env: { PATH: process.env.PATH, CATALYST_RESOLVE_ONLY: "1", CLIENT_CONFIG_PATH: configPath },
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const [code] = await once(child, "exit");
    return { code, stderr };
  }

  // Fails without the change: the two workers were assembled without the capabilities of the
  // build, so they stopped on the module although the build ships it, and no run ended early.
  it.each(["server", "agent-run-worker", "workspace-command-worker", "artifact-preview-worker"])(
    "ends the %s with code 0 when its build ships every module that is on, and stops it when not",
    async (name) => {
      const [withCapability, withoutCapability] = await Promise.all([
        resolveOnly(name, "with-capability"),
        resolveOnly(name, "without-capability")
      ]);

      expect(withCapability).toMatchObject({ code: 0 });
      expect(withoutCapability.code).toBe(1);
      expect(withoutCapability.stderr).toContain(
        "Module 'documents' is enabled but this build ships no code for it"
      );
    },
    ENDED_WITHIN_MS
  );
});
