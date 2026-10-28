import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { APP_ASSET_KIND } from "@work-shape/catalyst-api-contract";
import {
  createPlatformAssetCalls,
  createSandboxAssetRepo,
  createPageBuildClient,
  type AssetRepoCommitRunner
} from "@work-shape/catalyst-server";
import {
  asAgentRunId,
  asConversationId,
  asToolCallId,
  createPlatformId,
  createToolResultMetadata,
  isAppError,
  readObjectBytes,
  type CentralPolicySetting,
  type ToolExecutionContext,
  type UserRecord
} from "@work-shape/catalyst-core";
import {
  createAppSaveTool,
  createAppEditTool,
  createWorkspaceOpenTool,
  WorkspaceCommandService,
  LocalWorkspaceCommandProcessExecutor
} from "@work-shape/catalyst-tool-execution";
import { withTestSql } from "./support/test-sql";
import { MemoryObjectStorage } from "./support/memory-object-storage";
import { agent, clientInstanceId } from "./support/access-instance";
import { appFiles, expectStatus, setupAppInstance, type AppInstance } from "./support/app-instance";
import { assetRepoCommandFromSource } from "./support/asset-repo";
import { testServerOptions } from "./support/test-instance";

// What a conversation opened kept as an App, on the server: the first app.save and the App
// draft a later one writes, called as the agent's tool calls them, against the real rights,
// stores, commits and policy. The cases of a draft moved to another folder, of a commit that
// failed and of a policy fail without the follow-ups of A3's review: the save answered nothing,
// failed, or ignored the setting. The case of check 55 fails without OPEN-1: a second save of
// the App was no save of it, and wrote no revision.

const idSchema = z.object({ id: z.string() });

describe("app.save in a conversation", () => {
  let t: AppInstance;
  let calls: ReturnType<typeof createPlatformAssetCalls>;
  let scratch: string;
  const workspaceObjects = new MemoryObjectStorage();
  const commitFails = { next: false };
  const settings: CentralPolicySetting[] = [];

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "verify-a3-"));
    const real = createSandboxAssetRepo({
      sandbox: new LocalWorkspaceCommandProcessExecutor(),
      tempRoot: join(scratch, "commits"),
      command: `'${process.execPath}' '${await assetRepoCommandFromSource()}'`
    });
    const commits: AssetRepoCommitRunner = async (input) => {
      if (commitFails.next) {
        commitFails.next = false;
        return { status: "failed", reason: "command_missing", message: "runner image outdated" };
      }
      return real(input);
    };
    t = await setupAppInstance({
      commits,
      workspaceObjects,
      server: () => ({ operations: { centralPolicySettings: () => settings } })
    });
    // The server, and with it its options, is built on the first request.
    await t.instance.call("health.get");
    const options = testServerOptions(t.instance);
    if (!options) throw new Error("The instance has no server options");
    calls = createPlatformAssetCalls(options, workspaceObjects);
  });
  afterAll(async () => {
    await t.close();
    await rm(scratch, { recursive: true, force: true });
  });

  const asIdentity = (user: UserRecord) => ({
    id: user.id,
    externalUserId: user.id,
    displayLabel: user.displayLabel,
    roles: user.roles,
    permissions: user.permissions,
    permissionRefs: user.permissionRefs,
    clientInstanceId,
    authSource: "test"
  });

  /** The context of one tool call of the agent, in its own Operation Run. */
  async function contextOf(
    user: UserRecord,
    conversationId: string,
    toolName = "app.save"
  ): Promise<ToolExecutionContext> {
    const correlationId = `corr_${randomUUID()}`;
    const run = await t.stores.operationRuns.create({
      id: createPlatformId<"OperationRunId">("oprun"),
      clientInstanceId,
      operation: toolName,
      effect: "changing",
      actor: { kind: "user", id: user.id, label: user.displayLabel },
      origin: { kind: "user" },
      target: "live",
      inputHash: randomUUID().replace(/-/gu, "").padEnd(64, "a"),
      correlationId,
      startedAt: new Date().toISOString()
    });
    if (!run) throw new Error("No run");
    return {
      user: asIdentity(user),
      clientInstanceId,
      correlationId,
      toolRequest: {
        toolName,
        toolCallId: asToolCallId(`call_${randomUUID()}`),
        agentRunId: asAgentRunId(`run_${randomUUID()}`),
        conversationId: asConversationId(conversationId),
        agentName: "assistant",
        input: {}
      },
      operationRun: { id: run.id }
    };
  }

  /** A conversation of `user`, in their own workspace or private in the Shared Workspace. */
  async function conversationOf(user: UserRecord, where: "personal" | "private" | "shared") {
    const created = idSchema.parse(
      (
        await t.expectOk(user.id, "conversations.create", {
          payload: {
            title: "Probe",
            ...(where === "shared" ? { collaborationWorkspaceId: t.workspaceId } : {})
          }
        })
      ).json()
    ).id;
    if (where === "private") {
      await t.expectOk(user.id, "conversations.move", {
        params: { conversationId: created },
        payload: { collaborationWorkspaceId: t.workspaceId, visibility: "private" }
      });
    }
    return created;
  }

  /** A later save of the same folder: the App keeps its id and its name. */
  const later = { page: "Offers", name: "offers", title: "Offers" };

  const stored = (name: string) =>
    t.stores.configAssets.getConfigAsset({ clientInstanceId, kind: "app", name });
  const subjectOf = async (conversationId: string) =>
    (
      await t.stores.conversations.getConversation(
        clientInstanceId,
        asConversationId(conversationId)
      )
    )?.subject;

  async function refusal(promise: Promise<unknown>) {
    try {
      await promise;
    } catch (error) {
      if (isAppError(error)) return { code: error.code, details: error.details };
      throw error;
    }
    return undefined;
  }

  it("refuses a member without app.write in a private conversation of the Shared Workspace with the right named, and makes no App (check 55)", async () => {
    const conversationId = await conversationOf(t.kai, "private");
    await t.storePage("kai's page", {}, { conversationId });

    const refused = await refusal(
      calls.saveApp(await contextOf(t.kai, conversationId), {
        page: "Offers",
        name: "kai-no-right",
        title: "Kai"
      })
    );

    // Journey cell (c): the refusal names the right.
    expect(refused).toMatchObject({ code: "FORBIDDEN", details: { action: "app.write" } });
    expect(await stored("kai-no-right")).toBeUndefined();
    expect(await subjectOf(conversationId)).toBeUndefined();
  });

  it("refuses an administrator in a conversation shared with the workspace, on the server", async () => {
    const page = await t.storePage("shared page", {}, { shared: true });
    const conversation = await t.stores.conversations.getConversation(
      clientInstanceId,
      asConversationId(page.conversationId)
    );
    expect(conversation?.visibility).toBe("workspace");

    const refused = await refusal(
      calls.saveApp(await contextOf(t.admin, page.conversationId), {
        page: "Offers",
        name: "from-shared",
        title: "Shared"
      })
    );

    expect(refused).toMatchObject({
      code: "CONFLICT",
      details: { reason: "subject_conversation_shared" }
    });
    expect(await stored("from-shared")).toBeUndefined();
  });

  it("requires a checkout before a different conversation can save an App's draft", async () => {
    const conversationId = await conversationOf(t.admin, "private");
    await t.storePage("first", {}, { conversationId });
    const created = await calls.saveApp(await contextOf(t.admin, conversationId), {
      page: "Offers",
      name: "bound-app",
      title: "Bound"
    });
    expect(created).toMatchObject({ kind: "app", name: "bound-app", revision: 1 });
    expect(await subjectOf(conversationId)).toEqual({ kind: "app", name: "bound-app" });

    // Same folder, same conversation: the next draft.
    await t.storePage("second", {}, { conversationId });
    const saved = await calls.saveApp(await contextOf(t.admin, conversationId), later);
    expect(saved).toMatchObject({ saved: true, created: false, revision: 2 });

    // Another conversation made about the same App, with a preview of its own of the same
    // path: nothing written, and the answer says why.
    const other = await conversationOf(t.admin, "private");
    await t.storePage("other", {}, { conversationId: other });
    await t.stores.conversations.setConversationSubject({
      clientInstanceId,
      conversationId: asConversationId(other),
      subject: { kind: "app", name: "bound-app" }
    });
    expect(await calls.saveApp(await contextOf(t.admin, other), later)).toMatchObject({
      saved: false,
      message: expect.stringContaining("never wrote")
    });
    expect(await stored("bound-app")).toMatchObject({ revision: 2 });
  });

  const checkoutOf = (conversationId: string, folder: string) =>
    t.stores.configAssets.getAssetCheckout({
      clientInstanceId,
      conversationId: asConversationId(conversationId),
      folder
    });
  async function workspaceOf(conversationId: string) {
    const workspace = await t.stores.executionWorkspaces.findExecutionWorkspaceOfActiveConversation(
      { clientInstanceId, conversationId: asConversationId(conversationId) }
    );
    if (!workspace) throw new Error("No execution workspace");
    return workspace;
  }
  async function filesOf(conversationId: string) {
    const workspace = await workspaceOf(conversationId);
    return t.stores.executionWorkspaces.listWorkspaceFiles({
      clientInstanceId,
      workspaceId: workspace.id
    });
  }
  async function changeAndOpen(conversationId: string, path: string, marker: string) {
    const context = await contextOf(t.admin, conversationId, "workspace.open");
    const service = new WorkspaceCommandService({ store: t.stores, fileStore: workspaceObjects });
    expect(
      await service.writeFile(
        {
          path: `${path}/index.html`,
          content: `<!doctype html><title>Offers</title><p>${marker}</p>`
        },
        context
      )
    ).toMatchObject({ status: "success" });
    const open = createWorkspaceOpenTool({
      workspace: service.dependencies,
      builds: createPageBuildClient({ stores: t.stores, pollIntervalMs: 20 })
    });
    expect(await open.execute({ path }, context)).toMatchObject({
      status: "success",
      output: { pageId: expect.any(String) }
    });
  }

  it("loads all draft files in chat 2, saves there, refuses chat 1 naming the save, and reloads to reapply", async () => {
    const first = await conversationOf(t.admin, "private");
    await t.storePage("first chat", {}, { conversationId: first });
    await calls.saveApp(await contextOf(t.admin, first), {
      page: "Offers",
      name: "two-chats",
      title: "Two chats"
    });
    const app = await stored("two-chats");
    expect(await checkoutOf(first, "Offers")).toMatchObject({
      baseRevision: 1,
      baseCommit: app?.commit
    });
    const second = await conversationOf(t.admin, "private");
    const tool = createAppEditTool(calls);
    const result = await tool.execute(
      { name: "two-chats" },
      await contextOf(t.admin, second, "app.edit")
    );
    expect(result).toMatchObject({
      status: "success",
      output: { path: "apps/two-chats", revision: 1 }
    });
    expect(await subjectOf(second)).toEqual({ kind: "app", name: "two-chats" });
    const path = "apps/two-chats";
    const loaded = await filesOf(second);
    expect(loaded.map((file) => file.path).sort()).toEqual([
      `${path}/app.yaml`,
      `${path}/index.html`
    ]);
    const html = loaded.find((file) => file.path.endsWith("index.html"));
    if (!html) throw new Error("No source HTML");
    expect(
      new TextDecoder().decode(await readObjectBytes(workspaceObjects, html.objectKey))
    ).toContain("first chat");
    expect(await checkoutOf(second, path)).toMatchObject({ assetId: app?.id, baseRevision: 1 });
    await changeAndOpen(second, path, "second chat change");
    expect(
      await calls.saveApp(await contextOf(t.admin, second), { ...later, page: path })
    ).toMatchObject({ saved: true, revision: 2, name: "two-chats" });
    const moved = await stored("two-chats");
    expect(await checkoutOf(second, path)).toMatchObject({
      baseRevision: 2,
      baseCommit: moved?.commit
    });
    const savedBy = await t.stores.configAssets.getConfigAssetRevision({
      clientInstanceId,
      kind: "app",
      name: "two-chats",
      revision: 2
    });
    await t.storePage("stale first chat", {}, { conversationId: first });
    const refused = await calls.saveApp(await contextOf(t.admin, first), later);
    expect(refused).toMatchObject({
      saved: false,
      message: expect.stringContaining(t.admin.displayLabel)
    });
    if (!savedBy) throw new Error("No saved revision");
    expect(refused).toMatchObject({ message: expect.stringContaining(savedBy.createdAt) });
    expect(refused).toMatchObject({ message: expect.stringContaining("app.edit") });
    expect(await stored("two-chats")).toMatchObject({ revision: 2, fileSetId: moved?.fileSetId });
    expect(await checkoutOf(first, "Offers")).toMatchObject({ baseRevision: 1 });
    await calls.editApp(await contextOf(t.admin, first, "app.edit"), { name: "two-chats" });
    const reloaded = (await filesOf(first)).find((file) => file.path === `${path}/index.html`);
    if (!reloaded) throw new Error("No reloaded source file");
    expect(
      new TextDecoder().decode(await readObjectBytes(workspaceObjects, reloaded.objectKey))
    ).toContain("second chat change");
    await changeAndOpen(first, path, "second chat change plus reapplied first change");
    expect(
      await calls.saveApp(await contextOf(t.admin, first), { ...later, page: path })
    ).toMatchObject({ saved: true, revision: 3 });
    const preview = z.object({ url: z.string() }).parse(
      (
        await t.expectOk(t.admin.id, "apps.preview", {
          params: { app: "two-chats" },
          payload: { mode: "draft" }
        })
      ).json()
    );
    expect(await t.open(preview.url)).toMatchObject({
      status: 200,
      body: expect.stringContaining("second chat change plus reapplied first change")
    });
  });

  it("copies nested binary sources and reloads the whole folder, removing files the draft no longer has", async () => {
    const buildChat = await conversationOf(t.admin, "private");
    await t.storePage("draft", {}, { conversationId: buildChat });
    await calls.saveApp(await contextOf(t.admin, buildChat), {
      page: "Offers",
      name: "binary-edit",
      title: "Binary"
    });
    expectStatus(
      await t.putApp(t.admin.id, "binary-edit", [
        ...appFiles("draft"),
        { path: "images/mark.bin", base64: Buffer.from([0, 1, 255, 42]).toString("base64") }
      ]),
      200
    );
    const chat = await conversationOf(t.admin, "private");
    const edited = await calls.editApp(await contextOf(t.admin, chat, "app.edit"), {
      name: "binary-edit"
    });
    const binary = (await filesOf(chat)).find((file) => file.path.endsWith("images/mark.bin"));
    if (!binary) throw new Error("No binary source file");
    expect(await readObjectBytes(workspaceObjects, binary.objectKey)).toEqual(
      new Uint8Array([0, 1, 255, 42])
    );
    const service = new WorkspaceCommandService({ store: t.stores, fileStore: workspaceObjects });
    await service.writeFile(
      { path: `${edited.path}/extra.txt`, content: "unsaved" },
      await contextOf(t.admin, chat)
    );
    await service.writeFile(
      { path: "notes/keep.txt", content: "unrelated" },
      await contextOf(t.admin, chat)
    );
    expectStatus(await t.putApp(t.admin.id, "binary-edit", appFiles("updated draft")), 200);
    await calls.editApp(await contextOf(t.admin, chat, "app.edit"), { name: "binary-edit" });
    expect((await filesOf(chat)).map((file) => file.path).sort()).toEqual([
      `${edited.path}/app.yaml`,
      `${edited.path}/index.html`,
      "notes/keep.txt"
    ]);
    expect(await checkoutOf(chat, edited.path)).toMatchObject({ baseRevision: 3 });
  });

  it("refuses app.edit without app.write, across workspaces, and in a shared transcript before copying files or changing the subject", async () => {
    expectStatus(await t.putApp(t.admin.id, "edit-rights", appFiles("private source")), 200);
    for (const [user, where, code] of [
      [t.kai, "private", "FORBIDDEN"],
      [t.admin, "personal", "NOT_FOUND"],
      [t.admin, "shared", "CONFLICT"]
    ] as const) {
      const chat = await conversationOf(user, where);
      expect(
        await refusal(
          calls.editApp(await contextOf(user, chat, "app.edit"), { name: "edit-rights" })
        )
      ).toMatchObject({ code });
      expect(await subjectOf(chat)).toBeUndefined();
      expect(
        await t.stores.executionWorkspaces.findExecutionWorkspaceOfActiveConversation({
          clientInstanceId,
          conversationId: asConversationId(chat)
        })
      ).toBeUndefined();
    }
  });

  it("starts a conversation of the person's own that holds the App's checkout (Edit in chat, CHECKOUT-2)", async () => {
    const buildChat = await conversationOf(t.admin, "private");
    await t.storePage("draft for the chat", {}, { conversationId: buildChat });
    await calls.saveApp(await contextOf(t.admin, buildChat), {
      page: "Offers",
      name: "edit-in-chat",
      title: "Edit in chat"
    });
    const app = await stored("edit-in-chat");
    const created = z
      .object({ id: z.string(), visibility: z.string(), subject: z.unknown() })
      .parse(
        (
          await t.expectOk(t.admin.id, "conversations.create", {
            payload: {
              collaborationWorkspaceId: t.workspaceId,
              subject: { kind: "app", name: "edit-in-chat" },
              checkout: true
            }
          })
        ).json()
      );
    // Private, though the Shared Workspace's members read its conversations by default.
    expect(created).toMatchObject({
      visibility: "private",
      subject: { kind: "app", name: "edit-in-chat" }
    });
    const path = "apps/edit-in-chat";
    const loaded = await filesOf(created.id);
    expect(loaded.map((file) => file.path).sort()).toEqual([
      `${path}/app.yaml`,
      `${path}/index.html`
    ]);
    const html = loaded.find((file) => file.path.endsWith("index.html"));
    if (!html) throw new Error("No source HTML");
    expect(
      new TextDecoder().decode(await readObjectBytes(workspaceObjects, html.objectKey))
    ).toContain("draft for the chat");
    expect(await checkoutOf(created.id, path)).toMatchObject({
      assetId: app?.id,
      baseRevision: app?.revision,
      baseCommit: app?.commit
    });
    // The agent of that conversation changes the folder and saves it as the App's next draft.
    await changeAndOpen(created.id, path, "changed in the started chat");
    expect(
      await calls.saveApp(await contextOf(t.admin, created.id), { ...later, page: path })
    ).toMatchObject({ saved: true, name: "edit-in-chat" });
  });

  it("names only visible co-editors of a current unsaved checkout and clears after save or 24 hours idle", async () => {
    const name = "checkout-presence";
    const buildChat = await conversationOf(t.admin, "private");
    await t.storePage("presence draft", {}, { conversationId: buildChat });
    await calls.saveApp(await contextOf(t.admin, buildChat), { ...later, name });
    // B can write this App; A's transcript stays private and unreadable to B.
    const asset = await stored(name);
    if (!asset) throw new Error("No App");
    await t.grant(t.kai.id, "app.write", { assetId: asset.id });
    const read = async (user = t.kai) =>
      (
        await t.expectOk(user.id, "assets.get", {
          params: { kind: "app", name },
          query: { workspaceId: t.workspaceId }
        })
      ).json();
    expect(await read()).toMatchObject({ appEditors: [] });
    const opened = idSchema.parse(
      (
        await t.expectOk(t.admin.id, "conversations.create", {
          payload: {
            collaborationWorkspaceId: t.workspaceId,
            subject: { kind: "app", name },
            checkout: true
          }
        })
      ).json()
    );
    const editors = () => read().then((app) => app.appEditors);
    expect(await editors()).toEqual([
      {
        displayLabel: t.admin.displayLabel,
        since: expect.any(String)
      }
    ]);
    expect(await read(t.admin)).toMatchObject({ appEditors: [] });
    expectStatus(
      await t.call(t.kai.id, "conversations.thread.get", { params: { conversationId: opened.id } }),
      404
    );
    // Exactly 24 hours without activity is closed, even with a current base.
    await withTestSql(
      (sql) =>
        sql`update conversations set updated_at = ${new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()} where id = ${opened.id}`
    );
    expect(await editors()).toEqual([]);
    await withTestSql(
      (sql) =>
        sql`update conversations set updated_at = ${new Date().toISOString()} where id = ${opened.id}`
    );
    expect(await editors()).toHaveLength(1);
    // Losing shared membership hides the name even from a viewer with an App-specific right.
    await withTestSql(
      (sql) =>
        sql`delete from collaboration_workspace_memberships where user_id = ${t.kai.id} and collaboration_workspace_id = ${t.workspaceId}`
    );
    expect(await editors()).toEqual([]);
    await t.stores.workspaces.addMembership({
      clientInstanceId,
      collaborationWorkspaceId: t.workspaceId,
      userId: t.kai.id,
      role: "member"
    });
    const path = `apps/${name}`;
    await changeAndOpen(opened.id, path, "saved presence draft");
    expect(
      await calls.saveApp(await contextOf(t.admin, opened.id), { ...later, page: path })
    ).toMatchObject({ saved: true });
    // The saving checkout has advanced to the new draft, but is no longer open.
    expect(await editors()).toEqual([]);
    await calls.editApp(await contextOf(t.admin, opened.id, "app.edit"), { name });
    expect(await editors()).toHaveLength(1);
    // A newer draft from another chat supersedes the working copy.
    const other = idSchema.parse(
      (
        await t.expectOk(t.admin.id, "conversations.create", {
          payload: {
            collaborationWorkspaceId: t.workspaceId,
            subject: { kind: "app", name },
            checkout: true
          }
        })
      ).json()
    );
    await changeAndOpen(other.id, path, "newer draft");
    expect(
      await calls.saveApp(await contextOf(t.admin, other.id), { ...later, page: path })
    ).toMatchObject({ saved: true });
    expect(await editors()).toEqual([]);
    const published = await t.expectOk(t.kai.id, "assets.get", {
      params: { kind: "app", name },
      query: { workspaceId: t.workspaceId, revision: "1" }
    });
    expect(published.json()).not.toHaveProperty("appEditors");
  });

  it("makes no conversation for Edit in chat where the person may not change the App", async () => {
    expectStatus(await t.putApp(t.admin.id, "edit-in-chat-rights", appFiles("kept")), 200);
    const count = async (userId: string) =>
      z.object({ items: z.array(z.unknown()) }).parse(
        (
          await t.expectOk(userId, "conversations.list", {
            query: { collaborationWorkspaceId: t.workspaceId }
          })
        ).json()
      ).items.length;
    const before = await count(t.kai.id);
    for (const [subject, status] of [
      // A member who may read the workspace's Apps but not write them.
      [{ kind: "app", name: "edit-in-chat-rights" }, 403],
      [{ kind: "app", name: "no-such-app" }, 404],
      [{ kind: "workflow", name: "edit-in-chat-rights" }, 422]
    ] as const) {
      const response = await t.call(t.kai.id, "conversations.create", {
        payload: { collaborationWorkspaceId: t.workspaceId, subject, checkout: true }
      });
      expect(response.statusCode, subject.name).toBe(status);
    }
    expect(await count(t.kai.id)).toBe(before);
  });

  it("creates the checkout on an old build chat's first save", async () => {
    const chat = await conversationOf(t.admin, "private");
    await t.storePage("legacy build", {}, { conversationId: chat });
    await calls.saveApp(await contextOf(t.admin, chat), {
      page: "Offers",
      name: "legacy-checkout",
      title: "Legacy"
    });
    await withTestSql((sql) => sql`delete from asset_checkouts where conversation_id = ${chat}`);
    await t.storePage("legacy next", {}, { conversationId: chat });
    expect(await calls.saveApp(await contextOf(t.admin, chat), later)).toMatchObject({
      saved: true,
      revision: 2
    });
    expect(await checkoutOf(chat, "Offers")).toMatchObject({ baseRevision: 2 });
  });

  it("refuses a draft moved after the save read its base, with the concurrent saver named", async () => {
    const chat = await conversationOf(t.admin, "private");
    await t.storePage("base", {}, { conversationId: chat });
    await calls.saveApp(await contextOf(t.admin, chat), {
      page: "Offers",
      name: "save-race",
      title: "Race"
    });
    await t.storePage("our pending change", {}, { conversationId: chat });
    const getCheckout = t.stores.configAssets.getAssetCheckout.bind(t.stores.configAssets);
    const spy = vi
      .spyOn(t.stores.configAssets, "getAssetCheckout")
      .mockImplementationOnce(async (input) => {
        const base = await getCheckout(input);
        expectStatus(await t.putApp(t.admin.id, "save-race", appFiles("concurrent winner")), 200);
        return base;
      });
    try {
      const result = await calls.saveApp(await contextOf(t.admin, chat), later);
      expect(result).toMatchObject({
        saved: false,
        message: expect.stringContaining(t.admin.displayLabel)
      });
      expect(result).toMatchObject({ message: expect.stringContaining("app.edit") });
      expect(await stored("save-race")).toMatchObject({ revision: 2 });
      expect(await checkoutOf(chat, "Offers")).toMatchObject({ baseRevision: 1 });
    } finally {
      spy.mockRestore();
    }
  });

  it("records the saving agent's display name for Page and direct saves, without rewriting old revisions", async () => {
    const conversationId = await conversationOf(t.admin, "private");
    await t.storePage("saved by assistant", {}, { conversationId });
    await calls.saveApp(await contextOf(t.admin, conversationId), {
      page: "Offers",
      name: "save-authors",
      title: "Save authors"
    });
    // A distinct agent uses the same writer, but its own name is saved with its revision.
    await t.stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { "agent:other-helper": null },
      mutations: [
        {
          type: "upsert",
          kind: "agent",
          name: "other-helper",
          config: agent("other-helper", { displayName: "Other helper" })
        }
      ]
    });
    const context = await contextOf(t.admin, conversationId, "platform.assets.put");
    if (!context.toolRequest) throw new Error("Missing tool request");
    context.toolRequest.agentName = "other-helper";
    await calls.put(context, {
      expectedRevision: 1,
      files: appFiles("saved directly").map((file) => {
        if (!("text" in file)) throw new Error("Expected text source");
        return file;
      })
    });
    // Renaming a helper later must not relabel the save it already made.
    await t.stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { "agent:other-helper": 1 },
      mutations: [
        {
          type: "upsert",
          kind: "agent",
          name: "other-helper",
          config: agent("other-helper", { displayName: "Renamed helper" })
        }
      ]
    });
    const revisions = await t.stores.configAssets.listConfigAssetRevisions({
      clientInstanceId,
      kind: "app",
      name: "save-authors"
    });
    expect(revisions.map(({ origin }) => origin)).toEqual([
      expect.objectContaining({ kind: "page", byAgent: true, agentDisplayName: "assistant" }),
      expect.objectContaining({ kind: "agent_run", agentDisplayName: "Other helper" })
    ]);
    const history = await t.expectOk(t.admin.id, "assets.revisions.list", {
      params: { kind: "app", name: "save-authors" },
      query: { workspaceId: t.workspaceId }
    });
    expect(history.json()).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          origin: expect.objectContaining({ agentDisplayName: "assistant" })
        }),
        expect.objectContaining({
          origin: expect.objectContaining({ agentDisplayName: "Other helper" })
        })
      ])
    });
  });

  it("does not write over a draft changed elsewhere, and says so", async () => {
    const conversationId = await conversationOf(t.admin, "private");
    await t.storePage("first", {}, { conversationId });
    await calls.saveApp(await contextOf(t.admin, conversationId), {
      page: "Offers",
      name: "moved-draft",
      title: "Moved"
    });
    expectStatus(await t.putApp(t.admin.id, "moved-draft", appFiles("elsewhere")), 200);
    expect(await stored("moved-draft")).toMatchObject({ revision: 2 });

    await t.storePage("second", {}, { conversationId });
    const saved = await calls.saveApp(await contextOf(t.admin, conversationId), later);

    expect(saved).toMatchObject({ saved: false });
    expect(await stored("moved-draft")).toMatchObject({ revision: 2 });
  });

  // Fails without the change: the answer was "Config asset bundle is invalid", which names
  // nothing the agent could fix.
  it("says what the App's checks found when they refuse the draft", async () => {
    const conversationId = await conversationOf(t.admin, "private");
    await t.storePage("first", {}, { conversationId });
    await calls.saveApp(await contextOf(t.admin, conversationId), {
      page: "Offers",
      name: "unknown-connection",
      title: "Unknown"
    });

    await t.storePage("second", { connections: ["no-such-connection"] }, { conversationId });
    const saved = await calls.saveApp(await contextOf(t.admin, conversationId), later);

    expect(saved).toMatchObject({
      saved: false,
      message: expect.stringContaining("no-such-connection")
    });
    expect(await stored("unknown-connection")).toMatchObject({ revision: 1 });
  });

  it("says the draft moved when another folder was put into the App since (journey cell b)", async () => {
    const conversationId = await conversationOf(t.admin, "private");
    await t.storePage("first", {}, { conversationId });
    await calls.saveApp(await contextOf(t.admin, conversationId), {
      page: "Offers",
      name: "relinked",
      title: "Relinked"
    });
    // Someone puts another preview into the App with "Save to draft".
    const otherPage = await t.storePage("from elsewhere");
    expectStatus(
      await t.call(t.admin.id, "apps.update_from_page", {
        params: { app: "relinked" },
        payload: { ...otherPage, workspaceId: t.workspaceId, expectedRevision: 1, link: true }
      }),
      200
    );
    expect(await stored("relinked")).toMatchObject({ revision: 2 });

    await t.storePage("second", {}, { conversationId });
    const saved = await calls.saveApp(await contextOf(t.admin, conversationId), later);

    // The conversation is still about the App, and its draft was not written: the save says so.
    expect(await subjectOf(conversationId)).toEqual({ kind: "app", name: "relinked" });
    expect(saved).toMatchObject({ saved: false });
    expect(await stored("relinked")).toMatchObject({ revision: 2 });
  });

  it("answers a refused write for a person who lost app.write, and writes nothing", async () => {
    const conversationId = await conversationOf(t.kai, "private");
    // app.write in the workspace is held through a role; the row a role stands for.
    const grant = await t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: t.kai.id,
      action: "app.write",
      effect: "allow",
      scopeKind: "workspace",
      scopeId: t.workspaceId,
      grantedBy: t.admin.id
    });
    await t.storePage("kai first", {}, { conversationId });
    await calls.saveApp(await contextOf(t.kai, conversationId), {
      page: "Offers",
      name: "kai-lost",
      title: "Kai"
    });
    await t.stores.access.deleteGrant({ clientInstanceId, grantId: grant.id });

    await t.storePage("kai second", {}, { conversationId });
    const saved = await calls.saveApp(await contextOf(t.kai, conversationId), later);

    expect(saved).toMatchObject({ saved: false });
    expect(await stored("kai-lost")).toMatchObject({ revision: 1 });
  });

  it("answers a commit the instance cannot make as a draft not written", async () => {
    const conversationId = await conversationOf(t.admin, "private");
    await t.storePage("first", {}, { conversationId });
    await calls.saveApp(await contextOf(t.admin, conversationId), {
      page: "Offers",
      name: "no-commit",
      title: "No commit"
    });
    await t.storePage("second", {}, { conversationId });
    commitFails.next = true;

    // The revision the preview shows is stored at this point: the save writes it into the draft.
    const outcome = await calls.saveApp(await contextOf(t.admin, conversationId), later).then(
      (value) => ({ answered: value }),
      (error: unknown) => ({ thrown: isAppError(error) ? error.code : String(error) })
    );

    expect(outcome).toMatchObject({ answered: { saved: false } });
  });

  it("records app.created and config_asset.updated without file contents", async () => {
    const conversationId = await conversationOf(t.admin, "private");
    await t.storePage("SECRET-MARKER-ONE", {}, { conversationId });
    const create = await contextOf(t.admin, conversationId);
    await calls.saveApp(create, { page: "Offers", name: "audited", title: "Audited" });
    await t.storePage("SECRET-MARKER-TWO", {}, { conversationId });
    const save = await contextOf(t.admin, conversationId);
    expect(await calls.saveApp(save, later)).toMatchObject({
      saved: true
    });

    const events = (await t.stores.audit.listAuditEvents({ clientInstanceId, limit: 500 })).filter(
      (event) =>
        event.correlationId === create.correlationId || event.correlationId === save.correlationId
    );
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["app.created", "config_asset.updated"])
    );
    const text = JSON.stringify(events);
    expect(text).not.toContain("SECRET-MARKER");
    expect(text).not.toContain("<!doctype");
  });

  it("holds the agent's App writes to what an administrator set on assets.put for an App or on the apps operations", async () => {
    const conversationId = await conversationOf(t.admin, "private");
    const fresh = await conversationOf(t.admin, "private");
    await t.storePage("first", {}, { conversationId });
    const appSave = createAppSaveTool(calls);
    const floorIn = (id: string) =>
      appSave.policyFloor?.(
        { conversationId: asConversationId(id) },
        { path: "Offers", name: "Quote" }
      );
    const floors = async () => ({
      create: await floorIn(fresh),
      draft: await floorIn(conversationId)
    });
    try {
      // Nothing set: the tool's own mode stands.
      expect(await floors()).toEqual({ create: undefined, draft: undefined });

      settings.push({ operation: "assets.put", value: "deny", assetKind: APP_ASSET_KIND });
      expect(await floors()).toEqual({ create: "deny", draft: "deny" });
      await calls.saveApp(await contextOf(t.admin, conversationId), {
        page: "Offers",
        name: "held-app",
        title: "Held"
      });
      // From now on the conversation is about the App: its next save writes the App's draft.
      expect(await subjectOf(conversationId)).toEqual({ kind: "app", name: "held-app" });

      settings.splice(0);
      settings.push({ operation: "assets.put", value: "approval", assetKind: APP_ASSET_KIND });
      expect(await floors()).toEqual({ create: "approval", draft: "approval" });

      // The operations of the App's way from the preview hold each for its own write: the
      // first save creates, a later one writes the draft.
      settings.splice(0);
      settings.push(
        { operation: "apps.create_from_page", value: "deny" },
        { operation: "apps.update_from_page", value: "approval" }
      );
      expect(await floors()).toEqual({ create: "deny", draft: "approval" });

      // A setting on another kind of asset holds for neither.
      settings.splice(0);
      settings.push({ operation: "assets.put", value: "deny", assetKind: "workflow" });
      expect(await floors()).toEqual({ create: undefined, draft: undefined });
    } finally {
      settings.splice(0);
    }
  });

  // Check 55 of apps-and-pages. Fails without OPEN-1: the second save made no revision, since a
  // save of an App was a save of its Page.
  it("saves an App its builder uses at once and asks nothing, which a member without the build right never sees, and writes revision 2 on the second save (check 55)", async () => {
    const conversationId = await conversationOf(t.admin, "private");
    await t.storePage("first revision", {}, { conversationId });
    const appSave = createAppSaveTool(calls);
    // Asks nothing: no confirmation of its own, and no setting makes one where none is set.
    expect(appSave.permission).toEqual({ mode: "allow" });
    expect(
      await appSave.policyFloor?.(
        { conversationId: asConversationId(conversationId) },
        { path: "Offers", name: "Quick quote" }
      )
    ).toBeUndefined();

    const first = await calls.saveApp(await contextOf(t.admin, conversationId), {
      page: "Offers",
      name: "quick-quote",
      title: "Quick quote"
    });
    expect(first).toMatchObject({ saved: true, created: true, revision: 1 });

    // In the builder's Apps list, and open at its draft address with what it reads.
    const listedFor = async (user: UserRecord) =>
      z
        .object({ items: z.array(z.object({ name: z.string() })) })
        .parse(
          (
            await t.expectOk(user.id, "assets.list", {
              params: { kind: "app" },
              query: { workspaceId: t.workspaceId }
            })
          ).json()
        )
        .items.map((item) => item.name);
    expect(await listedFor(t.admin)).toContain("quick-quote");
    const preview = z.object({ url: z.string() }).parse(
      (
        await t.expectOk(t.admin.id, "apps.preview", {
          params: { app: "quick-quote" },
          payload: { mode: "draft" }
        })
      ).json()
    );
    expect(await t.open(preview.url)).toMatchObject({
      status: 200,
      body: expect.stringContaining("first revision")
    });

    // A member of the workspace without the build right finds no trace of it.
    expect(await listedFor(t.kai)).not.toContain("quick-quote");
    expect(
      (
        await t.call(t.kai.id, "apps.preview", {
          params: { app: "quick-quote" },
          payload: { mode: "draft" }
        })
      ).statusCode
    ).not.toBe(200);

    await t.storePage("second revision", {}, { conversationId });
    const second = await calls.saveApp(await contextOf(t.admin, conversationId), {
      page: "Offers",
      name: "quick-quote",
      title: "Quick quote"
    });
    expect(second).toMatchObject({ saved: true, created: false, revision: 2 });
    expect(await stored("quick-quote")).toMatchObject({ revision: 2 });
  });

  /**
   * What a call of the former `page.save` left in the conversation: the folder it kept as the
   * Page `pageId` under the name the agent chose.
   */
  async function recordFormerSave(
    conversationId: string,
    input: { name: string; directory: string },
    pageId: string
  ) {
    await t.stores.conversations.appendMessage({
      clientInstanceId,
      conversationId: asConversationId(conversationId),
      role: "tool",
      text: "Saved",
      metadata: createToolResultMetadata({
        runId: `run_${randomUUID()}`,
        toolCall: { toolCallId: `call_${randomUUID()}`, toolName: "page.save", input },
        result: { status: "success", output: { pageId, number: 1, fileSetId: "fs" } },
        modelOutput: { text: "Saved" }
      })
    });
  }

  // Fails without the link from the former save: the open of the folder was a Page of its own,
  // and the save answered that it never wrote the App.
  it("writes revision 2 of an App the former page.save kept under another name, from an open of its folder", async () => {
    const conversationId = await conversationOf(t.admin, "private");
    // Before workspace.open: page.save { name: "Offers", directory: "offers" }, saved as an App.
    const former = await t.storePage("former", {}, { conversationId });
    await recordFormerSave(conversationId, { name: "Offers", directory: "offers" }, former.pageId);
    await calls.saveApp(await contextOf(t.admin, conversationId), {
      page: "Offers",
      name: "former-offers",
      title: "Former offers"
    });
    expect(await stored("former-offers")).toMatchObject({ revision: 1 });

    // Now: workspace.open { path: "offers" } keeps the folder as the Page "offers".
    const opened = await t.storePage("opened", {}, { conversationId, pageName: "offers" });
    const again = { page: "offers", name: "offers", title: "Offers" };
    const saved = await calls.saveApp(await contextOf(t.admin, conversationId), again);

    expect(saved).toMatchObject({
      saved: true,
      created: false,
      name: "former-offers",
      revision: 2
    });
    expect(await stored("former-offers")).toMatchObject({ revision: 2 });
    // The App is the opened folder's from now on.
    const app = await stored("former-offers");
    if (!app) throw new Error("The App is gone");
    expect(
      await t.stores.configAssets.getConfigAssetPageOrigin({ clientInstanceId, assetId: app.id })
    ).toMatchObject({ pageId: opened.pageId });
    await t.storePage("opened again", {}, { conversationId, pageName: "offers" });
    expect(await calls.saveApp(await contextOf(t.admin, conversationId), again)).toMatchObject({
      saved: true,
      revision: 3
    });
  });

  it("writes no App from a folder the former page.save kept as another Page", async () => {
    const conversationId = await conversationOf(t.admin, "private");
    const former = await t.storePage("former", {}, { conversationId });
    await recordFormerSave(conversationId, { name: "Offers", directory: "quotes" }, former.pageId);
    await calls.saveApp(await contextOf(t.admin, conversationId), {
      page: "Offers",
      name: "former-quotes",
      title: "Former quotes"
    });

    await t.storePage("opened", {}, { conversationId, pageName: "offers" });
    const saved = await calls.saveApp(await contextOf(t.admin, conversationId), {
      page: "offers",
      name: "offers",
      title: "Offers"
    });

    expect(saved).toMatchObject({ saved: false, message: expect.stringContaining("never wrote") });
    expect(await stored("former-quotes")).toMatchObject({ revision: 1 });
  });
});
