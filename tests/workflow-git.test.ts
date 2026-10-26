import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { commitsAssetRepos, platformModules } from "@work-shape/catalyst-client-assembly";
import { runCli } from "@work-shape/catalyst-cli";
import { createTestFetch } from "./support/test-instance";
import { testOperations } from "./support/operations";
import { workflowConfigSchema } from "@work-shape/catalyst-config-schema";
import {
  WORKFLOW_ASSET_KIND,
  isJsonObject,
  createModuleRegistry,
  scheduleDedupeKey,
  type JobWorker,
  type JsonObject
} from "@work-shape/catalyst-core";
import { assetRepoSweepJob, createAssetRepoJobs } from "@work-shape/catalyst-server";
import { LocalWorkspaceCommandProcessExecutor } from "@work-shape/catalyst-tool-execution";
import {
  WORKFLOW_SOURCE_DEFAULTS,
  createCodeStepJobs,
  writeWorkflowManifest,
  type WorkflowSourceLimits
} from "@work-shape/catalyst-workflows";
import { SERVICE_HEADER, clientInstanceId, errorSchema } from "./support/access-instance";
import { createTestConfig } from "./support/fixtures";
import { localAssetRepoCommit, readRepoCommit } from "./support/asset-repo";
import { recordJobErrors } from "./support/job-diagnostics";
import { MemoryObjectStorage } from "./support/memory-object-storage";
import { type WorkflowFixture } from "./support/workflow-instance";
import { readyWorkflows } from "./support/workflow-runs";

// Every write of a Workflow is a commit of its folder in its own repository (WF-GIT-1),
// against a real Postgres, through the API of an instance with the module `workflows` on and
// `apps` off, a `files` store and a worker that commits with the git of this machine. The
// config of a revision stays `{ name, manifest, files }`, which is what an earlier release
// reads and runs; the file set holds the folder, and the commit holds the same folder.

const WORKFLOW = "double";
const address = { kind: WORKFLOW_ASSET_KIND, name: WORKFLOW };

const script = (factor: number) => `import json, sys
data = json.load(sys.stdin)
print(json.dumps({"result": data["number"] * ${factor}}))
`;

/** A Workflow that hands a number to `steps/double.py` and returns what it answered. */
const definition = (name = "Double"): JsonObject => ({
  id: WORKFLOW,
  name,
  runAs: "workflow-runner",
  inputs: { type: "object" },
  outputs: { type: "object" },
  steps: [
    { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
    {
      id: "code0",
      name: "Run double.py",
      type: "code",
      file: "double.py",
      input: { number: { ref: { step: "start", path: "input.number" } } },
      inputSchema: { type: "object" },
      outputSchema: { type: "object" }
    },
    {
      id: "result",
      name: "Result",
      type: "output",
      input: { result: { ref: { step: "code0", path: "result" } } }
    }
  ]
});

/** The same definition with every key in reverse order, as a client may send it. */
function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, entry]) => [key, reversed(entry)])
  );
}

const writeSchema = z.object({ revision: z.number() });

let open: WorkflowFixture | undefined;
const directories: string[] = [];
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function ready(options: { files?: false; sourceLimits?: WorkflowSourceLimits } = {}) {
  const objects = new MemoryObjectStorage();
  const t = await readyWorkflows(
    (fixture) => {
      open = fixture;
    },
    {
      definitions: "assets",
      codeRunner: { timeoutSeconds: 20 },
      ...(options.sourceLimits ? { sourceLimits: options.sourceLimits } : {}),
      ...(options.files === false ? {} : { files: objects })
    }
  );
  const tempRoot = await mkdtemp(join(tmpdir(), "workflow-git-test-"));
  directories.push(tempRoot);
  let now = new Date();
  // The command worker's commits, on a worker that knows `workflows` on and `apps` off.
  const committer: JobWorker = t.worker(
    createAssetRepoJobs({
      clientInstanceId,
      stores: t.stores,
      objects,
      workspaceObjects: undefined,
      logger: recordJobErrors(t.workerLogs),
      commit: await localAssetRepoCommit(join(tempRoot, "commits")),
      now: () => now
    }).handlers
  );
  committer.start();
  const runner = t.worker([
    ...t.workflows.jobHandlers,
    ...createCodeStepJobs({
      clientInstanceId,
      stores: t.stores,
      stepFiles: t.stepFiles,
      sandbox: new LocalWorkspaceCommandProcessExecutor(),
      tempRoot: join(tempRoot, "code"),
      slots: 2,
      timeoutSeconds: 20,
      limits: { cpuCount: 1, memoryBytes: 128 * 1024 * 1024, pidsLimit: 64, scratchBytes: 16e6 },
      cancelCheckMs: 50
    }).handlers
  ]);
  const saveConfig = (
    manifest: unknown,
    files: readonly { path: string; content: string }[],
    expectedRevision: number | null,
    headers: Record<string, string> = {}
  ) =>
    t.call(t.admin.id, "assets.put", {
      params: address,
      payload: { config: { name: WORKFLOW, manifest, files }, expectedRevision },
      headers
    });
  const saveFolder = (
    files: readonly { path: string; text: string }[],
    expectedRevision: number | null
  ) =>
    t.call(t.admin.id, "assets.put", {
      params: address,
      payload: { files, expectedRevision }
    });
  const revisionOf = (response: Awaited<ReturnType<typeof saveConfig>>) => {
    expect(response.statusCode, response.body).toBe(200);
    return writeSchema.parse(response.json()).revision;
  };
  const stored = async () => {
    const asset = await t.stores.configAssets.getConfigAsset({ clientInstanceId, ...address });
    if (!asset) throw new Error("The Workflow is not stored");
    return asset;
  };
  const ledger = async () =>
    t.stores.configAssets.listAssetRepoBundles({ clientInstanceId, assetId: (await stored()).id });
  const commitOf = async (commit: string) => readRepoCommit(objects, await ledger(), commit);
  const bundleObjects = () => objects.keys().filter((key) => key.endsWith(".bundle"));
  /** Runs the sweeper as its schedule does, at the given time, and waits until it is done. */
  const sweepAt = async (at: Date) => {
    now = at;
    await t.stores.jobs.enqueue(
      assetRepoSweepJob,
      {},
      { clientInstanceId, dedupeKey: scheduleDedupeKey(assetRepoSweepJob.kind) }
    );
    for (let waited = 0; waited < 400; waited += 1) {
      const kinds = await t.stores.jobs.summarizeByKind({ clientInstanceId });
      const sweep = kinds.find((summary) => summary.kind === assetRepoSweepJob.kind);
      if (!sweep || sweep.queued + sweep.running === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("The sweep did not end");
  };
  return {
    t,
    objects,
    runner,
    saveConfig,
    saveFolder,
    revisionOf,
    stored,
    ledger,
    commitOf,
    bundleObjects,
    sweepAt
  };
}

/** Folder commands through the same authenticated HTTP path as an installed CLI. */
function cli(t: WorkflowFixture, cwd: string, workspaceId: string) {
  const serverFetch = createTestFetch(t.instance, { "x-test-user": t.admin.id });
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (new URL(request.url).pathname === testOperations["access_tokens.exchange"].path) {
      return Response.json({
        accessToken: "access-token",
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      });
    }
    // The fixture authenticates its recorded user; token exchange is exercised above.
    request.headers.delete("authorization");
    return serverFetch(request);
  };
  return async (...args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(
      ["workflow", ...args, "--instance", "https://catalyst.test", "--workspace", workspaceId],
      {
        cwd,
        env: { CATALYST_API_KEY: "cat_personal" },
        fetchImpl,
        stdout: (text) => out.push(text),
        stderr: (text) => err.push(text)
      }
    );
    return { code, out: out.join(""), err: err.join("") };
  };
}

describe("a Workflow whose writes are commits", () => {
  it("round-trips a CLI folder without a revision, commits an edited script once and refuses stale folders", async () => {
    const { t, stored, ledger, commitOf } = await ready();
    const cwd = await mkdtemp(join(tmpdir(), "workflow-folder-test-"));
    directories.push(cwd);
    const workspaceId = await t.sharedWorkspace("Workflow folders");
    const run = cli(t, cwd, workspaceId);
    await mkdir(join(cwd, "source/steps"), { recursive: true });
    const manifest = `# Keep this comment.\n${writeWorkflowManifest(definition())}`;
    await writeFile(join(cwd, "source/workflow.yaml"), manifest);
    await writeFile(join(cwd, "source/steps/double.py"), script(2));
    const created = await run("push", "source");
    expect(created, created.err).toMatchObject({ code: 0 });
    expect(created.out).toContain("catalyst workflow publish double --revision 1");
    const original = await stored();
    expect(original.revision).toBe(1);
    expect(await ledger()).toHaveLength(1);
    expect(await run("pull", WORKFLOW, "copy")).toMatchObject({ code: 0 });
    expect(await readFile(join(cwd, "copy/workflow.yaml"), "utf8")).toBe(manifest);
    const state = await readFile(join(cwd, "copy/.catalyst-app.json"), "utf8");
    expect(JSON.parse(state)).toMatchObject({ workflow: WORKFLOW, revision: 1 });
    const unchanged = await run("push", "copy", "--json");
    expect(unchanged, unchanged.err).toMatchObject({ code: 0 });
    expect(JSON.parse(unchanged.out)).toMatchObject({ revision: 1, unchanged: true });
    expect((await stored()).commit).toBe(original.commit);
    expect(await ledger()).toHaveLength(1);

    await writeFile(join(cwd, "copy/steps/double.py"), script(3));
    const status = await run("status", WORKFLOW, "copy", "--json");
    expect(JSON.parse(status.out)).toMatchObject({
      workflow: WORKFLOW,
      draftRevision: 1,
      local: { changed: ["steps/double.py"] }
    });
    const overwrite = await run("pull", WORKFLOW, "copy");
    expect(overwrite).toMatchObject({ code: 2 });
    expect(overwrite.err).toContain("has local changes a pull would overwrite");
    const edited = await run("push", "copy");
    expect(edited, edited.err).toMatchObject({ code: 0 });
    const after = await stored();
    expect(after.revision).toBe(2);
    expect(await ledger()).toHaveLength(2);
    expect(await commitOf(after.commit ?? "")).toMatchObject({
      commits: 2,
      parent: original.commit,
      files: { "workflow.yaml": manifest, "steps/double.py": script(3) }
    });
    // An unchanged stale folder is refused too, rather than skipped as a no-op.
    for (const changed of [false, true]) {
      if (changed) await writeFile(join(cwd, "source/steps/double.py"), script(4));
      const stale = await run("push", "source");
      expect(stale.code).toBe(1);
      expect(stale.err).toContain("REVISION_CONFLICT");
      expect(stale.err).toContain(
        "The draft moved since revision 1 was pulled. Nothing was written. Pull the Workflow into another folder"
      );
    }
    expect((await stored()).revision).toBe(2);
    expect(await ledger()).toHaveLength(2);

    expect(await run("pull", WORKFLOW, "older", "--revision", "1")).toMatchObject({ code: 0 });
    expect(await readFile(join(cwd, "older/steps/double.py"), "utf8")).toBe(script(2));
    expect((await run("push", "older")).code).toBe(1);
    await t.expectOk(t.root.id, "assets.publish", {
      params: address,
      payload: { revision: 2, workspaceId }
    });
    expect(await run("pull", WORKFLOW, "live", "--published")).toMatchObject({ code: 0 });
    expect(await readFile(join(cwd, "live/steps/double.py"), "utf8")).toBe(script(3));
    await writeFile(join(cwd, "copy/steps/double.py"), script(4));
    expect(await run("push", "copy")).toMatchObject({ code: 0 });
    expect((await stored()).revision).toBe(3);
    const publishedBehindDraft = await run("push", "live");
    expect(publishedBehindDraft.code).toBe(1);
    expect(publishedBehindDraft.err).toContain("The draft moved since revision 2 was pulled.");
    expect(await ledger()).toHaveLength(3);
    // Existing files without a baseline are never taken over by pull.
    const foreign = await run("pull", WORKFLOW, ".");
    expect(foreign).toMatchObject({ code: 2 });
    expect(foreign.err).toContain("Pull into an empty or new folder");
    expect(await run("history", WORKFLOW, "--json")).toMatchObject({ code: 0 });
    // The generic publish verb still requires an explicit revision, unlike App publish.
    const publish = await run("publish", WORKFLOW);
    expect(publish.code).toBe(2);
    expect(publish.err).toContain("--revision <n>");
  }, 120_000);

  it("writes a CLI file holding a key-like string with the skill warning and no secret in the output", async () => {
    const { t, stored, ledger, commitOf } = await ready();
    const cwd = await mkdtemp(join(tmpdir(), "workflow-folder-warning-"));
    directories.push(cwd);
    const run = cli(t, cwd, await t.sharedWorkspace("Workflow warnings"));
    await mkdir(join(cwd, "steps"));
    await writeFile(join(cwd, "workflow.yaml"), writeWorkflowManifest(definition()));
    const key = "sk-" + "test_value_".repeat(3);
    const content = `# ${key}\n${script(2)}`;
    await writeFile(join(cwd, "steps/double.py"), content);
    const result = await run("push");
    expect(result, result.err).toMatchObject({ code: 0 });
    expect(result.out).toContain("Warning: Possible secret");
    expect(result.out).toContain("Possible secret in 'steps/double.py' at line 1.");
    expect(result.out + result.err).not.toContain(key);
    expect(await ledger()).toHaveLength(1);
    expect(await commitOf((await stored()).commit ?? "")).toMatchObject({
      files: { "steps/double.py": content }
    });
  }, 120_000);

  // Fails where the API commits on a files store alone: an instance without Execution
  // Workspaces runs no command worker, and every new Workflow waited for one in vain.
  it("is committed where the instance keeps files and runs the worker that commits, and only there", () => {
    const base = createTestConfig();
    const registry = createModuleRegistry(platformModules);
    const modulesOn = (...names: string[]) =>
      registry.snapshot(Object.fromEntries(names.map((name) => [name, { enabled: true }])));
    const instance = (files: boolean, workspaces: boolean) => ({
      ...base,
      executionWorkspaces: { ...base.executionWorkspaces, enabled: workspaces },
      infrastructure: {
        ...base.infrastructure,
        sandbox: { provider: "local" as const },
        objectStorage: {
          ...base.infrastructure.objectStorage,
          ...(files ? { files: { provider: "filesystem" as const, root: "/tmp/files" } } : {})
        }
      }
    });
    const workflows = modulesOn("workflows");
    expect(commitsAssetRepos(instance(true, true), workflows)).toBe(true);
    expect(commitsAssetRepos(instance(false, true), workflows)).toBe(false);
    expect(commitsAssetRepos(instance(true, false), workflows)).toBe(false);
    expect(commitsAssetRepos(instance(true, true), modulesOn())).toBe(false);
    expect(commitsAssetRepos(instance(false, false), modulesOn("apps"))).toBe(true);
  });

  it("writes workflow.yaml from a definition in the schema's order, the same bytes for any order of keys", () => {
    const text = writeWorkflowManifest(definition());
    expect(writeWorkflowManifest(reversed(definition()))).toBe(text);
    expect(text.split("\n").slice(0, 3)).toEqual([
      "id: double",
      "name: Double",
      "runAs: workflow-runner"
    ]);
    // A step in the order its type names its fields, the steps of the file last.
    expect(text).toContain("  - id: start\n    name: Start\n    type: trigger\n");
    expect(text.trimEnd().split("\n").slice(-2)).toEqual([
      "          step: code0",
      "          path: result"
    ]);
  });

  // Fails without the folder of the kind: the write would store the config alone and name no
  // file set and no commit, as before WF-GIT-1.
  it("commits a config write and a folder write once each, by the caller, and stores the config as before", async () => {
    const { t, saveConfig, saveFolder, revisionOf, stored, ledger, commitOf } = await ready();
    const files = [{ path: "steps/double.py", content: script(2) }];
    const first = revisionOf(await saveConfig(reversed(definition()), files, null));
    const created = await stored();
    expect(created.revision).toBe(first);
    expect(created.fileSetId).toBeDefined();
    expect(created.commit).toMatch(/^[0-9a-f]{40}$/u);
    // The config is the one an earlier release reads: name, manifest and files, nothing more.
    expect(workflowConfigSchema.parse(created.config)).toEqual({
      name: WORKFLOW,
      manifest: definition(),
      files
    });
    const one = await commitOf(created.commit ?? "");
    expect(one).toMatchObject({ commits: 1, author: t.admin.id });
    expect(one.files).toEqual({
      "workflow.yaml": writeWorkflowManifest(definition()),
      "steps/double.py": script(2)
    });
    expect(await ledger()).toHaveLength(1);

    // The folder as a person writes it: its comment and its order stay in the commit.
    const yaml = `# Doubles, and now triples, a number.\n${writeWorkflowManifest(definition("Triple"))}`;
    const second = revisionOf(
      await saveFolder(
        [
          { path: "workflow.yaml", text: yaml },
          { path: "steps/double.py", text: script(3) }
        ],
        first
      )
    );
    const written = await stored();
    expect(written.revision).toBe(second);
    expect(written.config).toEqual({
      name: WORKFLOW,
      manifest: definition("Triple"),
      files: [{ path: "steps/double.py", content: script(3) }]
    });
    const two = await commitOf(written.commit ?? "");
    expect(two).toMatchObject({ commits: 2, parent: created.commit, author: t.admin.id });
    expect(two.files).toEqual({ "workflow.yaml": yaml, "steps/double.py": script(3) });
    expect(await ledger()).toHaveLength(2);
    // The folder a read answers is the one that was written.
    const read = await t.expectOk(t.admin.id, "assets.get", {
      params: address,
      query: { files: "true" }
    });
    expect(
      z
        .object({ files: z.array(z.object({ path: z.string(), text: z.string() })) })
        .parse(read.json()).files
    ).toEqual([
      { path: "steps/double.py", text: script(3) },
      { path: "workflow.yaml", text: yaml }
    ]);
  }, 120_000);

  it("refuses the second of two saves from one revision with 412 and adds one commit", async () => {
    const { saveConfig, revisionOf, stored, ledger, t } = await ready();
    const first = revisionOf(
      await saveConfig(definition(), [{ path: "steps/double.py", content: script(2) }], null)
    );
    const base = (await stored()).commit;
    const answers = await Promise.all(
      [3, 4].map((factor) =>
        saveConfig(definition(), [{ path: "steps/double.py", content: script(factor) }], first)
      )
    );
    const statuses = answers.map((answer) => answer.statusCode).sort();
    expect(statuses, answers.map((answer) => answer.body).join("\n")).toEqual([200, 412]);
    const refused = answers.find((answer) => answer.statusCode === 412);
    expect(errorSchema.parse(refused?.json()).error.code).toBe("REVISION_CONFLICT");
    const after = await stored();
    expect(after.revision).toBe(first + 1);
    const bundles = await ledger();
    expect(bundles).toHaveLength(2);
    expect(bundles.map((bundle) => bundle.tipCommit)).toEqual([base, after.commit]);
    // Every bundle of the repository is the commit of a revision.
    for (const [index, bundle] of bundles.entries()) {
      const revision = await t.stores.configAssets.getConfigAssetRevision({
        clientInstanceId,
        ...address,
        revision: first + index
      });
      expect(revision?.commit).toBe(bundle.tipCommit);
    }
  }, 120_000);

  it("answers a save sent again under its key with the same revision and commit", async () => {
    const { saveConfig, revisionOf, stored, ledger } = await ready();
    const key = { "idempotency-key": "workflow-save-1" };
    const files = [{ path: "steps/double.py", content: script(2) }];
    const first = revisionOf(await saveConfig(definition(), files, null, key));
    const commit = (await stored()).commit;
    const again = revisionOf(await saveConfig(definition(), files, null, key));
    expect(again).toBe(first);
    expect((await stored()).commit).toBe(commit);
    expect(await ledger()).toHaveLength(1);
  }, 120_000);

  // A commit is made before the instance checks the definition; a refused one never becomes
  // part of the repository and is given up with its object a day later.
  it("leaves a refused definition a pending bundle, which the sweeper removes", async () => {
    const { saveConfig, revisionOf, stored, ledger, bundleObjects, sweepAt } = await ready();
    const files = [{ path: "steps/double.py", content: script(2) }];
    const first = revisionOf(await saveConfig(definition(), files, null));
    const live = bundleObjects();
    expect(live).toHaveLength(1);
    // A file no step names is refused by the engine's check of the definition.
    const refused = await saveConfig({ ...definition(), id: "another" }, files, first);
    expect(refused.statusCode, refused.body).toBe(422);

    expect((await stored()).revision).toBe(first);
    expect(await ledger()).toHaveLength(1);
    expect(bundleObjects()).toHaveLength(2);
    await sweepAt(new Date());
    expect(bundleObjects()).toHaveLength(2);
    await sweepAt(new Date(Date.now() + 25 * 60 * 60 * 1000));
    expect(bundleObjects()).toEqual(live);
    expect(await ledger()).toHaveLength(1);
  }, 120_000);

  it("runs a Workflow written as its folder from its config, as an earlier release does", async () => {
    const { t, saveFolder, revisionOf, runner } = await ready();
    const revision = revisionOf(
      await saveFolder(
        [
          { path: "workflow.yaml", text: writeWorkflowManifest(definition()) },
          { path: "steps/double.py", text: script(2) }
        ],
        null
      )
    );
    await t.expectOk(t.root.id, "assets.publish", { params: address, payload: { revision } });
    const started = z.object({ id: z.string() }).parse(
      (
        await t.expectOk(t.root.id, "workflows.start", {
          params: { workflow: WORKFLOW },
          payload: { input: { number: 21 } }
        })
      ).json()
    );
    const run = await t.finish(started.id, runner);
    expect(run.status, JSON.stringify(run.error)).toBe("done");
    expect(JSON.parse(run.outputPreview?.text ?? "null")).toEqual({ result: 42 });
  }, 120_000);

  it("runs its own revision tree through later publish and deletion, and a config edit carries the extras (check 152)", async () => {
    const { t, saveFolder, saveConfig, revisionOf, runner, stored } = await ready();
    const manifest = definition();
    const code = Array.isArray(manifest.steps) ? manifest.steps[1] : undefined;
    if (!isJsonObject(code)) throw new Error("The fixture has no code step");
    delete code.file;
    code.entry = "lib/run_domain.py";
    const folder = (factor: number) => [
      { path: "workflow.yaml", text: writeWorkflowManifest(manifest) },
      {
        path: "lib/run_domain.py",
        text: 'from lib.db import factor\nimport json, sys\nnumber=json.load(sys.stdin)["number"]\nprint(json.dumps({"result":number*factor,"sql":open("sql/query.sql").read()}))'
      },
      { path: "lib/db.py", text: `factor = ${factor}` },
      { path: "sql/query.sql", text: "select 42" },
      { path: "tests/unused.txt", text: "accepted" }
    ];
    const first = revisionOf(await saveFolder(folder(2), null));
    await t.expectOk(t.root.id, "assets.publish", {
      params: address,
      payload: { revision: first }
    });
    const begin = async () =>
      z.object({ id: z.string() }).parse(
        (
          await t.expectOk(t.root.id, "workflows.start", {
            params: { workflow: WORKFLOW },
            payload: { input: { number: 21 } }
          })
        ).json()
      );
    const old = await begin();
    const second = revisionOf(await saveFolder(folder(3), first));
    await t.expectOk(t.root.id, "assets.publish", {
      params: address,
      payload: { revision: second }
    });
    const newer = await begin();
    const third = revisionOf(await saveConfig({ ...manifest, name: "Renamed" }, [], second));
    expect((await stored()).config?.files).toBeUndefined();
    await t.expectOk(t.root.id, "assets.delete", {
      params: address,
      payload: { expectedRevision: third }
    });
    for (const [run, factor] of [
      [old, 2],
      [newer, 3]
    ] as const) {
      const ended = await t.finish(run.id, runner);
      expect(ended.status, JSON.stringify(ended.error)).toBe("done");
      expect(JSON.parse(ended.outputPreview?.text ?? "null")).toEqual({ result: 21 * factor });
    }
  }, 120_000);

  it("refuses an oversized tree with its operator setting named and advertises the configured bounds", async () => {
    const sourceLimits = { ...WORKFLOW_SOURCE_DEFAULTS, files: 2 };
    const { t, saveFolder, stored } = await ready({ sourceLimits });
    const context = await t.expectOk(t.admin.id, "platform.context.get", {});
    expect(
      z
        .object({ kinds: z.array(z.object({ kind: z.string(), source: z.unknown().optional() })) })
        .parse(context.json())
        .kinds.find((kind) => kind.kind === "workflow")?.source
    ).toEqual(sourceLimits);
    const response = await saveFolder(
      [
        { path: "workflow.yaml", text: writeWorkflowManifest(definition()) },
        { path: "steps/double.py", text: script(2) },
        { path: "sql/unused.sql", text: "select 1" }
      ],
      null
    );
    expect(response.statusCode, response.body).toBe(422);
    expect(response.body).toContain("workflows.source.files");
    await expect(stored()).rejects.toThrow("not stored");
  }, 120_000);

  it("can raise the repository file bound above its default without copying source into config.files", async () => {
    const sourceLimits = { ...WORKFLOW_SOURCE_DEFAULTS, fileBytes: 4 * 1024 ** 2 };
    const { saveFolder, revisionOf, stored } = await ready({ sourceLimits });
    revisionOf(
      await saveFolder(
        [
          { path: "workflow.yaml", text: writeWorkflowManifest(definition()) },
          { path: "steps/double.py", text: script(2) },
          { path: "lib/large.txt", text: "x".repeat(3 * 1024 ** 2) }
        ],
        null
      )
    );
    expect((await stored()).config?.files).toEqual([
      { path: "steps/double.py", content: script(2) }
    ]);
  }, 120_000);

  it("keeps a Workflow from before its repository on file sets without a commit", async () => {
    const { t, saveConfig, revisionOf, stored, ledger } = await ready();
    // Written as an earlier release wrote it: the config alone.
    await t.stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      actor: { userId: t.admin.id, displayLabel: "Admin", roles: [] },
      baseRevisions: { [`${WORKFLOW_ASSET_KIND}:${WORKFLOW}`]: null },
      mutations: [
        {
          type: "upsert",
          kind: WORKFLOW_ASSET_KIND,
          name: WORKFLOW,
          draft: true,
          config: {
            name: WORKFLOW,
            manifest: definition(),
            files: [{ path: "steps/double.py", content: script(2) }]
          }
        }
      ]
    });
    const before = await stored();
    expect(before.commit).toBeUndefined();
    const next = revisionOf(
      await saveConfig(
        definition(),
        [{ path: "steps/double.py", content: script(3) }],
        before.revision
      )
    );
    const after = await stored();
    expect(after.revision).toBe(next);
    expect(after.fileSetId).toBeDefined();
    expect(after.commit).toBeUndefined();
    expect(await ledger()).toEqual([]);
  }, 120_000);

  // Fails where the folder is stored first: the Page file set refused the path in its own words.
  it("refuses a missing entry before anything is stored or committed", async () => {
    const { saveConfig, saveFolder, bundleObjects, objects } = await ready();
    for (const response of [
      await saveConfig(definition(), [{ path: "lib/double.py", content: script(2) }], null),
      await saveFolder(
        [
          { path: "workflow.yaml", text: writeWorkflowManifest(definition()) },
          { path: "lib/double.py", text: script(2) }
        ],
        null
      )
    ]) {
      expect(response.statusCode, response.body).toBe(422);
      expect(errorSchema.parse(response.json()).error.details).toMatchObject({
        reason: "code_file_missing"
      });
    }
    expect(bundleObjects()).toEqual([]);
    expect(objects.keys()).toEqual([]);
  }, 120_000);

  // Fails where a batch writes the config alone: the store refuses it once the draft has a
  // commit, though the check of the batch said it held.
  it("is not written by a sync, which makes no commit", async () => {
    const { t } = await ready();
    // A release, which may name any asset of the instance.
    const response = await t.instance.call("assets.sync", {
      headers: { [SERVICE_HEADER]: "svc_release" },
      payload: {
        items: [
          {
            type: "put",
            kind: WORKFLOW_ASSET_KIND,
            name: WORKFLOW,
            config: { name: WORKFLOW, manifest: definition() }
          }
        ]
      }
    });
    expect(response.statusCode, response.body).toBeGreaterThanOrEqual(400);
    expect(response.body).toContain("is written with 'assets.put'");
    expect(
      await t.stores.configAssets.getConfigAsset({ clientInstanceId, ...address })
    ).toBeUndefined();
  }, 120_000);

  it("writes config revisions alone on an instance without a files store", async () => {
    const { saveConfig, revisionOf, stored } = await ready({ files: false });
    revisionOf(
      await saveConfig(definition(), [{ path: "steps/double.py", content: script(2) }], null)
    );
    const asset = await stored();
    expect(asset.fileSetId).toBeUndefined();
    expect(asset.commit).toBeUndefined();
  }, 120_000);
});
