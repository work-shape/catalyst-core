import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  asClientInstanceId,
  createPlatformId,
  defineProvider,
  type JsonObject,
  type JsonValue,
  type WorkflowDatasetReference,
  type WorkflowRunId
} from "@work-shape/catalyst-core";
import {
  DETERMINISTIC_CAPABILITIES,
  modelContentText,
  type ModelAdapterFactory,
  type ModelAdapterRequest,
  type ModelCompletion
} from "@work-shape/catalyst-model-provider";
import {
  AGENT_WORKSPACE_TOOL_NAMES,
  agentWorkspaceInput,
  parseWorkflowManifest,
  storeAgentOutputDatasets,
  workflowAgentToolNames,
  WorkflowStepFailure
} from "@work-shape/catalyst-workflows";
import {
  createTestInstance,
  getTestConfig,
  getTestJobs,
  type TestInstance
} from "./support/test-instance";
import { createTestConfig } from "./support/fixtures";
import { required, waitUntil } from "./support/assertions";

// An agent step with `workspace: true` (events-workflows-and-guardrails.md, An agent step with a
// workspace): its input reaches the agent as files, and a dataset of its answer is the path of
// a JSON Lines file it wrote, which the engine stores as the step's dataset.

const row = { type: "object", properties: { name: { type: "string" } }, required: ["name"] };
const longText = "Line of a long contract.\n".repeat(120);
const dataset = (id: string, rowCount: number): WorkflowDatasetReference => ({
  $dataset: id,
  rowCount,
  bytes: 10 * rowCount
});

describe("an agent step's input as files", () => {
  it("names a long text and a dataset by path, and the task holds neither", () => {
    const staged = agentWorkspaceInput({
      body: longText,
      short: "kept inline",
      rows: dataset("ds_one", 3)
    });
    expect(staged.files).toEqual([
      { path: "in/body.txt", kind: "text", text: longText },
      { path: "in/rows.jsonl", kind: "dataset", reference: dataset("ds_one", 3) }
    ]);
    expect(staged.task).toEqual({
      body: { path: "in/body.txt", chars: longText.length },
      short: "kept inline",
      rows: { path: "in/rows.jsonl", rowCount: 3 }
    });
    expect(staged.inputJson.body).toBe(longText);
  });

  it("gives the workspace tools only to a step with a workspace", () => {
    const tools = ["connection.crm.read", "workspace.exec"];
    expect(workflowAgentToolNames(tools, {})).toEqual(["connection.crm.read"]);
    expect(workflowAgentToolNames(tools, { workspace: true })).toEqual([
      "connection.crm.read",
      ...AGENT_WORKSPACE_TOOL_NAMES
    ]);
  });
});

describe("an agent step's dataset answer", () => {
  const outputSchema = {
    type: "object",
    properties: { rows: { type: "dataset", row }, count: { type: "integer" } }
  };
  const stored = async (files: Record<string, string>, value: JsonValue) => {
    const rows: unknown[] = [];
    const output = await storeAgentOutputDatasets({
      value,
      outputSchema,
      types: undefined,
      read: (path) =>
        Promise.resolve(
          files[path] === undefined ? undefined : new TextEncoder().encode(files[path])
        ),
      rowBytes: 1024,
      store: async (input) => {
        for await (const item of input.rows) rows.push(item);
        return dataset("ds_out", rows.length);
      }
    });
    return { output, rows };
  };

  it("stores the rows of the file it names, and refuses a path to no file", async () => {
    const { output, rows } = await stored(
      { "out/rows.jsonl": '{"name":"Ada"}\n{"name":"Ben"}\n' },
      { rows: { path: "/workspace/out/rows.jsonl" }, count: 2 }
    );
    expect(rows).toEqual([{ name: "Ada" }, { name: "Ben" }]);
    expect(output).toEqual({ rows: dataset("ds_out", 2), count: 2 });
    await expect(stored({}, { rows: { path: "out/none.jsonl" }, count: 0 })).rejects.toThrow(
      WorkflowStepFailure
    );
  });
});

describe("an agent step's definition", () => {
  const refusedCodes = (step: JsonObject) => {
    const result = parseWorkflowManifest({
      id: "sample",
      name: "Sample",
      runAs: "sample-runner",
      inputs: { type: "object" },
      outputs: { type: "object" },
      steps: [
        { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
        {
          id: "check",
          name: "Check",
          type: "agent",
          instructions: "check.md",
          input: {},
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          ...step
        },
        { id: "result", name: "Result", type: "output", input: {} }
      ]
    });
    return result.ok ? [] : result.issues.map((issue) => issue.code ?? issue.message);
  };

  it("takes a dataset in its input or answer only with a workspace", () => {
    const withDatasets = {
      inputSchema: { type: "object", properties: { rows: { type: "dataset", row } } },
      outputSchema: { type: "object", properties: { rows: { type: "dataset", row } } }
    };
    expect(refusedCodes(withDatasets)).not.toEqual([]);
    expect(refusedCodes({ ...withDatasets, workspace: true })).toEqual([]);
  });
});

// The whole way through an instance: the worker puts the input in the thread's workspace, the
// agent reads it with its workspace tools and writes its rows, and the engine stores them.
describe("an agent step with a workspace in an instance", () => {
  const roots: string[] = [];
  let app: TestInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("reads its input from files and answers a dataset by the path of its file", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-step-workspace-"));
    roots.push(root);
    const requests: ModelAdapterRequest[] = [];
    const call = (toolName: string, input: JsonObject): ModelCompletion => ({
      ...completion(""),
      toolCalls: [{ toolCallId: createPlatformId("toolcall"), toolName, input }]
    });
    const answer = (request: ModelAdapterRequest): ModelCompletion => {
      requests.push(request);
      const results = request.messages.filter((message) => message.role === "tool").length;
      if (results === 0) return call("workspace.read_file", { path: "in/body.txt" });
      if (results === 1)
        return call("workspace.write_file", {
          path: "out/rows.jsonl",
          content: '{"name":"Ada"}\n{"name":"Ben"}\n'
        });
      return completion('{"rows":{"path":"out/rows.jsonl"},"count":2}');
    };
    const provider = defineProvider({
      port: "models",
      type: "workspace-scripted",
      external: false,
      configSchema: z.object({}),
      create(): ModelAdapterFactory {
        return () => ({
          capabilities: () => ({ ...DETERMINISTIC_CAPABILITIES, streaming: false }),
          complete: async (request) => answer(request),
          async *stream(request) {
            yield { type: "completed", completion: answer(request) };
          }
        });
      },
      check: async () => ({ ok: true }),
      describe: () => ({})
    });
    const config = createTestConfig({
      executionWorkspaces: { enabled: true },
      workspaceObjectRoot: join(root, "workspaces"),
      // An instance enables the workspace tools its agents may get, a step's among them.
      tools: AGENT_WORKSPACE_TOOL_NAMES.map((name) => ({ name, enabled: true }))
    });
    config.infrastructure.objectStorage.files = {
      provider: "filesystem",
      root: join(root, "files")
    };
    config.infrastructure.models = { local: { provider: "workspace-scripted", model: "local" } };
    config.modules = {
      ...config.modules,
      workflows: { enabled: true },
      assetManagement: { enabled: true }
    };
    app = await createTestInstance({
      config,
      env: {},
      tools: [],
      capabilities: [{ name: "workspace-model", providers: [provider], create: () => ({}) }]
    });
    const clientInstanceId = asClientInstanceId(getTestConfig(app).clientInstance.id);
    await app.stores.apiAccess.createServicePrincipal({
      clientInstanceId,
      name: "workflow-runner",
      displayLabel: "Workflow account"
    });
    const manifest = {
      id: "agent-rows",
      name: "Rows from a text",
      runAs: "workflow-runner",
      inputs: { type: "object", properties: { text: { type: "string" } } },
      outputs: { type: "object" },
      steps: [
        { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
        {
          id: "analyse",
          name: "Analyse",
          type: "agent",
          workspace: true,
          instructions: "List the names in the text.",
          inputSchema: { type: "object", properties: { body: { type: "string" } } },
          outputSchema: {
            type: "object",
            properties: { rows: { type: "dataset", row }, count: { type: "integer" } },
            required: ["rows", "count"],
            additionalProperties: false
          },
          input: { body: { ref: { step: "start", path: "input.text" } } }
        },
        {
          id: "result",
          name: "Result",
          type: "output",
          input: { count: { ref: { step: "analyse", path: "count" } } }
        }
      ]
    };
    const address = { kind: "workflow", name: manifest.id };
    const put = await app.call("assets.put", {
      params: address,
      payload: { expectedRevision: null, config: { name: manifest.id, manifest } }
    });
    expect(put.statusCode, put.body).toBe(200);
    const published = await app.call("assets.publish", {
      params: address,
      payload: { revision: put.json<{ revision: number }>().revision }
    });
    expect(published.statusCode, published.body).toBe(200);
    const started = await app.call("workflows.start", {
      params: { workflow: manifest.id },
      payload: { input: { text: longText } }
    });
    expect(started.statusCode, started.body).toBe(200);
    const runId = started.json<{ id: WorkflowRunId }>().id;
    getTestJobs(app).start();
    const instance = app;
    await waitUntil(async () => {
      const run = await instance.stores.workflowRuns.readRun({ clientInstanceId, id: runId });
      return run?.status === "done" || run?.status === "failed";
    }, "Workflow ended");
    const run = required(await app.stores.workflowRuns.readRun({ clientInstanceId, id: runId }));
    expect(run.status, JSON.stringify(run)).toBe("done");

    const first = required(requests[0]);
    const task = first.messages
      .filter((message) => message.role === "user")
      .map((message) => modelContentText(message.content))
      .join("\n");
    expect(task).toContain('"path":"in/body.txt"');
    expect(task).not.toContain("Line of a long contract.");
    expect(first.tools.map((tool) => ("name" in tool ? tool.name : ""))).toEqual(
      expect.arrayContaining([...AGENT_WORKSPACE_TOOL_NAMES])
    );
    // The file it read holds the text the run started with.
    const read = required(requests[1]).messages.find((message) => message.role === "tool");
    expect(modelContentText(required(read).content)).toContain("Line of a long contract.");

    const output = required(
      await app.stores.workflowRuns.findStepOutput({ clientInstanceId, runId, stepId: "analyse" })
    );
    expect(output.value).toMatchObject({ count: 2, rows: { rowCount: 2 } });
    expect(JSON.stringify(output.value)).toContain("$dataset");
  });
});

function completion(text: string): ModelCompletion {
  return {
    text,
    toolCalls: [],
    sources: [],
    citations: [],
    usage: {
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
      source: "provider_reported",
      webSearchCallCount: 0
    }
  };
}
