import { PLATFORM_TOOL_NAMES } from "@work-shape/catalyst-client-assembly";
import {
  WORKFLOW_ASSET_KIND,
  asClientInstanceId,
  type AgentEditableField,
  type ClientInstanceId,
  type CentralPolicySetting
} from "@work-shape/catalyst-core";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect } from "vitest";
import { z } from "zod";
import { drainRunEvents, injectStartConversationRun } from "./chat-server-run-harness";
import { waitUntil } from "./assertions";
import { createTestConfig } from "./fixtures";
import { fileTestDatabaseUrl } from "./test-database";
import { killTestProcess, startTestProcess } from "./test-process";
import { withTestSql } from "./test-sql";
import { createTestInstance, type TestInstance } from "./test-instance";

const processes: ChildProcess[] = [];
const directories: string[] = [];
// Stop child workers before test-instance closes the API and resets the file database.
afterEach(async () => {
  for (const child of processes.splice(0)) await killTestProcess(child);
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

export const WORKFLOW = "month-end";
const OWNER = "owner";
export const OTHER = "other";
export const subject = { kind: WORKFLOW_ASSET_KIND, name: WORKFLOW };
const address = subject;

const ref = (step: string, path: string) => ({ ref: { step, path } });
export const trigger = {
  id: "start",
  name: "Start by hand",
  type: "trigger",
  triggers: [{ kind: "manual" }]
};
export const result = {
  id: "result",
  name: "Result",
  type: "output",
  input: { note: ref("start", "input.note") }
};
/** The definition as it is published, and as the agent changes it: its steps between the two. */
export const manifest = (steps: unknown[] = []) => ({
  id: WORKFLOW,
  name: "Month end",
  runAs: "workflow-runner",
  inputs: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
  outputs: { type: "object" },
  steps: [trigger, ...steps, result]
});
export const configOf = (steps: unknown[] = []) => ({ name: WORKFLOW, manifest: manifest(steps) });
/** A step the engine of this release does not run, and the one the agent writes after it. */
export const notRun = {
  id: "ask",
  name: "Ask the agent",
  type: "agent",
  instructions: "check.md",
  input: {},
  inputSchema: { type: "object" },
  outputSchema: { type: "object" }
};
export const added = {
  id: "books",
  name: "Read the books",
  type: "operation",
  operation: "connection.books.read",
  input: { month: ref("start", "input.note") }
};

export const readSchema = z.object({
  config: z.object({
    name: z.string(),
    manifest: z.object({ steps: z.array(z.unknown()) }).loose()
  }),
  revision: z.number(),
  publishedRevision: z.number().optional(),
  shows: z.string()
});
export const issuesSchema = z.array(
  z.object({ path: z.string(), message: z.string(), code: z.string().optional() })
);
export const writeSchema = z.object({
  saved: z.boolean(),
  revision: z.number().optional(),
  issues: issuesSchema.optional(),
  conflict: z.string().optional()
});
const assetSchema = z.object({
  revision: z.number(),
  publishedRevision: z.number().optional()
});
export const runSchema = z.object({
  id: z.string(),
  status: z.string(),
  definitionRevisionId: z.string()
});
export const subjectSchema = z.object({ kind: z.string(), name: z.string() });
const messagesSchema = z.object({
  items: z.array(z.object({ role: z.string(), text: z.string() }))
});

/** A bound on a hang: the worker process starts through the TypeScript loader. */
const WORKER_STARTED_WITHIN_MS = 120_000;

interface AssetToolsFixture {
  app: TestInstance;
  clientInstanceId: ClientInstanceId;
  published: number;
  ok(response: ReturnType<TestInstance["call"]>): ReturnType<TestInstance["call"]>;
  converse(about: typeof subject | undefined, as?: string): ReturnType<TestInstance["call"]>;
  say(
    conversationId: string,
    text: string,
    as?: string
  ): Promise<{ events: string; answer: string | undefined }>;
  call(conversationId: string, tool: string, input?: unknown): Promise<unknown>;
  asset(): Promise<z.infer<typeof assetSchema>>;
  publishedRevisionId(): Promise<string | undefined>;
}

/**
 * The instance. With `separate` its agent runs execute in an agent-run worker that is a
 * process of its own, started from the same config as an operated instance starts one.
 * `editableAgentFields` are the fields of an agent a person may change outside a release.
 * `filesStore` gives the instance a store of files, as an operated instance has, without which
 * the retention job does not retry unfinished cleanups.
 */
export async function createAssetToolsFixture(
  agentRuns: "in_process" | "separate" = "in_process",
  editableAgentFields: AgentEditableField[] = [],
  {
    filesStore = false,
    publishTool = false,
    skillTool = false,
    centralPolicySettings
  }: {
    filesStore?: boolean;
    publishTool?: boolean;
    /** The release names `read_skill` and the agent lists it, for a skill the agent holds. */
    skillTool?: boolean;
    centralPolicySettings?: () => CentralPolicySetting[];
  } = {}
): Promise<AssetToolsFixture> {
  // No release names `read_skill` here: the skill of a subject is readable all the same.
  const config = createTestConfig({
    // The agent holds the platform's tools: its definition lists them.
    toolNames: [
      ...PLATFORM_TOOL_NAMES,
      ...(publishTool ? ["assets.publish"] : []),
      ...(skillTool ? ["read_skill"] : [])
    ],
    ...(skillTool ? { tools: [{ name: "read_skill", enabled: true }] } : {}),
    developmentAuth: {
      enabled: true,
      defaultUserId: OWNER,
      users: [
        {
          id: OWNER,
          externalUserId: OWNER,
          displayLabel: "Owner",
          roles: ["user", "admin", "superadmin"]
        },
        { id: OTHER, externalUserId: OTHER, displayLabel: "Other", roles: ["user"] }
      ]
    }
  });
  config.modules = {
    assetManagement: { enabled: true },
    workflows: { enabled: true },
    ...(publishTool ? { apps: { enabled: true } } : {})
  };
  if (publishTool) config.executionWorkspaces.enabled = true;
  config.administration.agentConfiguration.enabled = true;
  config.administration.agentConfiguration.allowSkillEditing = true;
  config.administration.agentConfiguration.editableAgentFields = editableAgentFields;
  if (filesStore) {
    const root = await mkdtemp(join(tmpdir(), "catalyst-asset-tools-files-"));
    directories.push(root);
    config.infrastructure.objectStorage.files = { provider: "filesystem", root };
    if (publishTool)
      config.infrastructure.objectStorage.workspaces = {
        provider: "filesystem",
        root: join(root, "workspaces")
      };
  }
  const app = await createTestInstance({
    config,
    ...(centralPolicySettings ? { operations: { centralPolicySettings } } : {}),
    env: publishTool
      ? { CHAT_SESSION_TOKEN_SECRET: "workflow-publish-test-session-key-32-characters" }
      : {},
    tools: [],
    ...(agentRuns === "separate" ? { agentRunWorker: "separate" as const } : {})
  });
  const clientInstanceId = asClientInstanceId(config.clientInstance.id);
  if (agentRuns === "separate") {
    const directory = await mkdtemp(join(tmpdir(), "catalyst-agent-worker-"));
    directories.push(directory);
    const configPath = join(directory, "app.yaml");
    // JSON is YAML.
    await writeFile(configPath, JSON.stringify(config));
    const applicationName = "asset_tools_agent_worker";
    const url = new URL(await fileTestDatabaseUrl());
    url.searchParams.set("application_name", applicationName);
    const child = startTestProcess(new URL("./instance-process.ts", import.meta.url), {
      args: ["agent-run-worker", "without-capability"],
      env: {
        PATH: process.env.PATH,
        CLIENT_CONFIG_PATH: configPath,
        DATABASE_URL: url.toString()
      },
      stdio: ["ignore", "ignore", "inherit"]
    });
    processes.push(child);
    let ended = false;
    child.once("exit", () => {
      ended = true;
    });
    await waitUntil(
      async () => {
        if (ended) throw new Error("The agent-run worker ended while it started");
        const asking = await withTestSql(
          (sql) => sql`
            select 1 from pg_stat_activity
            where application_name = ${applicationName} and query like '%platform_jobs%'`
        );
        return asking.length > 0;
      },
      "the agent-run worker has asked for its jobs",
      WORKER_STARTED_WITHIN_MS
    );
  }
  await app.stores.apiAccess.createServicePrincipal({
    clientInstanceId,
    displayLabel: "workflow-runner"
  });
  const ok = async (response: ReturnType<TestInstance["call"]>) => {
    const answered = await response;
    expect(answered.statusCode, answered.body).toBe(200);
    return answered;
  };
  // The owner writes the Workflow and publishes it: revision 1 is what runs.
  const written = await ok(
    app.call("assets.put", {
      params: address,
      payload: { config: configOf(), expectedRevision: null }
    })
  );
  const { revision: published } = assetSchema.parse(written.json());
  await ok(app.call("assets.publish", { params: address, payload: { revision: published } }));

  const converse = async (about: typeof subject | undefined, as?: string) =>
    app.call(
      "conversations.create",
      { payload: { title: "Edit", ...(about ? { subject: about } : {}) } },
      as
    );
  /** One message to the agent, and what the tool it named answered. */
  const say = async (conversationId: string, text: string, as?: string) => {
    const headers = as === undefined ? undefined : { "x-dev-user-id": as };
    const started = await injectStartConversationRun(app, conversationId, text, { headers });
    const events = await drainRunEvents(app, conversationId, started.run.id, { headers });
    const messages = messagesSchema.parse(
      (await app.call("conversations.messages.list", { params: { conversationId } }, as)).json()
    );
    const answers = messages.items.filter((message) => message.role === "tool");
    return { events, answer: answers.at(-1)?.text };
  };
  const call = async (conversationId: string, tool: string, input: unknown = {}) => {
    const { answer } = await say(conversationId, `/tool ${tool} ${JSON.stringify(input)}`);
    const parsed: unknown = JSON.parse(answer ?? "null");
    return parsed;
  };
  const asset = async () =>
    assetSchema.parse((await ok(app.call("assets.get", { params: address }))).json());
  const publishedRevisionId = async () =>
    (await app.stores.configAssets.getConfigAsset({ clientInstanceId, ...address }))
      ?.publishedRevisionId;
  return {
    app,
    clientInstanceId,
    published,
    ok,
    converse,
    say,
    call,
    asset,
    publishedRevisionId
  };
}
