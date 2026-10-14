import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  WORKFLOW_ASSET_KIND,
  asClientInstanceId,
  asCollaborationWorkspaceId,
  asConversationId,
  asManagedArtifactId,
  asMessageId,
  asUserId,
  createFileSetId
} from "@vivd-catalyst/core";
import { createPlatformDiscoveryTools } from "@vivd-catalyst/tool-execution";
import { drainRunEvents, injectStartConversationRun } from "./support/chat-server-run-harness";
import { createTestConfig } from "./support/fixtures";
import { createTestInstance, type TestInstance } from "./support/test-instance";
import { claimAttachmentsForStoredMessage } from "./support/test-store";

// Every agent, in every conversation, finds what is on the platform with two tools and reads
// how the platform works in one shipped skill. The tools answer with the rights of the person
// the agent acts for: an asset that person may not read is answered as one that does not
// exist. The model is the scripted one of the tests, which makes the one tool call each
// message names. Each test fails without the change: no agent could list the platform's
// assets, and a conversation about nothing was offered no tool and no skill of the platform.

const OWNER = "owner";
const MEMBER = "member";
const WORKFLOW = "month-end";

const contextSchema = z.object({
  instance: z.object({ name: z.string() }),
  modules: z.array(z.string()),
  kinds: z.array(z.object({ kind: z.string(), plural: z.string(), hasDraft: z.boolean() })),
  actions: z.array(z.string()),
  assetActions: z.array(z.string()),
  namespaces: z.array(z.unknown())
});
const foundSchema = z.object({
  assets: z.array(
    z.object({
      kind: z.string(),
      name: z.string(),
      title: z.string(),
      description: z.string().optional()
    })
  ),
  truncated: z.boolean()
});
const conversationSchema = z.object({
  id: z.string(),
  title: z.string(),
  collaborationWorkspaceId: z.string(),
  createdByUserId: z.string()
});
const fileSchema = z.object({
  kind: z.string(),
  id: z.string(),
  name: z.string(),
  mimeType: z.string().optional(),
  bytes: z.number(),
  updatedAt: z.string(),
  conversation: z.object({ id: z.string(), title: z.string() }),
  inThisConversation: z.literal(true).optional()
});
const filesSchema = z.object({ files: z.array(fileSchema), truncated: z.boolean() });
const workspaceFilesSchema = z.object({
  items: z.array(fileSchema),
  nextCursor: z.string().optional()
});
const messagesSchema = z.object({
  items: z.array(z.object({ role: z.string(), text: z.string() }))
});

/** A Workflow as small as a save takes one. */
const workflowConfig = {
  name: WORKFLOW,
  manifest: {
    id: WORKFLOW,
    name: "Month-end closing",
    description: "Closes the books at the end of each month.",
    runAs: "workflow-runner",
    inputs: { type: "object" },
    outputs: { type: "object" },
    steps: [
      { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
      { id: "result", name: "Result", type: "output", input: {} }
    ]
  }
};

describe("the tools that find what is on the platform", () => {
  let open: TestInstance | undefined;
  const roots: string[] = [];
  afterEach(async () => {
    await open?.close();
    open = undefined;
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  async function fixture(workflows: boolean, pages = false) {
    const config = createTestConfig({
      // A Page is saved from an Execution Workspace, so Pages need them.
      executionWorkspaces: { enabled: pages },
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
          { id: MEMBER, externalUserId: MEMBER, displayLabel: "Member", roles: ["user"] }
        ]
      }
    });
    config.modules = {
      assetManagement: { enabled: true },
      workflows: { enabled: workflows },
      apps: { enabled: pages }
    };
    if (pages) {
      // Pages keep their files in the object store, and what serves one is signed with a key
      // from the secret.
      const root = await mkdtemp(join(tmpdir(), "platform-discovery-"));
      roots.push(root);
      config.infrastructure.objectStorage = {
        ...config.infrastructure.objectStorage,
        files: { provider: "filesystem", root }
      };
    }
    const env = pages ? { CHAT_SESSION_TOKEN_SECRET: "platform-discovery-test-".repeat(2) } : {};
    const app = await createTestInstance({ config, env, tools: [] });
    open = app;
    /**
     * A conversation about nothing, of `as`, in its personal workspace or in `workspaceId`,
     * and one tool call in it with what it answered.
     */
    const conversationOf = async (
      as: string,
      place: { workspaceId?: string; title?: string } = {}
    ) => {
      const payload = {
        title: place.title ?? "Ask",
        ...(place.workspaceId === undefined ? {} : { collaborationWorkspaceId: place.workspaceId })
      };
      const created = await app.call("conversations.create", { payload }, as);
      expect(created.statusCode, created.body).toBe(200);
      const conversation = conversationSchema.parse(created.json());
      const { id } = conversation;
      const headers = { "x-dev-user-id": as };
      const ask = async (tool: string, input: unknown = {}) => {
        const started = await injectStartConversationRun(
          app,
          id,
          `/tool ${tool} ${JSON.stringify(input)}`,
          { headers }
        );
        const events = await drainRunEvents(app, id, started.run.id, { headers });
        const messages = messagesSchema.parse(
          (
            await app.call("conversations.messages.list", { params: { conversationId: id } }, as)
          ).json()
        );
        const text = messages.items.filter((message) => message.role === "tool").at(-1)?.text;
        const answer: unknown = text === undefined ? undefined : JSON.parse(text);
        return { events, answer };
      };
      return Object.assign(ask, conversation);
    };
    return { app, conversationOf, clientInstanceId: asClientInstanceId(config.clientInstance.id) };
  }

  it("lets an agent in a conversation about nothing read the platform skill, see what the instance has and find the assets its user may read, and nothing of the others", async () => {
    const t = await fixture(true);
    const written = await t.app.call("assets.put", {
      params: { kind: WORKFLOW_ASSET_KIND, name: WORKFLOW },
      payload: { config: workflowConfig, expectedRevision: null }
    });
    expect(written.statusCode, written.body).toBe(200);

    const owner = await t.conversationOf(OWNER);
    const skill = z
      .object({ name: z.string(), content: z.string() })
      .parse((await owner("read_skill", { name: "platform-guide" })).answer);
    expect(skill.content).toContain("platform.assets.list");

    const context = contextSchema.parse((await owner("platform.context")).answer);
    expect(context.modules).toContain("workflows");
    expect(context.kinds).toContainEqual({ kind: "workflow", plural: "workflows", hasDraft: true });
    expect(context.actions).toEqual(expect.arrayContaining(["workflow.write", "workflow.publish"]));

    // Names, titles and descriptions; never the definition.
    const found = foundSchema.parse(
      (await owner("platform.assets.list", { kind: "workflow", text: "MONTH" })).answer
    );
    expect(found).toEqual({
      assets: [
        {
          kind: "workflow",
          name: WORKFLOW,
          title: "Month-end closing",
          description: "Closes the books at the end of each month."
        }
      ],
      truncated: false
    });
    // The title is searched as well as the name.
    const byTitle = foundSchema.parse(
      (await owner("platform.assets.list", { text: "Closing" })).answer
    );
    expect(byTitle.assets.map(({ name }) => name)).toEqual([WORKFLOW]);
    const everyKind = foundSchema.parse((await owner("platform.assets.list", {})).answer);
    expect(everyKind.assets.map(({ kind, name }) => `${kind}:${name}`)).toContain(
      `workflow:${WORKFLOW}`
    );

    // A member who may not read the Workflow is told what is told of a name that is not there.
    const member = await t.conversationOf(MEMBER);
    const memberContext = contextSchema.parse((await member("platform.context")).answer);
    expect(memberContext.actions).not.toContain("workflow.write");
    const hidden = await member("platform.assets.list", { kind: "workflow", text: WORKFLOW });
    const missing = await member("platform.assets.list", { kind: "workflow", text: "no-such" });
    expect(hidden.answer).toEqual({ assets: [], truncated: false });
    expect(hidden.answer).toEqual(missing.answer);
    const memberEveryKind = foundSchema.parse((await member("platform.assets.list", {})).answer);
    expect(memberEveryKind.assets.map(({ kind }) => kind)).not.toContain("workflow");
  }, 120_000);

  it("lists no kind of a module that is off, and refuses it as a kind that does not exist", async () => {
    const t = await fixture(false);
    const owner = await t.conversationOf(OWNER);
    const context = contextSchema.parse((await owner("platform.context")).answer);
    expect(context.modules).not.toContain("workflows");
    expect(context.kinds.map(({ kind }) => kind)).not.toContain("workflow");
    expect(context.actions.filter((action) => action.startsWith("workflow."))).toEqual([]);

    const off = await owner("platform.assets.list", { kind: "workflow" });
    const unknown = await owner("platform.assets.list", { kind: "no-such-kind" });
    const refusal = (kind: string) => ({
      code: "handler_failed",
      message: `This platform has no kind '${kind}'. platform.context lists the kinds it has`
    });
    expect(off.answer).toEqual(refusal("workflow"));
    expect(unknown.answer).toEqual(refusal("no-such-kind"));
  }, 120_000);

  it("finds nothing on an instance that holds no asset of a kind", async () => {
    const t = await fixture(true);
    const owner = await t.conversationOf(OWNER);
    expect((await owner("platform.assets.list", { kind: "workflow" })).answer).toEqual({
      assets: [],
      truncated: false
    });
    // What the release ships alone: the instance holds no asset anybody wrote.
    const everyKind = foundSchema.parse((await owner("platform.assets.list", {})).answer);
    expect(everyKind.truncated).toBe(false);
    expect(everyKind.assets.map(({ kind }) => kind)).not.toContain("workflow");
  }, 120_000);

  it("refuses search text the store cannot hold before it reaches the store", () => {
    const unused = () => Promise.reject(new Error("The schema refuses the input first"));
    const tools = createPlatformDiscoveryTools({
      readContext: unused,
      listAssets: unused,
      listFiles: unused
    });
    const find = tools.find((tool) => tool.name === "platform.assets.list");
    expect(find?.inputSchema.safeParse({ text: "month\u0000end" }).success).toBe(false);
    expect(find?.inputSchema.safeParse({ kind: "work\u0000flow" }).success).toBe(false);
    expect(find?.inputSchema.safeParse({ kind: "workflow", text: "month" }).success).toBe(true);
    const files = tools.find((tool) => tool.name === "platform.files.list");
    expect(files?.inputSchema.safeParse({ text: "tax\u0000" }).success).toBe(false);
    expect(files?.inputSchema.safeParse({ kind: "page", text: "tax" }).success).toBe(true);
  });

  it("finds files the agent made for the person and none it only rendered to check its work", async () => {
    const t = await fixture(false, true);
    const { clientInstanceId } = t;
    const stores = t.app.stores;
    const chat = await t.conversationOf(OWNER);
    const conversationId = asConversationId(chat.id);
    const workspaceFile = (path: string) => ({
      clientInstanceId,
      conversationId,
      kind: "image.png",
      objectKey: `execution-workspaces/private/${path}`,
      filename: path.replace(/^.*\//, ""),
      mimeType: "image/png",
      byteSize: 3,
      checksum: `sha256:${path}`
    });
    // A render the agent looked at, as workspace.preview_images stores it.
    await stores.files.createManagedArtifact({
      ...workspaceFile("previews/contoso_daten.png"),
      metadata: {
        source: "execution_workspace",
        purpose: "inspection",
        workspaceId: "ws-1",
        workspacePath: "previews/contoso_daten.png"
      }
    });
    // One stored before the purpose was recorded, known by its id.
    await stores.files.ensureManagedArtifact({
      ...workspaceFile("previews/contoso_start.png"),
      id: asManagedArtifactId("art_workspace_preview_stored_before_the_purpose"),
      metadata: {
        source: "execution_workspace",
        workspaceId: "ws-1",
        workspacePath: "previews/contoso_start.png"
      }
    });
    // A chart promoted for the person, then looked at again: the look is the newer row.
    const promoted = await stores.files.createManagedArtifact({
      ...workspaceFile("artifacts/umsatz_chart.png"),
      metadata: {
        source: "execution_workspace",
        workspaceId: "ws-1",
        workspacePath: "artifacts/umsatz_chart.png"
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await stores.files.ensureManagedArtifact({
      ...workspaceFile("artifacts/umsatz_chart.png"),
      id: asManagedArtifactId("art_workspace_preview_looked_at_the_chart"),
      metadata: {
        source: "execution_workspace",
        purpose: "inspection",
        workspaceId: "ws-1",
        workspacePath: "artifacts/umsatz_chart.png"
      }
    });

    const found = filesSchema.parse(
      (await chat("platform.files.list", { kind: "generated_file" })).answer
    );
    expect(found.files.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: promoted.id, name: "umsatz_chart.png" }
    ]);
  });

  it("finds the Pages and files of every conversation of the workspace the user may read, from any chat, and nothing else", async () => {
    const t = await fixture(false, true);
    const { clientInstanceId } = t;
    const stores = t.app.stores;
    /** A file sent with a message of the conversation, as an upload leaves it. */
    const upload = async (conversationId: string, filename: string) => {
      const conversation = asConversationId(conversationId);
      const file = await stores.files.createManagedFile({
        clientInstanceId,
        ownerUserId: "owner",
        filename,
        mimeType: "text/plain",
        byteSize: 3,
        checksum: `sha256:${filename}`,
        objectKey: `private/${filename}`
      });
      await stores.files.createConversationAttachment({
        clientInstanceId,
        conversationId: conversation,
        fileId: file.id,
        filename,
        mimeType: "text/plain",
        byteSize: 3,
        checksum: file.checksum,
        status: "ready",
        format: "txt"
      });
      await claimAttachmentsForStoredMessage(stores, {
        clientInstanceId,
        conversationId: conversation,
        messageId: asMessageId(`msg_${filename}`),
        claimedAt: new Date().toISOString()
      });
      return file.id;
    };

    // A Shared Workspace whose conversations start private: the owner's first one is theirs.
    const created = await t.app.call(
      "workspaces.create",
      { payload: { name: "Finance", defaultConversationVisibility: "private" } },
      OWNER
    );
    expect(created.statusCode, created.body).toBe(200);
    const workspaceId = z.object({ id: z.string() }).parse(created.json()).id;
    const memberHome = await t.conversationOf(MEMBER);
    await stores.workspaces.addMembership({
      clientInstanceId,
      collaborationWorkspaceId: asCollaborationWorkspaceId(workspaceId),
      userId: asUserId(memberHome.createdByUserId),
      role: "member"
    });
    const privateChat = await t.conversationOf(OWNER, { workspaceId });
    await upload(privateChat.id, "salaries.txt");
    const opened = await t.app.call(
      "workspaces.update",
      {
        params: { collaborationWorkspaceId: workspaceId },
        payload: { defaultConversationVisibility: "workspace" }
      },
      OWNER
    );
    expect(opened.statusCode, opened.body).toBe(200);
    const taxChat = await t.conversationOf(OWNER, { workspaceId, title: "Tax return 2026" });
    const receipts = await upload(taxChat.id, "receipts.txt");
    const page = await stores.pages.ensurePage({
      clientInstanceId,
      conversationId: asConversationId(taxChat.id),
      name: "deductions",
      createdAt: new Date().toISOString()
    });
    await stores.pages.createPageFileSet({
      clientInstanceId,
      pageId: page.id,
      fileSet: {
        id: createFileSetId(),
        kitVersion: "2.0.0",
        manifest: {},
        sourceFiles: [],
        builtFiles: [],
        createdAt: new Date().toISOString()
      }
    });
    // The owner's personal workspace is another workspace for the member.
    const diary = await t.conversationOf(OWNER);
    await upload(diary.id, "diary.txt");

    // From another chat of the workspace, the owner's agent finds the Page of the tax chat.
    const asker = await t.conversationOf(OWNER, { workspaceId });
    const pages = filesSchema.parse((await asker("platform.files.list", { kind: "page" })).answer);
    expect(pages).toEqual({
      files: [
        {
          kind: "page",
          id: page.id,
          name: "deductions",
          mimeType: "text/html",
          bytes: 0,
          updatedAt: expect.any(String),
          conversation: { id: taxChat.id, title: "Tax return 2026" }
        }
      ],
      truncated: false
    });
    // By the title of its conversation, whatever the case, and with the owner's private file.
    const names = async (ask: typeof asker, input: object) =>
      filesSchema
        .parse((await ask("platform.files.list", input)).answer)
        .files.map(({ name }) => name);
    expect(await names(asker, { text: "TAX RETURN" })).toEqual(
      expect.arrayContaining(["deductions", "receipts.txt"])
    );
    expect(await names(asker, {})).toEqual(
      expect.arrayContaining(["deductions", "receipts.txt", "salaries.txt"])
    );
    expect(await names(asker, {})).not.toContain("diary.txt");
    const here = filesSchema.parse(
      (await taxChat("platform.files.list", { kind: "upload" })).answer
    );
    // What lives in the asking conversation is marked: that is what its agent can open.
    expect(here.files.filter((file) => file.inThisConversation)).toEqual([
      expect.objectContaining({ id: receipts, name: "receipts.txt" })
    ]);

    // A member finds what is shared, never the owner's private file nor another workspace's.
    const memberChat = await t.conversationOf(MEMBER, { workspaceId });
    const memberNames = await names(memberChat, {});
    expect(memberNames).toEqual(expect.arrayContaining(["deductions", "receipts.txt"]));
    expect(memberNames).not.toContain("salaries.txt");
    expect(memberNames).not.toContain("diary.txt");
    const hidden = await memberChat("platform.files.list", { text: "salaries" });
    const missing = await memberChat("platform.files.list", { text: "no-such" });
    expect(hidden.answer).toEqual({ files: [], truncated: false });
    expect(hidden.answer).toEqual(missing.answer);

    // The operation of the API answers the same, page by page.
    const list = (
      as: string,
      collaborationWorkspaceId: string,
      query: Record<string, string | number | undefined> = {}
    ) => t.app.call("workspaces.files.list", { params: { collaborationWorkspaceId }, query }, as);
    const first = await list(MEMBER, workspaceId, { limit: 1 });
    expect(first.statusCode, first.body).toBe(200);
    const firstPage = workspaceFilesSchema.parse(first.json());
    expect(firstPage.items).toHaveLength(1);
    const second = workspaceFilesSchema.parse(
      (await list(MEMBER, workspaceId, { limit: 1, cursor: firstPage.nextCursor })).json()
    );
    expect([...firstPage.items, ...second.items].map(({ name }) => name).sort()).toEqual([
      "deductions",
      "receipts.txt"
    ]);
    expect((await list(MEMBER, diary.collaborationWorkspaceId)).statusCode).toBe(404);
    expect((await list(MEMBER, workspaceId, { text: "tax\u0000" })).statusCode).toBe(422);
  }, 180_000);
});
