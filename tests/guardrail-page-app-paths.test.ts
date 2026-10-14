import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createPlatformAssetCalls, type ChatServerOptions } from "@vivd-catalyst/chat-server";
import {
  PAGE_FILE_SET_HELD_KEY,
  asAgentRunId,
  asConversationId,
  asToolCallId,
  createPlatformId,
  isPageId,
  type ToolExecutionContext,
  type UserRecord
} from "@vivd-catalyst/core";
import {
  ToolRegistry,
  createPageSaveAsAppTool,
  createToolOperationRunner,
  registerToolOperations
} from "@vivd-catalyst/tool-execution";
import { clientInstanceId } from "./support/access-instance";
import { expectStatus, setupAppInstance, type AppInstance } from "./support/app-instance";
import { IBAN, guardedEvents, ibanPattern, noIban } from "./support/guardrails";
import type { ReleaseGuardrailConfig } from "@vivd-catalyst/config-schema";
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
  async function setup(rules: Record<string, ReleaseGuardrailConfig> = noIbanInApps) {
    const t = await setupAppInstance({
      server: (stores) => ({ operations: { events: guardedEvents(stores, rules).events } })
    });
    // The server, and with it its options, is built on the first request.
    await t.instance.call("health.get");
    const options = testServerOptions(t.instance);
    if (!options) throw new Error("The instance has no server options");
    return { t, options, calls: createPlatformAssetCalls(options) };
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

  /** An App made from a Page of a new conversation, and a later save of that Page. */
  async function savedAgain(t: AppInstance, calls: ReturnType<typeof createPlatformAssetCalls>) {
    const conversationId = await privateConversation(t);
    const page = await t.storePage("Angebot ohne Konto", {}, { conversationId });
    await calls.saveAsApp(await contextOf(t, conversationId, "page.save_as_app"), {
      page: "Offers",
      name: "offers",
      title: "Offers"
    });
    await t.storePage(`Konto ${IBAN}`, {}, { conversationId });
    return calls.saveIntoSubjectApp(await contextOf(t, conversationId, "page.save"), {
      pageId: page.pageId
    });
  }

  const hitsOf = async (t: AppInstance) =>
    (
      await t.stores.guardrails.listHits({ clientInstanceId, guardrailName: "no_iban", limit: 5 })
    ).map((hit) => [hit.event, hit.outcome, hit.subjectName]);

  // Fails without the change: the draft was written and the warning was dropped, so the agent
  // could not tell the person.
  it("passes a guardrail's warning about the draft page.save writes on to the agent", async () => {
    const { t, calls } = await setup({
      no_iban: { ...noIbanInApps.no_iban, outcome: "warn" }
    });
    try {
      expect(await savedAgain(t, calls)).toEqual({
        name: "offers",
        title: "Offers",
        saved: true,
        revision: 2,
        warnings: [
          "Guardrail 'No IBAN in Apps' warned about app 'offers': Apps hold no bank account."
        ]
      });
      expect(await draftRevisionOf(t, "offers")).toBe(2);
      expect(await hitsOf(t)).toEqual([["asset.before_write", "warn", "offers"]]);
    } finally {
      await t.close();
    }
  });

  // Fails without the change: the hold was kept as a hit that asked for an approval, which no
  // request was filed for and nobody could give.
  it("blocks the draft page.save writes where a guardrail asks for an approval, and keeps a block", async () => {
    const { t, calls } = await setup({
      no_iban: { ...noIbanInApps.no_iban, outcome: "require_approval" }
    });
    try {
      expect(await savedAgain(t, calls)).toEqual({
        name: "offers",
        title: "Offers",
        saved: false,
        message:
          "Guardrail 'No IBAN in Apps' blocked app 'offers': Apps hold no bank account. It asks for another person's approval, which a save of a Page cannot wait for. The App's draft was not written; the Page is saved. Ask the person to use Update app on the Page, where the write can wait for the approval."
      });
      expect(await draftRevisionOf(t, "offers")).toBe(1);
      expect(await hitsOf(t)).toEqual([["asset.before_write", "block", "offers"]]);
      const pending = await t.stores.approvals.listApprovalRequests({
        clientInstanceId,
        kinds: ["operation_call"],
        status: "pending"
      });
      expect(pending).toEqual([]);
    } finally {
      await t.close();
    }
  });

  // Fails without the change: the hit kept `block` and the guardrail's reason and nothing
  // else, so its page and its counts said a guardrail that asks for an approval had blocked.
  it("keeps a hit that says the block answered a request for an approval", async () => {
    const { t, calls } = await setup({
      no_iban: noIban({
        displayName: "IBAN needs a look",
        filter: { kind: "app" },
        check: { kind: "pattern", pattern: ibanPattern, reason: "Kontonummer prüfen" },
        outcome: "require_approval"
      })
    });
    try {
      const saved = await savedAgain(t, calls);
      // A reason without a full stop gets one, and one with it no second.
      expect(saved).toMatchObject({
        saved: false,
        message: expect.stringMatching(
          /^Guardrail 'IBAN needs a look' blocked app 'offers': Kontonummer prüfen\. It asks/u
        )
      });
      const [hit, ...more] = await t.stores.guardrails.listHits({
        clientInstanceId,
        guardrailName: "no_iban",
        limit: 5
      });
      expect(more).toEqual([]);
      expect(hit).toMatchObject({
        outcome: "block",
        message: "Kontonummer prüfen",
        convertedFrom: "require_approval"
      });
    } finally {
      await t.close();
    }
  });

  // Fails without the change: a reason that ends in an ellipsis was given a full stop after it.
  for (const outcome of ["block", "require_approval"] as const) {
    it(`ends the first sentence of the refusal in the ellipsis of the reason (${outcome})`, async () => {
      const { t, calls } = await setup({
        no_iban: noIban({
          displayName: "No IBAN",
          filter: { kind: "app" },
          check: { kind: "pattern", pattern: ibanPattern, reason: "Bitte Kontonummer prüfen…" },
          outcome
        })
      });
      try {
        expect(await savedAgain(t, calls)).toMatchObject({
          saved: false,
          message: expect.stringMatching(
            /^Guardrail 'No IBAN' blocked app 'offers': Bitte Kontonummer prüfen… (?:It asks|The App's)/u
          )
        });
      } finally {
        await t.close();
      }
    });
  }
});

describe("a page.save_as_app a guardrail holds, through the operation runner", () => {
  // The agent's call takes the path every tool call takes: the operation of the tool, its
  // before-events, the request filed for the hold and the job that runs it once approved.
  it("holds the call, keeps the revision its guardrail read, and writes it once approved", async () => {
    const t = await setupAppInstance({
      server: (stores) => ({
        operations: {
          events: guardedEvents(stores, {
            no_iban: { ...noIbanInApps.no_iban, outcome: "require_approval" }
          }).events
        },
        // The agent lists the tool, as a conversation that builds a Page offers it.
        agentToolNames: (agentName: string) =>
          agentName === "assistant" ? ["page.save_as_app"] : []
      })
    });
    try {
      await t.instance.call("health.get");
      const options: ChatServerOptions | undefined = testServerOptions(t.instance);
      const operationCalls = options?.operationCalls;
      if (!options || !operationCalls) throw new Error("The instance has no operation calls");
      const tool = createPageSaveAsAppTool(createPlatformAssetCalls(options));
      if (!(await operationCalls.registry.resolve(tool.name))) {
        registerToolOperations(operationCalls.registry, [tool], { clientInstanceId });
      }
      const runTool = createToolOperationRunner(
        operationCalls.deps,
        new ToolRegistry({ tools: [tool] })
      );

      const conversationId = z.object({ id: z.string() }).parse(
        (
          await t.expectOk(t.admin.id, "conversations.create", {
            payload: { title: "Offers" }
          })
        ).json()
      ).id;
      const { pageId } = await t.storePage(`Konto ${IBAN}`, {}, { conversationId });
      if (!isPageId(pageId)) throw new Error("No Page");
      const [looked] = await t.stores.pages.listPageFileSets({ clientInstanceId, pageId });
      const request = {
        toolName: tool.name,
        toolCallId: asToolCallId(`call_${randomUUID()}`),
        agentRunId: asAgentRunId(`run_${randomUUID()}`),
        conversationId: asConversationId(conversationId),
        agentName: "assistant",
        input: { page: "Offers", name: "offers", title: "Offers" }
      };
      const result = await runTool(request, {
        user: {
          id: t.admin.id,
          externalUserId: t.admin.id,
          displayLabel: t.admin.displayLabel,
          roles: t.admin.roles,
          permissions: t.admin.permissions,
          permissionRefs: t.admin.permissionRefs,
          clientInstanceId,
          authSource: "test"
        },
        clientInstanceId,
        correlationId: `corr_${randomUUID()}`
      });
      expect(JSON.stringify(result)).toContain("This call has NOT run");

      const [held] = await t.stores.operationRuns.list({ clientInstanceId });
      expect(held).toMatchObject({ operation: "page.save_as_app", status: "pending_approval" });
      const approvalRequestId = held?.approvalRequestId ?? "";
      const filed = await t.stores.approvals.getApprovalRequest({
        clientInstanceId,
        requestId: approvalRequestId
      });
      // The revision the guardrail read is kept beside the input.
      expect(filed?.payload).toMatchObject({
        heldInput: { [PAGE_FILE_SET_HELD_KEY]: looked?.id }
      });
      expect(await draftRevisionOf(t, "offers")).toBeUndefined();

      // The Page is saved anew while the call waits; the approval writes the revision it held.
      await t.storePage("second revision", {}, { conversationId });
      await approve(t, approvalRequestId);
      const [done] = await t.stores.operationRuns.list({ clientInstanceId });
      expect(done).toMatchObject({ id: held?.id, status: "done" });
      expect(await draftRevisionOf(t, "offers")).toBe(1);
    } finally {
      await t.close();
    }
  });
});
