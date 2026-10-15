import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assetRepoCommitJob,
  assetRepoSweepJob,
  createPageBundleJobs,
  createSandboxPageBuild
} from "@work-shape/catalyst-server";
import {
  assertCommandWorkerServesModuleJobKinds,
  createClientInstanceWorkspaceCommandWorker,
  platformModules
} from "@work-shape/catalyst-client-assembly";
import { createModuleRegistry, type Logger } from "@work-shape/catalyst-core";
import { parseClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import { LocalWorkspaceCommandProcessExecutor } from "@work-shape/catalyst-tool-execution";
import { createTestConfig, workspaceInfrastructure } from "./support/fixtures";
import { MemoryObjectStorage } from "./support/memory-object-storage";
import { fileTestDatabaseUrl } from "./support/test-database";
import { createWorkspaceHarness } from "./support/workspace-tools-harness";

// With the apps module on, the workspace command worker builds Pages and keeps the
// repositories of Apps: an assembly whose worker serves less, or that has nowhere to put a
// built Page, does not start.

const silent: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => silent
};

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "page-build-worker-test-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("the apps module and the workspace command worker", () => {
  const snapshot = (enabled: boolean) =>
    createModuleRegistry(platformModules).snapshot({ apps: { enabled } });

  it("refuses a worker that does not serve page.bundle with the module on", async () => {
    const harness = await createWorkspaceHarness();
    const { handlers } = createPageBundleJobs({
      clientInstanceId: harness.clientInstanceId,
      stores: harness.store,
      pages: { objects: new MemoryObjectStorage() },
      workspaceObjects: harness.objectStore,
      logger: silent,
      build: createSandboxPageBuild({
        sandbox: new LocalWorkspaceCommandProcessExecutor(),
        tempRoot: join(scratch, "builds")
      })
    });

    expect(() => assertCommandWorkerServesModuleJobKinds(snapshot(true), [])).toThrow(
      "'modules.apps.enabled' is true, but the workspace command worker of this assembly does not serve the job kind 'page.bundle'"
    );
    // A worker that builds Pages and keeps no repositories is refused as well.
    const builds = handlers.map((handler) => handler.kind.kind);
    expect(() => assertCommandWorkerServesModuleJobKinds(snapshot(true), builds)).toThrow(
      "does not serve the job kind 'asset_repo.commit'"
    );
    expect(() =>
      assertCommandWorkerServesModuleJobKinds(snapshot(true), [
        ...builds,
        assetRepoCommitJob.kind,
        assetRepoSweepJob.kind
      ])
    ).not.toThrow();
    expect(() => assertCommandWorkerServesModuleJobKinds(snapshot(false), [])).not.toThrow();
  });

  const workerConfig = (input: { files: boolean }) => {
    const base = createTestConfig();
    const root = join(scratch, "worker-objects");
    return parseClientInstanceConfig({
      ...base,
      modules: { apps: { enabled: true } },
      executionWorkspaces: { enabled: true },
      infrastructure: {
        ...base.infrastructure,
        ...workspaceInfrastructure(join(root, "workspaces")),
        objectStorage: {
          workspaces: { provider: "filesystem", root: join(root, "workspaces") },
          ...(input.files ? { files: { provider: "filesystem", root: join(root, "files") } } : {})
        }
      }
    });
  };

  it("assembles the platform's workspace command worker with the module on", async () => {
    const worker = await createClientInstanceWorkspaceCommandWorker({
      config: workerConfig({ files: true }),
      capabilities: [],
      env: { DATABASE_URL: await fileTestDatabaseUrl() }
    });
    await worker.close();
  });

  it("does not start that worker without the store it puts built Pages in", async () => {
    await expect(
      createClientInstanceWorkspaceCommandWorker({
        config: workerConfig({ files: false }),
        capabilities: [],
        env: { DATABASE_URL: await fileTestDatabaseUrl() }
      })
    ).rejects.toThrow(
      "'modules.apps.enabled' is true, but 'infrastructure.objectStorage.files' is not configured"
    );
  });
});
