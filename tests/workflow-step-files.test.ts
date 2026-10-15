import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { WORKFLOW_ASSET_KIND, type JsonObject } from "@work-shape/catalyst-core";
import { LocalWorkspaceCommandProcessExecutor } from "@work-shape/catalyst-tool-execution";
import {
  WORKFLOW_CODE_FILE_MAX_BYTES,
  WORKFLOW_STEP_FILES_MAX_BYTES,
  createCodeStepJobs
} from "@work-shape/catalyst-workflows";
import { clientInstanceId, errorSchema } from "./support/access-instance";
import { runSchema, type WorkflowFixture } from "./support/workflow-instance";
import { readyWorkflows } from "./support/workflow-runs";

// The step files of a Workflow as an instance holds them: written with the manifest in one
// `assets.put`, kept by the revision, read by the engine from the revision a run was started
// on. Everything goes through the API of an instance whose engine reads its assets, and the
// scripts run in the local sandbox. Each test fails on an instance whose Workflows have no
// files: a save with files is refused by the schema and every start with `code_file_missing`.

const WORKFLOW = "double";
const address = { kind: WORKFLOW_ASSET_KIND, name: WORKFLOW };

const script = (factor: number) => `
import json, sys
data = json.load(sys.stdin)
print(json.dumps({"result": data["number"] * ${factor}}))
`;

/** A Workflow that hands a number to one script per file and returns what the first returned. */
const definition = (files: readonly string[] = ["double.py"]) => ({
  id: WORKFLOW,
  name: "Double",
  runAs: "workflow-runner",
  inputs: { type: "object" },
  outputs: { type: "object" },
  steps: [
    { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
    ...files.map((file, position) => ({
      id: `code${position}`,
      name: `Run ${file}`,
      type: "code",
      file,
      input: { number: { ref: { step: "start", path: "input.number" } } },
      inputSchema: { type: "object" },
      outputSchema: { type: "object" }
    })),
    {
      id: "result",
      name: "Result",
      type: "output",
      input: { result: { ref: { step: "code0", path: "result" } } }
    }
  ]
});

interface StepFile {
  path: string;
  content: string;
}

const writeSchema = z.object({ revision: z.number() });
const assetSchema = z.object({
  config: z.object({
    files: z.array(z.object({ path: z.string(), content: z.string() })).optional()
  })
});
const listSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      definitionRevisionId: z.string(),
      runnable: z.boolean(),
      reasons: z.array(z.object({ code: z.string(), path: z.string().optional() }))
    })
  )
});

let open: WorkflowFixture | undefined;
const directories: string[] = [];
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function ready() {
  const t = await readyWorkflows(
    (fixture) => {
      open = fixture;
    },
    { definitions: "assets", codeRunner: { timeoutSeconds: 20 } }
  );
  const tempRoot = await mkdtemp(join(tmpdir(), "step-files-test-"));
  directories.push(tempRoot);
  // One worker serves the engine's jobs and the command worker's, as two processes do.
  const worker = t.worker([
    ...t.workflows.jobHandlers,
    ...createCodeStepJobs({
      clientInstanceId,
      stores: t.stores,
      sandbox: new LocalWorkspaceCommandProcessExecutor(),
      tempRoot,
      slots: 2,
      timeoutSeconds: 20,
      limits: { cpuCount: 1, memoryBytes: 128 * 1024 * 1024, pidsLimit: 64, scratchBytes: 16e6 },
      cancelCheckMs: 50
    }).handlers
  ]);
  const save = (
    files: readonly StepFile[] | undefined,
    expectedRevision: number | null,
    manifest: Record<string, unknown> = definition()
  ) =>
    t.call(t.admin.id, "assets.put", {
      params: address,
      payload: {
        config: { name: WORKFLOW, manifest, ...(files ? { files } : {}) },
        expectedRevision
      }
    });
  const put = async (files: readonly StepFile[], expectedRevision: number | null) => {
    const response = await save(files, expectedRevision);
    expect(response.statusCode, response.body).toBe(200);
    return writeSchema.parse(response.json()).revision;
  };
  const publish = (revision: number) =>
    t.expectOk(t.root.id, "assets.publish", { params: address, payload: { revision } });
  const begin = async (number: number) =>
    runSchema.parse(
      (
        await t.expectOk(t.root.id, "workflows.start", {
          params: { workflow: WORKFLOW },
          payload: { input: { number } }
        })
      ).json()
    );
  const result = (run: z.infer<typeof runSchema>): unknown =>
    JSON.parse(run.outputPreview?.text ?? "null");
  const listed = async () =>
    listSchema.parse((await t.expectOk(t.root.id, "workflows.list")).json()).items;
  return { t, worker, save, put, publish, begin, result, listed };
}

describe("the step files of a Workflow asset", () => {
  it("are saved with the manifest, read with the asset and run from the published revision", async () => {
    const { t, worker, put, publish, begin, result, listed } = await ready();
    const files = [{ path: "steps/double.py", content: script(2) }];
    const revision = await put(files, null);
    await publish(revision);

    expect(await listed()).toMatchObject([{ id: WORKFLOW, runnable: true, reasons: [] }]);
    // Whoever reads the definition reads its files: they are part of the asset's config.
    const read = assetSchema.parse(
      (await t.expectOk(t.admin.id, "assets.get", { params: address })).json()
    );
    expect(read.config.files).toEqual(files);

    const ended = await t.finish((await begin(21)).id, worker);
    expect(ended.status, JSON.stringify(ended.error)).toBe("done");
    expect(result(ended)).toEqual({ result: 42 });
  });

  it("stay those of the revision a run was started on when another is published", async () => {
    const { t, worker, put, publish, begin, result } = await ready();
    const first = await put([{ path: "steps/double.py", content: script(2) }], null);
    await publish(first);
    // The run is started and no worker serves it yet: it waits with the first revision's id.
    const waiting = await begin(21);

    const second = await put([{ path: "steps/double.py", content: script(3) }], first);
    await publish(second);
    const later = await begin(21);
    expect(later.definitionRevisionId).not.toBe(waiting.definitionRevisionId);

    expect(result(await t.finish(waiting.id, worker))).toEqual({ result: 42 });
    expect(result(await t.finish(later.id, worker))).toEqual({ result: 63 });

    // Also after the Workflow is gone a revision keeps its files for whoever names it.
    const again = await begin(4);
    await t.expectOk(t.root.id, "assets.delete", {
      params: address,
      payload: { expectedRevision: second }
    });
    expect(result(await t.finish(again.id, worker))).toEqual({ result: 12 });
  });

  it("are refused at a save for what no run could use, each with its reason", async () => {
    const { t, save } = await ready();
    const good = { path: "steps/double.py", content: script(2) };
    const refusal = async (
      files: readonly StepFile[] | undefined,
      manifest?: Record<string, unknown>
    ) => {
      const response = await save(files, null, manifest);
      expect(response.statusCode, response.body.slice(0, 300)).toBe(422);
      const { details } = errorSchema.parse(response.json()).error;
      return z
        .object({
          reason: z.string(),
          issues: z.array(z.object({ code: z.string(), path: z.string() }).loose())
        })
        .parse(details);
    };

    // A manifest that names a file the save does not bring, by the code a start refuses with.
    expect(await refusal(undefined)).toMatchObject({
      reason: "code_file_missing",
      issues: [{ code: "code_file_missing", path: "steps.code0.file" }]
    });
    // A file no step names.
    expect(await refusal([good, { path: "steps/other.py", content: "" }])).toMatchObject({
      reason: "code_file_unused",
      issues: [{ code: "code_file_unused", path: "files[1].path" }]
    });
    // A name outside the step files folder, a path that leaves it, and no script.
    for (const path of [
      "double.py",
      "README.md",
      "/steps/double.py",
      "steps/../double.py",
      "steps/../../etc/passwd.py",
      "steps/notes.md",
      "steps/.hidden.py"
    ]) {
      expect(await refusal([good, { path, content: "" }]), path).toMatchObject({
        reason: "code_file_invalid",
        issues: [{ code: "code_file_invalid", path: "files[1].path" }]
      });
    }
    // One path twice.
    expect((await refusal([good, good])).reason).toBe("code_file_invalid");
    // A script over the size of one file.
    const large = "#".repeat(WORKFLOW_CODE_FILE_MAX_BYTES + 1);
    expect(await refusal([{ ...good, content: large }])).toMatchObject({
      reason: "code_file_too_large",
      issues: [{ path: "steps.code0.file" }]
    });
    // Files that each fit and are too large together.
    const names = Array.from({ length: 9 }, (_, position) => `part${position}.py`);
    const full = "#".repeat(WORKFLOW_CODE_FILE_MAX_BYTES);
    expect(names.length * full.length).toBeGreaterThan(WORKFLOW_STEP_FILES_MAX_BYTES);
    expect(
      await refusal(
        names.map((name) => ({ path: `steps/${name}`, content: full })),
        definition(names)
      )
    ).toMatchObject({ reason: "code_files_too_large", issues: [{ path: "files" }] });

    expect(await t.stores.configAssets.getConfigAsset({ clientInstanceId, ...address })).toBe(
      undefined
    );
  });

  it("are refused with the definition for a text or a key the store cannot hold, at a check and at a save", async () => {
    const { t, save } = await ready();
    const good = { path: "steps/double.py", content: script(2) };
    const config = (manifest: Record<string, unknown>, files: readonly StepFile[] = [good]) => ({
      name: WORKFLOW,
      manifest,
      files
    });
    const steps = definition().steps;
    // A NUL character and half of a surrogate pair, each where the schema asks nothing of it.
    const cases: [string, ReturnType<typeof config>, string[]][] = [
      ["name", config({ ...definition(), name: "Dou\u0000ble" }), ["manifest", "name"]],
      [
        "description",
        config({ ...definition(), description: "a\ud800b" }),
        ["manifest", "description"]
      ],
      [
        "step name",
        config({ ...definition(), steps: [{ ...steps[0], name: "x\udc00" }, ...steps.slice(1)] }),
        ["manifest", "steps", "0", "name"]
      ],
      [
        "schema text",
        config({ ...definition(), inputs: { type: "object", description: "a\u0000b" } }),
        ["manifest", "inputs", "description"]
      ],
      [
        "key",
        config({ ...definition(), inputs: { type: "object", properties: { "a\u0000b": {} } } }),
        ["manifest", "inputs", "properties"]
      ],
      [
        "file content",
        config(definition(), [{ ...good, content: "a\u0000b" }]),
        ["files", "0", "content"]
      ],
      [
        "file path",
        config(definition(["double.py", "a\u0000.py"]), [
          good,
          { path: "steps/a\u0000.py", content: "" }
        ]),
        ["files", "1", "path"]
      ]
    ];
    // A check answers each part of a path as text, a refused save an index as a number.
    const issuesSchema = z.array(
      z.object({
        code: z.string().optional(),
        path: z.array(z.union([z.string(), z.number()])).transform((path) => path.map(String))
      })
    );
    for (const [title, sent, path] of cases) {
      const checked = await t.call(t.admin.id, "assets.validate", {
        params: { kind: WORKFLOW_ASSET_KIND },
        payload: { config: sent }
      });
      expect(checked.statusCode, `${title}: ${checked.body.slice(0, 300)}`).toBe(200);
      const told = z.object({ valid: z.boolean(), issues: issuesSchema }).parse(checked.json());
      expect(told.valid, title).toBe(false);
      expect(told.issues, title).toContainEqual({ code: "text_not_storable", path });

      const saved = await save(sent.files, null, sent.manifest);
      expect(saved.statusCode, `${title}: ${saved.body.slice(0, 300)}`).toBe(422);
      const { details } = errorSchema.parse(saved.json()).error;
      expect(z.object({ issues: issuesSchema }).parse(details).issues, title).toContainEqual({
        code: "text_not_storable",
        path
      });
      // Nothing of the refusal carries the text into what is stored with its run.
      expect(saved.body, title).not.toMatch(/\\u0000|\\ud800|\\udc00/u);
    }
    expect(await t.stores.configAssets.getConfigAsset({ clientInstanceId, ...address })).toBe(
      undefined
    );
  });

  it("are named by the list where a published revision lacks a script", async () => {
    const { t, put, publish, listed } = await ready();
    const revision = await put([{ path: "steps/double.py", content: script(2) }], null);
    await publish(revision);

    // A revision an earlier release stored and published, from before a Workflow held files.
    const asset = await t.stores.configAssets.getConfigAsset({ clientInstanceId, ...address });
    const key = `${WORKFLOW_ASSET_KIND}:${WORKFLOW}`;
    const stored = await t.stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { [key]: revision },
      mutations: [
        {
          type: "upsert",
          ...address,
          config: z
            .record(z.string(), z.json())
            .parse({ name: WORKFLOW, manifest: definition() }) satisfies JsonObject,
          draft: true
        }
      ]
    });
    const bare = stored.revisions[key] ?? 0;
    const record = await t.stores.configAssets.getConfigAssetRevision({
      clientInstanceId,
      ...address,
      revision: bare
    });
    await t.stores.configAssets.publishConfigAssetRevision({
      clientInstanceId,
      ...address,
      assetId: asset?.id ?? "",
      revision: bare,
      revisionId: record?.id ?? ""
    });

    expect(await listed()).toMatchObject([
      {
        id: WORKFLOW,
        definitionRevisionId: record?.id,
        runnable: false,
        reasons: [{ code: "code_file_missing", path: "steps.code0.file" }]
      }
    ]);
    // The start refuses for the same thing under the same code.
    const refused = await t.expectRefused(
      t.root.id,
      "workflows.start",
      { params: { workflow: WORKFLOW }, payload: { input: { number: 1 } } },
      { status: 422, code: "VALIDATION_FAILED" }
    );
    expect(refused.details).toMatchObject({ reason: "code_file_missing" });
  });
});
