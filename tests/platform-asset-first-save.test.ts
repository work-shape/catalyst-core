import { PLATFORM_TOOL_NAMES } from "@vivd-catalyst/client-assembly";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DATA_STORE_ASSET_KIND,
  DATA_STORE_MANIFEST_FILE,
  WORKFLOW_ASSET_KIND,
  asClientInstanceId
} from "@vivd-catalyst/core";
import { drainRunEvents, injectStartConversationRun } from "./support/chat-server-run-harness";
import { createTestConfig } from "./support/fixtures";
import { createTestInstance, type TestInstance } from "./support/test-instance";

// The agent's first save of a conversation about no asset creates the asset and makes it the
// subject (NAV-2, navigation check 36, Platform Access check 44), through the same write as
// `assets.put` on the API and the CLI. The model is the scripted one of the tests, which makes
// the one tool call each message names. Each case fails without the change: a save in a
// conversation about nothing was refused. Agents and skills are in
// `workspace-owned-assets.test.ts`, the policy on `assets.put` in
// `platform-asset-tools-policy.test.ts`.

const OWNER = "owner";
const OTHER = "other";
/** The variable of the Secret Store's key, for an instance with Data Stores. */
const DATA_STORE_KEY = "FIRST_SAVE_DATA_STORE_KEY";

const trigger = {
  id: "start",
  name: "Start by hand",
  type: "trigger",
  triggers: [{ kind: "manual" }]
};
const result = { id: "result", name: "Result", type: "output", input: {} };
const added = {
  id: "books",
  name: "Read the books",
  type: "operation",
  operation: "connection.books.read",
  input: { month: { ref: { step: "start", path: "input.note" } } }
};
const manifest = () => ({
  id: "unnamed",
  name: "Unnamed",
  runAs: "workflow-runner",
  inputs: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
  outputs: { type: "object" },
  steps: [trigger, result]
});

const issuesSchema = z.array(
  z.object({ path: z.string(), message: z.string(), code: z.string().optional() })
);
const writeSchema = z.object({
  saved: z.boolean(),
  revision: z.number().optional(),
  issues: issuesSchema.optional(),
  conflict: z.string().optional()
});
const subjectSchema = z.object({ kind: z.string(), name: z.string() });
const messagesSchema = z.object({
  items: z.array(z.object({ role: z.string(), text: z.string() }))
});

describe("the agent's first save of a conversation", () => {
  let open: TestInstance | undefined;
  const directories: string[] = [];
  afterEach(async () => {
    await open?.close();
    open = undefined;
    for (const directory of directories.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  async function fixture(further: { dataStores?: true } = {}) {
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
          },
          { id: OTHER, externalUserId: OTHER, displayLabel: "Other", roles: ["user"] }
        ]
      }
    });
    config.modules = {
      assetManagement: { enabled: true },
      workflows: { enabled: true },
      ...(further.dataStores ? { dataStores: { enabled: true } } : {})
    };
    const env: Record<string, string> = {};
    if (further.dataStores) {
      // A Data Store keeps its role passwords in the Secret Store and its files in storage.
      const root = await mkdtemp(join(tmpdir(), "catalyst-first-save-"));
      directories.push(root);
      config.secretStore = { keys: [{ id: "k1", ref: DATA_STORE_KEY }] };
      env[DATA_STORE_KEY] = randomBytes(32).toString("base64");
      config.infrastructure.objectStorage = {
        ...config.infrastructure.objectStorage,
        files: { provider: "filesystem", root }
      };
    }
    config.administration.agentConfiguration.enabled = true;
    const app = await createTestInstance({ config, env, tools: [] });
    open = app;
    const clientInstanceId = asClientInstanceId(config.clientInstance.id);
    await app.stores.apiAccess.createServicePrincipal({
      clientInstanceId,
      displayLabel: "workflow-runner"
    });
    const ok = async (response: ReturnType<TestInstance["call"]>) => {
      const answered = await response;
      expect(answered.statusCode, answered.body).toBe(200);
      return answered;
    };
    const converse = async (as?: string) =>
      app.call("conversations.create", { payload: { title: "New" } }, as);
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
    return { app, clientInstanceId, ok, converse, say, call };
  }

  it("creates a new Workflow of the instance as a draft with its first save and makes it the subject", async () => {
    const t = await fixture();
    const { id } = z.object({ id: z.string() }).parse((await t.ok(t.converse())).json());
    const NEW = "new-close";
    const config = { name: NEW, manifest: { ...manifest(), id: NEW, name: "New close" } };

    // Named by kind and name, with no revision: the first save creates it.
    const created = z
      .object({
        saved: z.literal(true),
        revision: z.number(),
        created: z.literal(true),
        kind: z.string(),
        name: z.string(),
        title: z.string()
      })
      .parse(
        await t.call(id, "platform.assets.put", { kind: WORKFLOW_ASSET_KIND, name: NEW, config })
      );
    expect(created).toMatchObject({ revision: 1, kind: WORKFLOW_ASSET_KIND, name: NEW });
    const thread = z
      .object({ conversation: z.object({ subject: subjectSchema.optional() }) })
      .parse(
        (
          await t.ok(t.app.call("conversations.thread.get", { params: { conversationId: id } }))
        ).json()
      );
    expect(thread.conversation.subject).toEqual({ kind: WORKFLOW_ASSET_KIND, name: NEW });

    // A draft of the instance that nobody published: it runs nothing.
    const stored = await t.app.stores.configAssets.getConfigAsset({
      clientInstanceId: t.clientInstanceId,
      kind: WORKFLOW_ASSET_KIND,
      name: NEW
    });
    expect(stored?.scope).toEqual({ kind: "instance" });
    expect(stored?.publishedRevisionId).toBeUndefined();

    // The next save is a save of the subject, against the revision the first one made.
    const next = writeSchema.parse(
      await t.call(id, "platform.assets.put", {
        config: { ...config, manifest: { ...config.manifest, steps: [trigger, added, result] } },
        expectedRevision: created.revision
      })
    );
    expect(next).toEqual({ saved: true, revision: created.revision + 1 });

    // A second first save in a conversation about an asset makes nothing.
    const second = await t.say(
      id,
      `/tool platform.assets.put ${JSON.stringify({ kind: WORKFLOW_ASSET_KIND, name: "other-close", config: { ...config, name: "other-close" } })}`
    );
    expect(second.answer).toContain("A new asset is made in a conversation about none");
    // Nor does a save that names no kind it may create.
    const { id: fresh } = z.object({ id: z.string() }).parse((await t.ok(t.converse())).json());
    const unnamed = await t.say(fresh, `/tool platform.assets.put ${JSON.stringify({ config })}`);
    expect(unnamed.answer).toContain("A first save creates an asset");
    for (const name of ["other-close"]) {
      expect(
        await t.app.stores.configAssets.getConfigAsset({
          clientInstanceId: t.clientInstanceId,
          kind: WORKFLOW_ASSET_KIND,
          name
        })
      ).toBeUndefined();
    }

    // The person who may not write a Workflow creates none.
    const { id: theirs } = z
      .object({ id: z.string() })
      .parse((await t.ok(t.converse(OTHER))).json());
    const refused = await t.say(
      theirs,
      `/tool platform.assets.put ${JSON.stringify({ kind: WORKFLOW_ASSET_KIND, name: "theirs", config: { ...config, name: "theirs" } })}`,
      OTHER
    );
    expect(refused.answer).not.toContain('"saved":true');
    expect(
      await t.app.stores.configAssets.getConfigAsset({
        clientInstanceId: t.clientInstanceId,
        kind: WORKFLOW_ASSET_KIND,
        name: "theirs"
      })
    ).toBeUndefined();
  }, 120_000);

  it("creates a Data Store from its files with the check of the files write the CLI uses", async () => {
    const t = await fixture({ dataStores: true });
    const { id, collaborationWorkspaceId } = z
      .object({ id: z.string(), collaborationWorkspaceId: z.string() })
      .parse((await t.ok(t.converse())).json());
    const manifestFile = { path: DATA_STORE_MANIFEST_FILE, text: "id: leads\nname: Leads\n" };
    const migration = {
      path: "migrations/0001_init.sql",
      text: "create table leads (name text not null);"
    };
    const stray = { path: "notes.txt", text: "not a file of a store" };

    // What the API refuses for these files, the agent's first save refuses with the same words.
    const throughApi = await t.app.call("assets.put", {
      params: { kind: DATA_STORE_ASSET_KIND, name: "leads" },
      payload: { files: [manifestFile, migration, stray], expectedRevision: null }
    });
    expect(throughApi.statusCode).toBe(422);
    const apiIssues = z
      .object({
        error: z.object({
          details: z.object({ issues: z.array(z.object({ message: z.string() })) })
        })
      })
      .parse(throughApi.json())
      .error.details.issues.map((issue) => issue.message);
    const refused = writeSchema.parse(
      await t.call(id, "platform.assets.put", {
        kind: DATA_STORE_ASSET_KIND,
        name: "leads",
        files: [manifestFile, migration, stray]
      })
    );
    expect(refused.saved).toBe(false);
    expect(refused.issues?.map((issue) => issue.message)).toEqual(apiIssues);

    const created = await t.call(id, "platform.assets.put", {
      kind: DATA_STORE_ASSET_KIND,
      name: "leads",
      files: [manifestFile, migration]
    });
    expect(created).toMatchObject({
      saved: true,
      revision: 1,
      created: true,
      kind: DATA_STORE_ASSET_KIND,
      name: "leads"
    });
    const stored = await t.app.stores.configAssets.getConfigAsset({
      clientInstanceId: t.clientInstanceId,
      kind: DATA_STORE_ASSET_KIND,
      name: "leads"
    });
    // A Data Store may be owned by a workspace: the conversation's owns it (WS-OWN-1a).
    expect(stored?.scope).toEqual({ kind: "workspace", workspaceId: collaborationWorkspaceId });
    expect(stored?.publishedRevisionId).toBeUndefined();
  }, 120_000);
});
