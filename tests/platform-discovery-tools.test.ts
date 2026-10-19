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
} from "@work-shape/catalyst-core";
import { platformContextSchema } from "@work-shape/catalyst-api-contract";
import { PLATFORM_TOOL_NAMES } from "@work-shape/catalyst-client-assembly";
import { createPlatformDiscoveryTools } from "@work-shape/catalyst-tool-execution";
import { drainRunEvents, injectStartConversationRun } from "./support/chat-server-run-harness";
import { createTestConfig } from "./support/fixtures";
import { createTestInstance, type TestInstance } from "./support/test-instance";
import { claimAttachmentsForStoredMessage } from "./support/test-store";

// An agent that holds the platform's tools finds what is on the platform with them and reads the
// product's documentation in one shipped skill; an agent that lists none of them gets neither.
// The tools answer with the rights of the person the agent acts for: an asset that person may
// not read is answered as one that does not exist. The model is the scripted one of the tests,
// which makes the one tool call each message names. Each test fails without the change: no
// agent could list the platform's assets, and the platform's tools and skill reached every
// agent whatever its definition listed.

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

  async function fixture(
    workflows: boolean,
    pages = false,
    toolNames: string[] = [...PLATFORM_TOOL_NAMES]
  ) {
    const config = createTestConfig({
      toolNames,
      displayName: { en: "Test Agent", de: "Test-Helfer" },
      // A skill reader listed by the agent must be enabled by the release. Platform-held
      // agents also receive it through their conversation offer.
      tools: toolNames.includes("read_skill") ? [{ name: "read_skill" }] : [],
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
      place: { workspaceId?: string; title?: string; locale?: string } = {}
    ) => {
      const payload = {
        title: place.title ?? "Ask",
        ...(place.workspaceId === undefined ? {} : { collaborationWorkspaceId: place.workspaceId })
      };
      const created = await app.call("conversations.create", { payload }, as);
      expect(created.statusCode, created.body).toBe(200);
      const conversation = conversationSchema.parse(created.json());
      const { id } = conversation;
      const headers = {
        "x-dev-user-id": as,
        ...(place.locale ? { "accept-language": place.locale } : {})
      };
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

  it("marks only this conversation's workspace as current, even without build rights here", async () => {
    const t = await fixture(false);
    const shared = await t.app.call(
      "workspaces.create",
      { payload: { name: "Skill builders" } },
      OWNER
    );
    expect(shared.statusCode, shared.body).toBe(200);
    const workspaceId = asCollaborationWorkspaceId(
      z.object({ id: z.string() }).parse(shared.json()).id
    );
    const member = await t.conversationOf(MEMBER);
    await t.app.stores.access.createGrant({
      clientInstanceId: t.clientInstanceId,
      holderKind: "user",
      holderId: member.createdByUserId,
      action: "skill.write",
      effect: "allow",
      scopeKind: "workspace",
      scopeId: workspaceId,
      grantedBy: asUserId(member.createdByUserId)
    });
    const schema = z.object({
      workspaces: z.array(
        z.object({
          id: z.string(),
          current: z.literal(true).optional(),
          actions: z.array(z.string())
        })
      )
    });
    const read = schema.parse((await member("platform.context")).answer);
    expect(read.workspaces.filter((place) => place.current)).toEqual([
      { id: member.collaborationWorkspaceId, current: true, actions: [] }
    ]);
    expect(read.workspaces.find((place) => place.id === workspaceId)).toEqual({
      id: workspaceId,
      actions: ["skill.write"]
    });
    const owner = await t.conversationOf(OWNER);
    const ownerRead = schema.parse((await owner("platform.context")).answer);
    expect(ownerRead.workspaces.filter((place) => place.current)).toEqual([
      expect.objectContaining({
        id: owner.collaborationWorkspaceId,
        actions: expect.arrayContaining(["skill.write"])
      })
    ]);
  }, 120_000);

  it("orients from localized agents and published Apps available in this workspace", async () => {
    const t = await fixture(false, true);
    t.app.stores.users.getInstanceAdminName = async () => "Mara";
    const chat = await t.conversationOf(OWNER, { locale: "de" });
    const scope = {
      kind: "workspace" as const,
      workspaceId: asCollaborationWorkspaceId(chat.collaborationWorkspaceId)
    };
    const names = ["offered-app", "draft-app"];
    await t.app.stores.configAssets.applyConfigAssetMutations({
      clientInstanceId: t.clientInstanceId,
      baseRevisions: Object.fromEntries(names.map((name) => [`app:${name}`, null])),
      mutations: names.map((name) => ({
        type: "upsert" as const,
        kind: "app",
        name,
        scope,
        config: {
          name,
          title: name === "offered-app" ? "Angebote" : "Entwurf",
          description: "Test",
          manifest: { id: name, name: "Angebote", kit: "1.0.0", entry: "index.html" }
        },
        draft: true
      }))
    });
    const app = await t.app.stores.configAssets.getConfigAsset({
      clientInstanceId: t.clientInstanceId,
      kind: "app",
      name: "offered-app"
    });
    if (!app) throw new Error("Missing fixture App");
    await t.app.stores.configAssets.publishConfigAssetRevision({
      clientInstanceId: t.clientInstanceId,
      kind: "app",
      name: app.name,
      assetId: app.id,
      revision: app.revision,
      revisionId: app.activeRevisionId
    });
    const read = z
      .object({
        helpContact: z.object({ displayLabel: z.string() }),
        availableHere: z.object({
          agents: z.array(z.object({ name: z.string(), title: z.string() })),
          apps: z.array(z.object({ name: z.string(), title: z.string() })),
          appsTruncated: z.boolean()
        })
      })
      .parse((await chat("platform.context")).answer);
    expect(read.helpContact.displayLabel).toBe("Mara");
    expect(read.availableHere.agents).toContainEqual({ name: "test_agent", title: "Test-Helfer" });
    expect(read.availableHere.apps).toEqual([{ name: "offered-app", title: "Angebote" }]);
    const listed = foundSchema.parse(
      (await chat("platform.assets.list", { kind: "agent" })).answer
    );
    expect(listed.assets.find((asset) => asset.name === "test_agent")?.title).toBe("Test-Helfer");
  });

  it("lets an agent in a conversation about nothing read the platform skill, see what the instance has and find the assets its user may read, and nothing of the others", async () => {
    const t = await fixture(true);
    const owner = await t.conversationOf(OWNER);
    expect((await owner("platform.assets.list", { kind: "workflow" })).answer).toEqual({
      assets: [],
      truncated: false
    });
    const initiallyEveryKind = foundSchema.parse((await owner("platform.assets.list", {})).answer);
    expect(initiallyEveryKind.truncated).toBe(false);
    expect(initiallyEveryKind.assets.map(({ kind }) => kind)).not.toContain("workflow");
    const written = await t.app.call("assets.put", {
      params: { kind: WORKFLOW_ASSET_KIND, name: WORKFLOW },
      payload: { config: workflowConfig, expectedRevision: null }
    });
    expect(written.statusCode, written.body).toBe(200);

    // The documentation lists its pages, and each listed path answers that page.
    const docs = z
      .object({
        name: z.string(),
        content: z.string(),
        resources: z.array(z.object({ path: z.string(), mediaType: z.string() }))
      })
      .parse((await owner("read_skill", { name: "platform-docs" })).answer);
    expect(docs.content).toContain("`references/configure/cli.md`: The Catalyst CLI.");
    expect(docs.resources).toContainEqual({
      path: "references/configure/cli.md",
      mediaType: "text/markdown"
    });
    const context = contextSchema.parse((await owner("platform.context")).answer);
    expect(context.modules).toContain("workflows");
    expect(context.kinds).toContainEqual({ kind: "workflow", plural: "workflows", hasDraft: true });
    expect(context.actions).toEqual(expect.arrayContaining(["workflow.write", "workflow.publish"]));

    // Names, titles and descriptions; never the definition.
    const found = foundSchema.parse(
      (await owner("platform.assets.list", { text: "CLOSING" })).answer
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
    // A member who may not read the Workflow is told what is told of a name that is not there.
    const member = await t.conversationOf(MEMBER);
    // Rights are an operation contract; the tool's projection is checked once above.
    const memberContext = platformContextSchema.parse(
      (await t.app.call("platform.context.get", {}, MEMBER)).json()
    );
    expect(memberContext.actions).not.toContain("workflow.write");
    const hidden = await member("platform.assets.list", { text: WORKFLOW });
    const missing = await member("platform.assets.list", { text: "no-such" });
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

  it("resolves notification people by literal name or email only within the caller's rights, with bounded matches", async () => {
    const t = await fixture(true);
    const owner = await t.conversationOf(OWNER);
    const member = await t.conversationOf(MEMBER);
    await t.app.stores.apiAccess.createServicePrincipal({
      clientInstanceId: t.clientInstanceId,
      name: "summary-account",
      displayLabel: "Summary account"
    });
    const person = await t.app.stores.users.createUser({
      clientInstanceId: t.clientInstanceId,
      displayLabel: "Ada Summary",
      email: "ada@example.test"
    });
    await t.app.stores.users.createUser({
      clientInstanceId: t.clientInstanceId,
      displayLabel: "Ada Disabled",
      email: "disabled@example.test",
      status: "disabled"
    });
    const read = z.object({
      caller: z.object({ id: z.string(), displayLabel: z.string() }),
      people: z.array(
        z.object({ id: z.string(), displayLabel: z.string(), email: z.string().optional() })
      ),
      peopleTruncated: z.boolean(),
      workflowPrincipals: z.array(z.unknown())
    });
    for (const query of ["ADA", "ada@example.test"]) {
      expect(
        read.parse((await owner("platform.context", { person: query })).answer).people
      ).toEqual([{ id: person.id, displayLabel: person.displayLabel, email: person.email }]);
      expect(
        read.parse((await member("platform.context", { person: query })).answer).people
      ).toEqual([]);
    }
    const self = read.parse((await member("platform.context", { person: "Member" })).answer);
    expect(self.people).toEqual([{ id: self.caller.id, displayLabel: "Member" }]);
    expect(self.workflowPrincipals).toEqual([]);
    expect(read.parse((await owner("platform.context")).answer).workflowPrincipals).toEqual([
      { name: "summary-account", displayLabel: "Summary account" }
    ]);
    for (const query of ["%", "_", "' OR true --", "not-a-person"])
      expect(
        read.parse((await owner("platform.context", { person: query })).answer).people
      ).toEqual([]);
    for (let index = 0; index < 22; index++)
      await t.app.stores.users.createUser({
        clientInstanceId: t.clientInstanceId,
        displayLabel: `Team ${index}`
      });
    const many = read.parse((await owner("platform.context", { person: "Team" })).answer);
    expect(many.people).toHaveLength(20);
    expect(many.peopleTruncated).toBe(true);
    const invalid = await owner("platform.context", { person: "\u0000" });
    expect(invalid.answer).not.toHaveProperty("people");
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
    const ownerNames = await names(asker, {});
    expect(ownerNames).toEqual(
      expect.arrayContaining(["deductions", "receipts.txt", "salaries.txt"])
    );
    expect(ownerNames).not.toContain("diary.txt");
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
