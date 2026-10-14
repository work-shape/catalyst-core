import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createPlatformAssetCalls } from "@vivd-catalyst/chat-server";
import {
  PAGE_FILE_SET_HELD_KEY,
  asAgentRunId,
  asConversationId,
  asToolCallId,
  createPlatformId,
  type ToolExecutionContext,
  type UserRecord
} from "@vivd-catalyst/core";
import { createPageSaveAsAppTool } from "@vivd-catalyst/tool-execution";
import { clientInstanceId } from "./support/access-instance";
import { expectStatus, setupAppInstance, type AppInstance } from "./support/app-instance";
import { IBAN, guardedEvents, ibanPattern, noIban } from "./support/guardrails";
import { fileTestDatabaseUrl } from "./support/test-database";
import { getTestJobs, testServerOptions } from "./support/test-instance";

// The ways an App is written from a Page beside `apps.create_from_page` and
// `apps.update_from_page`: the agent's `page.save_as_app` and the App draft a later `page.save`
// writes (A3), and a write held by a policy rather than a guardrail. Each writes the Page
// revision the guardrails read or the approval was asked about.

const noIbanInApps = {
  no_iban: noIban({
    displayName: "No IBAN in Apps",
    filter: { kind: "app" },
    check: { kind: "pattern", pattern: ibanPattern, reason: "Apps hold no bank account." }
  })
};

const heldSchema = z.object({
  status: z.literal("pending_approval"),
  approvalRequestId: z.string()
});

/** The Page revision an App's draft was copied from. */
async function draftRevisionOf(t: AppInstance, name: string): Promise<number | undefined> {
  const asset = await t.stores.configAssets.getConfigAsset({
    clientInstanceId,
    kind: "app",
    name
  });
  const origin =
    asset &&
    (await t.stores.configAssets.getConfigAssetPageOrigin({ clientInstanceId, assetId: asset.id }));
  return origin?.fileSetNumber;
}

async function approve(t: AppInstance, requestId: string) {
  expectStatus(
    await t.call(t.admin.id, "approval_requests.decide", {
      params: { requestId },
      payload: { decision: "approve" }
    }),
    200
  );
  await getTestJobs(t.instance).runDue();
}

describe("an App written from a Page that waited for an approval", () => {
  // Fails without the change: a call held by a policy, where no guardrail read the Page, kept no
  // revision, and the approval wrote the Page's newest revision, which nobody was asked about.
  it("writes the revision there was when a policy held the call", async () => {
    const t = await setupAppInstance({
      server: () => ({
        operations: {
          centralPolicySettings: () => [{ operation: "apps.create_from_page", value: "approval" }]
        }
      })
    });
    try {
      const page = await t.storePage("first revision, looked at");
      const { approvalRequestId } = heldSchema.parse(
        (
          await t.call(t.admin.id, "apps.create_from_page", {
            payload: { ...page, name: "offers", title: "Offers", workspaceId: t.workspaceId }
          })
        ).json()
      );
      await t.storePage("second revision", {}, { conversationId: page.conversationId });
      await approve(t, approvalRequestId);
      expect(await draftRevisionOf(t, "offers")).toBe(1);
    } finally {
      await t.close();
    }
  });

  // Fails without the change: everything a request held beside the input was merged over it, so
  // a held field the operation does not declare changed what the call wrote.
  it("merges only the fields the operation declares into a held call's input", async () => {
    const t = await setupAppInstance({
      server: () => ({
        operations: {
          centralPolicySettings: () => [{ operation: "apps.create_from_page", value: "approval" }]
        }
      })
    });
    const sql = postgres(await fileTestDatabaseUrl(), { max: 1, onnotice: () => undefined });
    try {
      const page = await t.storePage("first revision");
      const { approvalRequestId } = heldSchema.parse(
        (
          await t.call(t.admin.id, "apps.create_from_page", {
            payload: { ...page, name: "offers", title: "Offers", workspaceId: t.workspaceId }
          })
        ).json()
      );
      // What a before-event of a later release might hold: a field it has no business in.
      await sql`update approval_requests
        set payload = jsonb_set(payload, '{heldInput,name}', '"other-name"')
        where id = ${approvalRequestId}`;
      await approve(t, approvalRequestId);
      expect(await draftRevisionOf(t, "offers")).toBe(1);
      expect(await draftRevisionOf(t, "other-name")).toBeUndefined();
    } finally {
      await sql.end();
      await t.close();
    }
  });
});

describe("an App the agent writes from a Page of its conversation", () => {
  async function setup() {
    const t = await setupAppInstance({
      server: (stores) => ({ operations: { events: guardedEvents(stores, noIbanInApps).events } })
    });
    // The server, and with it its options, is built on the first request.
    await t.instance.call("health.get");
    const options = testServerOptions(t.instance);
    if (!options) throw new Error("The instance has no server options");
    return { t, calls: createPlatformAssetCalls(options) };
  }

  const identity = (user: UserRecord) => ({
    id: user.id,
    externalUserId: user.id,
    displayLabel: user.displayLabel,
    roles: user.roles,
    permissions: user.permissions,
    permissionRefs: user.permissionRefs,
    clientInstanceId,
    authSource: "test"
  });

  async function contextOf(
    t: AppInstance,
    conversationId: string,
    toolName: string
  ): Promise<ToolExecutionContext> {
    const correlationId = `corr_${randomUUID()}`;
    const run = await t.stores.operationRuns.create({
      id: createPlatformId<"OperationRunId">("oprun"),
      clientInstanceId,
      operation: toolName,
      effect: "changing",
      actor: { kind: "user", id: t.admin.id, label: t.admin.displayLabel },
      origin: { kind: "user" },
      target: "live",
      inputHash: randomUUID().replace(/-/gu, "").padEnd(64, "a"),
      correlationId,
      startedAt: new Date().toISOString()
    });
    if (!run) throw new Error("No run");
    return {
      user: identity(t.admin),
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

  async function privateConversation(t: AppInstance) {
    return z
      .object({ id: z.string() })
      .parse(
        (
          await t.expectOk(t.admin.id, "conversations.create", { payload: { title: "Offers" } })
        ).json()
      ).id;
  }

  // Fails without the change: page.save_as_app named no before-event, so the agent's App was
  // written past `asset.before_write`, and the tool held nothing for an approval.
  it("asks the guardrails about the App page.save_as_app writes, and copies the revision they read", async () => {
    const { t, calls } = await setup();
    try {
      const tool = createPageSaveAsAppTool(calls);
      expect(tool.heldInputKeys).toEqual([PAGE_FILE_SET_HELD_KEY]);
      const conversationId = await privateConversation(t);
      await t.storePage(`Konto ${IBAN}`, {}, { conversationId });
      const input = { page: "Offers", name: "offers", title: "Offers" };
      const [event, ...more] = await calls.saveAsAppBeforeEvents(
        asConversationId(conversationId),
        input
      );
      expect(more).toEqual([]);
      if (!event) throw new Error("No event");
      expect(event).toMatchObject({
        name: "asset.before_write",
        subject: { kind: "app", name: "offers" }
      });
      const fields = await event.checkable();
      expect(JSON.stringify(fields)).toContain("3704 0044");

      // The revision the event read is the one written, whatever the Page is saved as since.
      await t.storePage("a later revision", {}, { conversationId });
      const created = await calls.saveAsApp(
        { ...(await contextOf(t, conversationId, "page.save_as_app")), beforeEvents: [event] },
        input
      );
      expect(created).toMatchObject({ name: "offers", revision: 1 });
      expect(await draftRevisionOf(t, "offers")).toBe(1);
      expect(await event.heldInput?.()).toEqual({ [PAGE_FILE_SET_HELD_KEY]: expect.any(String) });
    } finally {
      await t.close();
    }
  });

  // Fails without the change: a save of the Page wrote the App's draft past every guardrail.
  it("leaves the App's draft unwritten where a guardrail blocks the revision page.save stored", async () => {
    const { t, calls } = await setup();
    try {
      const conversationId = await privateConversation(t);
      const page = await t.storePage("Angebot ohne Konto", {}, { conversationId });
      await calls.saveAsApp(await contextOf(t, conversationId, "page.save_as_app"), {
        page: "Offers",
        name: "offers",
        title: "Offers"
      });
      await t.storePage(`Konto ${IBAN}`, {}, { conversationId });
      const saved = await calls.saveIntoSubjectApp(
        await contextOf(t, conversationId, "page.save"),
        { pageId: page.pageId }
      );
      expect(saved).toMatchObject({
        saved: false,
        message: expect.stringContaining(
          "Guardrail 'No IBAN in Apps' blocked app 'offers': Apps hold no bank account."
        )
      });
      expect(await draftRevisionOf(t, "offers")).toBe(1);
      const hits = await t.stores.guardrails.listHits({
        clientInstanceId,
        guardrailName: "no_iban",
        limit: 5
      });
      expect(hits.map((hit) => [hit.event, hit.subjectKind, hit.subjectName])).toEqual([
        ["asset.before_write", "app", "offers"]
      ]);
    } finally {
      await t.close();
    }
  });
});
