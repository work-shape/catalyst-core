import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { APP_ASSET_KIND } from "@vivd-catalyst/api-contract";
import {
  createPlatformAssetCalls,
  createSandboxAssetRepo,
  type AssetRepoCommitRunner
} from "@vivd-catalyst/chat-server";
import {
  asAgentRunId,
  asConversationId,
  asToolCallId,
  createPlatformId,
  isAppError,
  type CentralPolicySetting,
  type ToolExecutionContext,
  type UserRecord
} from "@vivd-catalyst/core";
import {
  createPageSaveAsAppTool,
  createPageSaveTool,
  LocalWorkspaceCommandProcessExecutor,
  WorkspaceCommandService
} from "@vivd-catalyst/tool-execution";
import { clientInstanceId } from "./support/access-instance";
import { appFiles, expectStatus, setupAppInstance, type AppInstance } from "./support/app-instance";
import { assetRepoCommandFromSource } from "./support/asset-repo";
import { testServerOptions } from "./support/test-instance";

// A Page kept as an App from its conversation, on the server: page.save_as_app and the App
// draft a later page.save writes, called as the agent's tools call them, against the real
// rights, stores, commits and policy. Each case fails without A3: neither call existed. The
// cases of a draft moved to another Page, of a commit that failed and of a policy fail without
// the follow-ups of the review: the save answered nothing, failed the save, or ignored the
// setting.

const idSchema = z.object({ id: z.string() });

describe("a Page made an App from its conversation", () => {
  let t: AppInstance;
  let calls: ReturnType<typeof createPlatformAssetCalls>;
  let scratch: string;
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
      server: () => ({ operations: { centralPolicySettings: () => settings } })
    });
    // The server, and with it its options, is built on the first request.
    await t.instance.call("health.get");
    const options = testServerOptions(t.instance);
    if (!options) throw new Error("The instance has no server options");
    calls = createPlatformAssetCalls(options);
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
    toolName = "page.save_as_app"
  ): Promise<ToolExecutionContext> {
    const correlationId = `corr_${randomUUID()}`;
    const run = await t.stores.operationRuns.create({
      id: createPlatformId<"OperationRunId">("oprun"),
      clientInstanceId,
      operation: toolName,
      effect: "changing",
      actor: { kind: "user", id: user.id, label: user.displayLabel },
      origin: { kind: "user" },
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

  it("refuses a member without app.write in a private conversation of the Shared Workspace, and makes no App", async () => {
    const conversationId = await conversationOf(t.kai, "private");
    await t.storePage("kai's page", {}, { conversationId });

    const refused = await refusal(
      calls.saveAsApp(await contextOf(t.kai, conversationId), {
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
      calls.saveAsApp(await contextOf(t.admin, page.conversationId), {
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

  it("writes the App's next draft only from the same Page in the same conversation", async () => {
    const conversationId = await conversationOf(t.admin, "private");
    const page = await t.storePage("first", {}, { conversationId });
    const created = await calls.saveAsApp(await contextOf(t.admin, conversationId), {
      page: "Offers",
      name: "bound-app",
      title: "Bound"
    });
    expect(created).toMatchObject({ kind: "app", name: "bound-app", revision: 1 });
    expect(await subjectOf(conversationId)).toEqual({ kind: "app", name: "bound-app" });

    // Same Page, same conversation: the next draft.
    await t.storePage("second", {}, { conversationId });
    const saved = await calls.saveIntoSubjectApp(
      await contextOf(t.admin, conversationId, "page.save"),
      { pageId: page.pageId }
    );
    expect(saved).toMatchObject({ saved: true, revision: 2 });

    // Another conversation made about the same App, with a Page of its own: nothing written.
    const other = await conversationOf(t.admin, "private");
    const otherPage = await t.storePage("other", {}, { conversationId: other });
    await t.stores.conversations.setConversationSubject({
      clientInstanceId,
      conversationId: asConversationId(other),
      subject: { kind: "app", name: "bound-app" }
    });
    expect(
      await calls.saveIntoSubjectApp(await contextOf(t.admin, other, "page.save"), {
        pageId: otherPage.pageId
      })
    ).toBeUndefined();
    // The other conversation names this conversation's Page id: still nothing.
    expect(
      await calls.saveIntoSubjectApp(await contextOf(t.admin, other, "page.save"), {
        pageId: page.pageId
      })
    ).toBeUndefined();
    expect(await stored("bound-app")).toMatchObject({ revision: 2 });
  });

  it("does not write over a draft changed elsewhere, and says so", async () => {
    const conversationId = await conversationOf(t.admin, "private");
    const page = await t.storePage("first", {}, { conversationId });
    await calls.saveAsApp(await contextOf(t.admin, conversationId), {
      page: "Offers",
      name: "moved-draft",
      title: "Moved"
    });
    expectStatus(await t.putApp(t.admin.id, "moved-draft", appFiles("elsewhere")), 200);
    expect(await stored("moved-draft")).toMatchObject({ revision: 2 });

    await t.storePage("second", {}, { conversationId });
    const saved = await calls.saveIntoSubjectApp(
      await contextOf(t.admin, conversationId, "page.save"),
      { pageId: page.pageId }
    );

    expect(saved).toMatchObject({ saved: false });
    expect(await stored("moved-draft")).toMatchObject({ revision: 2 });
  });

  it("says the draft moved when another Page was put into the App since (journey cell b)", async () => {
    const conversationId = await conversationOf(t.admin, "private");
    const page = await t.storePage("first", {}, { conversationId });
    await calls.saveAsApp(await contextOf(t.admin, conversationId), {
      page: "Offers",
      name: "relinked",
      title: "Relinked"
    });
    // Someone puts another Page into the App with "Update app".
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
    const saved = await calls.saveIntoSubjectApp(
      await contextOf(t.admin, conversationId, "page.save"),
      { pageId: page.pageId }
    );

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
    const page = await t.storePage("kai first", {}, { conversationId });
    await calls.saveAsApp(await contextOf(t.kai, conversationId), {
      page: "Offers",
      name: "kai-lost",
      title: "Kai"
    });
    await t.stores.access.deleteGrant({ clientInstanceId, grantId: grant.id });

    await t.storePage("kai second", {}, { conversationId });
    const saved = await calls.saveIntoSubjectApp(
      await contextOf(t.kai, conversationId, "page.save"),
      { pageId: page.pageId }
    );

    expect(saved).toMatchObject({ saved: false });
    expect(await stored("kai-lost")).toMatchObject({ revision: 1 });
  });

  it("answers a commit the instance cannot make as a draft not written, since the Page is saved", async () => {
    const conversationId = await conversationOf(t.admin, "private");
    const page = await t.storePage("first", {}, { conversationId });
    await calls.saveAsApp(await contextOf(t.admin, conversationId), {
      page: "Offers",
      name: "no-commit",
      title: "No commit"
    });
    await t.storePage("second", {}, { conversationId });
    commitFails.next = true;

    // The Page revision is stored at this point: page.save calls this after the build.
    const outcome = await calls
      .saveIntoSubjectApp(await contextOf(t.admin, conversationId, "page.save"), {
        pageId: page.pageId
      })
      .then(
        (value) => ({ answered: value }),
        (error: unknown) => ({ thrown: isAppError(error) ? error.code : String(error) })
      );

    expect(outcome).toMatchObject({ answered: { saved: false } });
  });

  it("records app.created and config_asset.updated without file contents", async () => {
    const conversationId = await conversationOf(t.admin, "private");
    const page = await t.storePage("SECRET-MARKER-ONE", {}, { conversationId });
    const create = await contextOf(t.admin, conversationId);
    await calls.saveAsApp(create, { page: "Offers", name: "audited", title: "Audited" });
    await t.storePage("SECRET-MARKER-TWO", {}, { conversationId });
    const save = await contextOf(t.admin, conversationId, "page.save");
    expect(await calls.saveIntoSubjectApp(save, { pageId: page.pageId })).toMatchObject({
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
    await t.storePage("first", {}, { conversationId });
    const floors = async () => ({
      create: await calls.pageAppPolicyFloor(asConversationId(conversationId), "create"),
      draft: await calls.pageAppPolicyFloor(asConversationId(conversationId), "draft")
    });
    const saveAsApp = createPageSaveAsAppTool(calls);
    const pageSave = createPageSaveTool({
      workspace: new WorkspaceCommandService({
        store: t.stores,
        objectStore: t.objects,
        fileStore: t.objects,
        now: () => new Date().toISOString()
      }).dependencies,
      builds: { build: () => Promise.reject(new Error("not built here")) },
      apps: calls
    });
    const toolFloors = async () => ({
      create: await saveAsApp.policyFloor?.({ conversationId: asConversationId(conversationId) }),
      draft: await pageSave.policyFloor?.({ conversationId: asConversationId(conversationId) })
    });
    try {
      // Nothing set: the tools' own mode stands. A conversation about no App writes no App.
      expect(await floors()).toEqual({ create: undefined, draft: undefined });

      settings.push({ operation: "assets.put", value: "deny", assetKind: APP_ASSET_KIND });
      expect((await floors()).create).toBe("deny");
      await calls.saveAsApp(await contextOf(t.admin, conversationId), {
        page: "Offers",
        name: "held-app",
        title: "Held"
      });
      // From now on the conversation is about the App: the next save of the Page writes it.
      expect(await toolFloors()).toEqual({ create: "deny", draft: "deny" });

      settings.splice(0);
      settings.push({ operation: "assets.put", value: "approval", assetKind: APP_ASSET_KIND });
      expect(await toolFloors()).toEqual({ create: "approval", draft: "approval" });

      // The operations of the App's way from a Page hold each for its own write.
      settings.splice(0);
      settings.push(
        { operation: "apps.create_from_page", value: "deny" },
        { operation: "apps.update_from_page", value: "approval" }
      );
      expect(await toolFloors()).toEqual({ create: "deny", draft: "approval" });

      // A setting on another kind of asset holds for neither.
      settings.splice(0);
      settings.push({ operation: "assets.put", value: "deny", assetKind: "workflow" });
      expect(await toolFloors()).toEqual({ create: undefined, draft: undefined });
    } finally {
      settings.splice(0);
    }
  });
});
