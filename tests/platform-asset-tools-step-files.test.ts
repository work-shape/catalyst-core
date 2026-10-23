import { PLATFORM_TOOL_NAMES } from "@work-shape/catalyst-client-assembly";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ClientInstanceCapability } from "@work-shape/catalyst-client-assembly";
import {
  WORKFLOW_ASSET_KIND,
  asClientInstanceId,
  createPlatformId,
  defineProvider
} from "@work-shape/catalyst-core";
import {
  DETERMINISTIC_CAPABILITIES,
  isModelFunctionTool,
  modelContentText,
  type ModelAdapterFactory,
  type ModelCompletion,
  type ModelAdapterRequest
} from "@work-shape/catalyst-model-provider";
import {
  WORKFLOW_CODE_FILE_MAX_BYTES,
  WORKFLOW_STEP_FILES_MAX_BYTES
} from "@work-shape/catalyst-workflows";
import { drainRunEvents, injectStartConversationRun } from "./support/chat-server-run-harness";
import { createTestConfig } from "./support/fixtures";
import { createTestInstance, type TestInstance } from "./support/test-instance";

// The agent edits a Workflow that has a `code` step, on an assembled instance: the tools bound
// to the Workflow of its conversation read the step files with the definition, say of a config
// what a save of its files would be refused for, and save the files with the draft. Each
// test fails where a tool does not carry `files`: the read without the scripts, the check
// without the issues of a file, the save without the files or with a script that no step can
// run.
//
// A message to an instance is at most one megabyte, and the step files of a Workflow may be
// two. So the model of these tests writes the input of its call itself, as a model does: the
// message names the input the test holds for it, and the model sends that input to the tool.

const WORKFLOW = "double";
const OWNER = "owner";
const address = { kind: WORKFLOW_ASSET_KIND, name: WORKFLOW };

const script = (factor: number) =>
  `import json, sys\ndata = json.load(sys.stdin)\nprint(json.dumps({"result": data["number"] * ${factor}}))\n`;

/** A Workflow that hands a number to one script per file and returns what the first returned. */
const manifest = (files: readonly string[] = ["double.py"]) => ({
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
const good: StepFile = { path: "steps/double.py", content: script(2) };
const configOf = (files: readonly StepFile[] | undefined, steps?: readonly string[]) => ({
  name: WORKFLOW,
  manifest: manifest(steps),
  ...(files ? { files } : {})
});

const fileSchema = z.object({ path: z.string(), content: z.string() });
const readSchema = z.object({
  config: z.object({
    name: z.string(),
    manifest: z.object({ steps: z.array(z.unknown()) }).loose(),
    files: z.array(fileSchema).optional()
  }),
  revision: z.number(),
  publishedRevision: z.number().optional(),
  shows: z.string()
});
const issuesSchema = z.array(
  z.object({ path: z.string(), message: z.string(), code: z.string().optional() })
);
const checkSchema = z.object({ valid: z.boolean(), issues: issuesSchema });
const writeSchema = z.object({
  saved: z.boolean(),
  revision: z.number().optional(),
  issues: issuesSchema.optional(),
  conflict: z.string().optional()
});
const assetSchema = z.object({ revision: z.number(), publishedRevision: z.number().optional() });
const messagesSchema = z.object({
  items: z.array(z.object({ role: z.string(), text: z.string() }))
});

const WRITING_MODEL_PROVIDER = "writing-test";
const usage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  source: "not_reported" as const,
  webSearchCallCount: 0
};

/**
 * A model that makes the one tool call a message names, `/tool <name> <key>`, with the input
 * the test holds under the key, and ends its turn once the tool has answered.
 */
function createWritingModel(): {
  capability: ClientInstanceCapability;
  hold(input: unknown): string;
} {
  const held = new Map<string, unknown>();
  const answerOf = (request: ModelAdapterRequest): ModelCompletion => {
    const asked = request.messages.findLastIndex((message) => message.role === "user");
    const text = modelContentText(request.messages[asked]?.content ?? "");
    const [, toolName, key] = /^\/tool (\S+) (\S+)$/u.exec(text.trim()) ?? [];
    const answered = request.messages.slice(asked + 1).some((message) => message.role === "tool");
    const offered = request.tools.some(
      (tool) => isModelFunctionTool(tool) && tool.name === toolName
    );
    const calls =
      toolName === undefined || key === undefined || answered || !offered
        ? []
        : [{ toolCallId: createPlatformId("toolcall"), toolName, input: held.get(key) }];
    return { text: "Done.", toolCalls: calls, sources: [], citations: [], usage };
  };
  const provider = defineProvider({
    port: "models",
    type: WRITING_MODEL_PROVIDER,
    configSchema: z.object({}),
    external: false,
    create(): ModelAdapterFactory {
      return () => ({
        capabilities: () => DETERMINISTIC_CAPABILITIES,
        complete: (request) => Promise.resolve(answerOf(request)),
        async *stream(request) {
          await Promise.resolve();
          yield { type: "completed", completion: answerOf(request) };
        }
      });
    },
    // It runs in the test's own process: there is nothing to reach.
    check: () => Promise.resolve({ ok: true }),
    describe() {
      return {};
    }
  });
  return {
    capability: { name: "writing-model", providers: [provider], create: () => ({}) },
    hold(input) {
      const key = `input-${held.size}`;
      held.set(key, input);
      return key;
    }
  };
}

describe("a conversation about a Workflow with a code step", () => {
  let t: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => {
    t = await fixture();
  });
  beforeEach(async () => {
    await t.reset();
  });

  /** The instance, with the Workflow published at revision 1 with its one script. */
  async function fixture() {
    const config = createTestConfig({
      // The agent holds the platform's tools: its definition lists them.
      toolNames: [...PLATFORM_TOOL_NAMES],
      developmentAuth: {
        enabled: true,
        defaultUserId: OWNER,
        users: [
          {
            id: OWNER,
            externalUserId: OWNER,
            displayLabel: "Owner",
            roles: ["user", "admin", "superadmin"]
          }
        ]
      }
    });
    config.modules = { assetManagement: { enabled: true }, workflows: { enabled: true } };
    config.administration.agentConfiguration.enabled = true;
    const model = createWritingModel();
    config.infrastructure.models = { local: { provider: WRITING_MODEL_PROVIDER, model: "local" } };
    const app = await createTestInstance({
      config,
      env: {},
      capabilities: [model.capability],
      tools: []
    });
    await app.stores.apiAccess.createServicePrincipal({
      clientInstanceId: asClientInstanceId(config.clientInstance.id),
      displayLabel: "workflow-runner"
    });
    const ok = async (response: ReturnType<TestInstance["call"]>) => {
      const answered = await response;
      expect(answered.statusCode, answered.body).toBe(200);
      return answered;
    };
    const written = await ok(
      app.call("assets.put", {
        params: address,
        payload: { config: configOf([good]), expectedRevision: null }
      })
    );
    let published = assetSchema.parse(written.json()).revision;
    await ok(app.call("assets.publish", { params: address, payload: { revision: published } }));

    /**
     * One call of a tool by the agent, and what the tool answered. Each is made in a
     * conversation of its own about the Workflow, so a list of messages is one page and no
     * call carries the scripts of the calls before it.
     */
    const call = async (tool: string, input: unknown = {}): Promise<unknown> => {
      const created = await ok(
        app.call("conversations.create", { payload: { title: "Edit", subject: address } })
      );
      const { id } = z.object({ id: z.string() }).parse(created.json());
      const started = await injectStartConversationRun(
        app,
        id,
        `/tool ${tool} ${model.hold(input)}`
      );
      await drainRunEvents(app, id, started.run.id);
      const messages = messagesSchema.parse(
        (await app.call("conversations.messages.list", { params: { conversationId: id } })).json()
      );
      const answers = messages.items.filter((message) => message.role === "tool");
      expect(answers, tool).toHaveLength(1);
      const parsed: unknown = JSON.parse(answers[0]?.text ?? "null");
      return parsed;
    };
    const get = async () => readSchema.parse(await call("platform.assets.get"));
    const validate = async (candidate: unknown) =>
      checkSchema.parse(await call("platform.assets.validate", { config: candidate }));
    const put = async (candidate: unknown, expectedRevision: number) =>
      writeSchema.parse(await call("platform.assets.put", { config: candidate, expectedRevision }));
    const asset = async () =>
      assetSchema.parse((await ok(app.call("assets.get", { params: address }))).json());
    const storedFiles = async () =>
      z
        .object({ config: z.object({ files: z.array(fileSchema) }) })
        .parse((await ok(app.call("assets.get", { params: address }))).json()).config.files;
    const apiIssues = issuesSchema.element
      .extend({
        path: z
          .union([z.string(), z.array(z.union([z.string(), z.number()]))])
          .transform((path) => (typeof path === "string" ? path : path.join(".")))
      })
      .array();
    const validateApi = async (candidate: unknown) => {
      const checked = await ok(
        app.call("assets.validate", {
          params: { kind: WORKFLOW_ASSET_KIND },
          payload: { config: candidate }
        })
      );
      return checkSchema.extend({ issues: apiIssues }).parse(checked.json());
    };
    const putApi = async (candidate: unknown, expectedRevision: number) => {
      const response = await app.call("assets.put", {
        params: address,
        payload: { config: candidate, expectedRevision }
      });
      expect(response.statusCode, response.body).toBe(422);
      const { error } = z
        .object({ error: z.object({ details: z.object({ issues: apiIssues }) }) })
        .parse(response.json());
      return { saved: false, issues: error.details.issues };
    };
    const reset = async () => {
      const current = await asset();
      if (current.revision === published) return;
      const written = await ok(
        app.call("assets.put", {
          params: address,
          payload: { config: configOf([good]), expectedRevision: current.revision }
        })
      );
      published = assetSchema.parse(written.json()).revision;
      await ok(app.call("assets.publish", { params: address, payload: { revision: published } }));
    };
    return {
      get published() {
        return published;
      },
      reset,
      get,
      validate,
      put,
      validateApi,
      putApi,
      asset,
      storedFiles
    };
  }

  it("reads the scripts with the definition, and saves a changed and an added script as a draft a later read answers", async () => {
    const read = await t.get();
    expect(read).toMatchObject({ revision: t.published, shows: "published" });
    expect(read.config.files).toEqual([good]);

    // The agent changes the script of the step and adds a step with a script of its own.
    const changed = [
      { path: "steps/double.py", content: script(3) },
      { path: "steps/lib/more.mjs", content: "console.log(JSON.stringify({ result: 1 }));\n" }
    ];
    const next = configOf(changed, ["double.py", "lib/more.mjs"]);
    expect(await t.validate(next)).toEqual({ valid: true, issues: [] });
    expect(await t.put(next, read.revision)).toEqual({ saved: true, revision: t.published + 1 });

    const again = await t.get();
    expect(again).toMatchObject({
      revision: t.published + 1,
      publishedRevision: t.published,
      shows: "draft"
    });
    expect(again.config.files).toEqual(changed);
    expect(again.config.manifest.steps).toHaveLength(4);

    // A script of the largest size a save takes is stored whole, as the agent sent it.
    const largest = [
      { path: "steps/double.py", content: "#".repeat(WORKFLOW_CODE_FILE_MAX_BYTES) }
    ];
    expect(await t.put(configOf(largest), again.revision)).toEqual({
      saved: true,
      revision: t.published + 2
    });
    expect(await t.storedFiles()).toEqual(largest);
  }, 120_000);

  it("says of a config what a save of its files is refused for, each issue with its path and code, and saves none of them", async () => {
    const before = await t.asset();
    const filesBefore = await t.storedFiles();
    const other = { path: "steps/other.py", content: "" };
    const large = "#".repeat(WORKFLOW_CODE_FILE_MAX_BYTES + 1);
    const names = Array.from({ length: 9 }, (_, position) => `part${position}.py`);
    const full = "#".repeat(WORKFLOW_CODE_FILE_MAX_BYTES);
    expect(names.length * full.length).toBeGreaterThan(WORKFLOW_STEP_FILES_MAX_BYTES);
    const cases: [string, unknown, { path: string; code: string }[]][] = [
      // The config without `files`, and with none, while a step names a script.
      ["no files", configOf(undefined), [{ path: "steps.code0.file", code: "code_file_missing" }]],
      ["empty files", configOf([]), [{ path: "steps.code0.file", code: "code_file_missing" }]],
      // The step names another script than the config holds: both ends are told.
      [
        "another script",
        configOf([good], ["triple.py"]),
        [
          { path: "files[0].path", code: "code_file_unused" },
          { path: "steps.code0.file", code: "code_file_missing" }
        ]
      ],
      ["unused", configOf([good, other]), [{ path: "files[1].path", code: "code_file_unused" }]],
      // A path outside the folder, one that leaves it, and a file that is no script.
      ...["double.py", "/steps/double.py", "steps/../double.py", "steps/notes.md"].map(
        (path): [string, unknown, { path: string; code: string }[]] => [
          path,
          configOf([good, { path, content: "" }]),
          [{ path: "files[1].path", code: "code_file_invalid" }]
        ]
      ),
      ["twice", configOf([good, good]), [{ path: "files[1].path", code: "code_file_invalid" }]],
      [
        "one too large",
        configOf([{ ...good, content: large }]),
        [{ path: "steps.code0.file", code: "code_file_too_large" }]
      ],
      [
        "too large together",
        configOf(
          names.map((name) => ({ path: `steps/${name}`, content: full })),
          names
        ),
        [{ path: "files", code: "code_files_too_large" }]
      ]
    ];
    for (const [title, candidate, issues] of cases) {
      // The aggregate byte case exceeds the HTTP body bound. Keep it and the mismatched
      // script on the agent path; the remaining validation matrix calls the API directly.
      const agentPath = title === "another script" || title === "too large together";
      const checked = await (agentPath ? t.validate : t.validateApi)(candidate);
      expect(checked.valid, title).toBe(false);
      expect(
        checked.issues.map(({ path, code }) => ({ path, code })),
        title
      ).toEqual(issues);
      for (const issue of checked.issues) expect(issue.message, title).not.toBe("");
      // A save is refused for what the check said, and stores nothing.
      const refused = await (agentPath ? t.put : t.putApi)(candidate, before.revision);
      expect(refused.saved, title).toBe(false);
      expect(refused.issues, title).toEqual(checked.issues);
    }
    // A file that is no pair of a path and a text is refused by the shape of the config.
    const shapeless = { ...configOf([good]), files: [{ path: "steps/double.py" }] };
    const shape = await t.validate(shapeless);
    expect(shape.valid).toBe(false);
    expect(shape.issues[0]?.path).toBe("files.0.content");
    expect((await t.put(shapeless, before.revision)).saved).toBe(false);

    expect(await t.asset()).toEqual(before);
    expect((await t.get()).config.files).toEqual(filesBefore);
  }, 240_000);
});
