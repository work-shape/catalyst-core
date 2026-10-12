import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTestConfig } from "./support/fixtures";
import { killTestProcess, startTestProcess } from "./support/test-process";

// A bound on a hang: the processes of a test start through the TypeScript loader.
const ENDED_WITHIN_MS = 120_000;
const MARKER = "resolve-only: this process starts with this config";
const PROCESSES = [
  "server",
  "agent-run-worker",
  "workspace-command-worker",
  "artifact-preview-worker"
];

type Build =
  "with-capability" | "without-capability" | "with-capability-that-needs-the-command-worker";

describe("a resolve-only run, as the release gate starts every built entry point", () => {
  let directory = "";
  const children: ChildProcess[] = [];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "catalyst-resolve-only-"));
  });

  // A run that did not end is not left behind when its test gives up.
  afterEach(async () => {
    for (const child of children.splice(0)) await killTestProcess(child);
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  /** A release config with a module on that only a capability ships. JSON is YAML. */
  async function configFile(
    name: string,
    executionWorkspaces: boolean,
    capabilities: Record<string, unknown> = {},
    modules: Record<string, { enabled: boolean }> = { documents: { enabled: true } }
  ): Promise<string> {
    const path = join(directory, `${name}.yaml`);
    const config = createTestConfig({
      executionWorkspaces: { enabled: executionWorkspaces },
      workspaceObjectRoot: join(directory, "workspace-objects")
    });
    await writeFile(path, JSON.stringify({ ...config, capabilities, modules }));
    return path;
  }

  /** The environment names no database and no secret: the run ends before one is asked for. */
  async function resolveOnly(name: string, build: Build, configPath: string) {
    const child = startTestProcess(new URL("./support/instance-process.ts", import.meta.url), {
      args: [name, build, "--resolve-only"],
      env: { PATH: process.env.PATH, CLIENT_CONFIG_PATH: configPath },
      stdio: ["ignore", "pipe", "pipe"]
    });
    children.push(child);
    const output = { stdout: "", stderr: "" };
    for (const stream of ["stdout", "stderr"] as const) {
      child[stream]?.setEncoding("utf8").on("data", (chunk: string) => {
        output[stream] += chunk;
      });
    }
    const [code] = await once(child, "exit");
    return { code, ...output };
  }

  // Fails without the change: the two workers were assembled without the capabilities of the
  // build, so they stopped on the module although the build ships it, and no run ended early.
  it.each(PROCESSES)(
    "ends the %s with code 0 when its build ships every module that is on, and stops it when not",
    async (name) => {
      const config = await configFile("workspaces-on", true);
      const [withCapability, withoutCapability] = await Promise.all([
        resolveOnly(name, "with-capability", config),
        resolveOnly(name, "without-capability", config)
      ]);

      expect(withCapability).toMatchObject({ code: 0, stdout: `${MARKER}\n` });
      expect(withoutCapability).toMatchObject({ code: 1, stdout: "" });
      expect(withoutCapability.stderr).toContain(
        "Module 'documents' is enabled but this build ships no code for it"
      );
    },
    ENDED_WITHIN_MS
  );

  // Fails without the change: the build knew neither module, so each process stopped on an
  // unknown module name.
  it.each(PROCESSES)(
    "ends the %s with code 0 with the modules workflows, dataStores and knowledge on, as with them off",
    async (name) => {
      const [on, off] = await Promise.all([
        resolveOnly(
          name,
          "without-capability",
          await configFile(
            "workflows-and-data-stores-on",
            true,
            {},
            {
              workflows: { enabled: true },
              dataStores: { enabled: true },
              knowledge: { enabled: true }
            }
          )
        ),
        resolveOnly(
          name,
          "without-capability",
          await configFile("workflows-and-data-stores-off", true, {}, {})
        )
      ]);

      expect(on).toMatchObject({ code: 0, stdout: `${MARKER}\n` });
      expect(off).toEqual(on);
    },
    ENDED_WITHIN_MS
  );

  // Fails without the change: the check ran after the store was open, so the run ended before it.
  it.each(["server", "agent-run-worker"])(
    "stops the %s on a config for a capability that its build does not have",
    async (name) => {
      const config = await configFile("unknown-capability", true, { notRegisteredByThisBuild: {} });
      const run = await resolveOnly(name, "with-capability", config);

      expect(run).toMatchObject({ code: 1, stdout: "" });
      expect(run.stderr).toContain(
        "Capability config has no registered implementation: notRegisteredByThisBuild"
      );
    },
    ENDED_WITHIN_MS
  );

  it(
    "stops the workspace command worker on a config that turns Execution Workspaces off",
    async () => {
      const config = await configFile("workspaces-off", false);
      const run = await resolveOnly("workspace-command-worker", "with-capability", config);

      expect(run).toMatchObject({ code: 1, stdout: "" });
      expect(run.stderr).toContain("Execution workspaces are disabled in release config");
    },
    ENDED_WITHIN_MS
  );

  it(
    "stops the workspace command worker, and no other process, when a module needs a job kind it does not serve",
    async () => {
      const config = await configFile("workspaces-on", true);
      const build = "with-capability-that-needs-the-command-worker";
      const [worker, server] = await Promise.all([
        resolveOnly("workspace-command-worker", build, config),
        resolveOnly("server", build, config)
      ]);

      expect(worker).toMatchObject({ code: 1, stdout: "" });
      expect(worker.stderr).toContain(
        "the workspace command worker of this assembly does not serve the job kind 'documents.render'"
      );
      expect(server).toMatchObject({ code: 0, stdout: `${MARKER}\n` });
    },
    ENDED_WITHIN_MS
  );
});
