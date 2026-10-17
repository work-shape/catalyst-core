import { asConversationId, scheduleDedupeKey } from "@work-shape/catalyst-core";
import { DeterministicModelProvider } from "@work-shape/catalyst-model-provider";
import { expireConversationsJob } from "@work-shape/catalyst-server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { personalConversationListInput } from "./support/fixtures";
import { createAssetToolsFixture, OTHER } from "./support/platform-asset-tools";
import { getTestJobs } from "./support/test-instance";
import { withTestSql } from "./support/test-sql";

// The Try conversation beside a Build conversation on an agent's page (TRY-1b,
// navigation-and-layout.md 4.7c, check NAV 32): one per Build conversation and agent, opened by
// whoever may decide on the agent's proposal, never in a conversation list, its usage marked
// `preview`, and deleted on Apply, on Discard and with its Build conversation while its audit
// and usage events stay.

const AGENT = { kind: "agent", name: "test_agent" };
const openSchema = z.object({
  conversation: z.object({ id: z.string(), visibility: z.string(), status: z.string() }),
  preview: z.literal(true)
});
const idSchema = z.object({ id: z.string() });
const listSchema = z.object({ items: z.array(z.object({ id: z.string() })) });
const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const auditRowSchema = z.object({
  type: z.string(),
  actor: z.object({ externalUserId: z.string().optional() }).loose().nullable(),
  metadata: z.object({ requestedBy: z.string().optional() }).loose()
});

describe("the Try conversation of an agent", () => {
  beforeAll(() => {
    // Keep the scripted provider's answer, without pacing its words.
    vi.spyOn(DeterministicModelProvider.prototype, "stream").mockImplementation(async function* (
      this: DeterministicModelProvider,
      request
    ) {
      yield { type: "completed", completion: await this.complete(request) };
    });
  });
  afterAll(() => vi.restoreAllMocks());

  async function fixture(options: { filesStore?: boolean } = {}) {
    // A person may change an agent's instructions outside a release, and nothing else.
    const t = await createAssetToolsFixture("in_process", ["instructions"], options);
    const address = (conversationId: string) => ({
      params: { name: AGENT.name, conversationId }
    });
    const open = (conversationId: string, as?: string) =>
      t.app.call("agents.try.open", address(conversationId), as);
    const opened = async (conversationId: string) =>
      openSchema.parse((await t.ok(open(conversationId))).json()).conversation.id;
    /** A Build conversation about the agent; `plain`, about no asset. */
    const converse = async (as?: string, plain = false) =>
      idSchema.parse((await t.ok(t.converse(plain ? undefined : AGENT, as))).json()).id;
    const live = async () => {
      const stored = await t.app.stores.configAssets.getConfigAsset({
        clientInstanceId: t.clientInstanceId,
        ...AGENT
      });
      return {
        revision: stored?.revision ?? 0,
        config: z.object({}).loose().parse(stored?.config)
      };
    };
    /** The agent's save in the Build conversation: a proposal at the next revision. */
    const propose = async (buildId: string, instructions: string, expectedRevision: number) => {
      const { config } = await live();
      return t.call(buildId, "platform.assets.put", {
        config: { ...config, instructions },
        expectedRevision
      });
    };
    const listed = async (as?: string, titleQuery?: string) => {
      const input = await personalConversationListInput(
        t.app,
        as === undefined ? {} : { "x-dev-user-id": as }
      );
      const query = { ...input.query, ...(titleQuery === undefined ? {} : { query: titleQuery }) };
      const response = await t.ok(t.app.call("conversations.list", { ...input, query }));
      return listSchema.parse(response.json()).items.map((item) => item.id);
    };
    const status = async (conversationId: string) =>
      (
        await t.app.stores.conversations.getConversation(
          t.clientInstanceId,
          asConversationId(conversationId)
        )
      )?.status;
    const linked = (conversationId: string) =>
      withTestSql(
        (sql) => sql`
          select conversation_id from agent_try_conversations
          where conversation_id = ${conversationId}`
      ).then((rows) => rows.length > 0);
    const deletions = (conversationId: string) =>
      withTestSql(
        (sql) => sql`
          select type, actor, metadata from audit_events
          where subject = ${conversationId} and type = 'conversation.deleted'`
      ).then((rows) => rows.map((row) => auditRowSchema.parse(row)));
    /** Makes a person's own conversation about the agent, as its page would. */
    const aboutAgent = (conversationId: string) =>
      t.app.stores.conversations.setConversationSubject({
        clientInstanceId: t.clientInstanceId,
        conversationId: asConversationId(conversationId),
        subject: AGENT
      });
    const operationRuns = (conversationId: string) =>
      withTestSql(
        (sql) => sql`select id from operation_runs where conversation_id = ${conversationId}`
      ).then((rows) => rows.length);
    const usage = async (conversationId: string) =>
      (await t.app.stores.usage.listModelUsageEvents({ clientInstanceId: t.clientInstanceId }))
        .filter((event) => event.conversationId === conversationId)
        .map((event) => event.preview);
    return {
      ...t,
      address,
      open,
      opened,
      converse,
      live,
      propose,
      listed,
      status,
      linked,
      deletions,
      aboutAgent,
      operationRuns,
      usage
    };
  }

  it("opens one per Build conversation and agent, shows it in no list and marks its usage preview", async () => {
    const t = await fixture();
    const build = await t.converse();
    const response = openSchema.parse((await t.ok(t.open(build))).json());
    expect(response.conversation).toMatchObject({ visibility: "private", status: "active" });
    const tried = response.conversation.id;
    // A second open answers the same one.
    expect(await t.opened(build)).toBe(tried);

    await t.say(build, "Hello from Build.");
    await t.say(tried, "Hello from Try.");
    // A conversation with messages is listed; the Try conversation is not, also not by title.
    expect(await t.listed()).toContain(build);
    expect(await t.listed()).not.toContain(tried);
    expect(await t.listed(undefined, "Try")).not.toContain(tried);

    // Every model call of the Try conversation is preview usage; the Build conversation's is not.
    const tryUsage = await t.usage(tried);
    expect(tryUsage.length).toBeGreaterThan(0);
    expect(tryUsage.every(Boolean)).toBe(true);
    const buildUsage = await t.usage(build);
    expect(buildUsage.length).toBeGreaterThan(0);
    expect(buildUsage.some(Boolean)).toBe(false);

    // A Try conversation is tried in, never built in.
    expect((await t.open(tried)).statusCode).toBe(404);
  }, 120_000);

  it("opens only for who may write the agent, beside their own Build conversation", async () => {
    const t = await fixture();
    const build = await t.converse();
    // Another person's Build conversation is answered as missing.
    expect((await t.open(build, OTHER)).statusCode).toBe(404);
    // Who may read the agent and not write it does not open one beside their own conversation.
    const own = await t.converse(OTHER, true);
    await t.aboutAgent(own);
    const holderId = (
      await t.app.stores.conversations.getConversation(t.clientInstanceId, asConversationId(own))
    )?.createdByUserId;
    const agent = await t.app.stores.configAssets.getConfigAsset({
      clientInstanceId: t.clientInstanceId,
      ...AGENT
    });
    await t.ok(
      t.app.call("permissions.grant", {
        payload: {
          holderKind: "user",
          holderId,
          action: "agent.read",
          effect: "allow",
          scopeKind: "asset",
          scopeId: agent?.id
        }
      })
    );
    expect(
      (await t.app.call("agents.draft.get", { params: { name: AGENT.name } }, OTHER)).statusCode
    ).toBe(404);
    const refused = await t.open(own, OTHER);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(
      await t.app.stores.agentTryConversations.list({
        clientInstanceId: t.clientInstanceId,
        buildConversationId: asConversationId(own)
      })
    ).toEqual([]);
  }, 120_000);

  it("refuses a conversation about no agent as a missing one", async () => {
    const t = await fixture();
    const plain = await t.converse(undefined, true);
    const refused = await t.open(plain);
    const missing = await t.open("conv_missing");
    expect(refused.statusCode).toBe(404);
    // The same answer as for a conversation that does not exist: nothing tells them apart.
    expect(errorSchema.parse(refused.json()).error).toEqual({
      ...errorSchema.parse(missing.json()).error,
      code: "NOT_FOUND"
    });
    // Once the conversation is about the agent, it is its Build conversation.
    await t.aboutAgent(plain);
    await t.ok(t.open(plain));
  }, 120_000);

  it("goes with an Apply and with a Discard, keeping its audit and usage, and opens anew after", async () => {
    const t = await fixture();
    const before = await t.live();
    const build = await t.converse();
    await t.propose(build, "Proposed once.", before.revision);
    const otherBuild = await t.converse();
    const otherTry = await t.opened(otherBuild);
    const first = await t.opened(build);
    await t.say(first, "Try it.");
    const usage = await t.usage(first);
    expect(usage.length).toBeGreaterThan(0);

    await t.ok(t.app.call("assets.publish", { params: AGENT, payload: { revision: 1 } }));
    expect(await t.status(otherTry)).toBe("deleted");
    expect(await t.linked(otherTry)).toBe(false);
    expect(await t.status(first)).toBe("deleted");
    expect(await t.linked(first)).toBe(false);
    expect(await t.deletions(first)).toEqual([
      expect.objectContaining({
        actor: expect.objectContaining({ externalUserId: "owner" }),
        metadata: expect.objectContaining({ requestedBy: "draft_published", cleanup: "complete" })
      })
    ]);
    expect(await t.usage(first)).toEqual(usage);

    // The next open makes another; a Discard removes that one.
    const secondOtherTry = await t.opened(otherBuild);
    const second = await t.opened(build);
    expect(second).not.toBe(first);
    await t.propose(build, "Proposed twice.", (await t.live()).revision);
    await t.ok(
      t.app.call("agents.draft.discard", {
        params: { name: AGENT.name },
        payload: {
          expectedRevision: (
            await t.app.stores.agentProposals.get({
              clientInstanceId: t.clientInstanceId,
              agentId:
                (
                  await t.app.stores.configAssets.getConfigAsset({
                    clientInstanceId: t.clientInstanceId,
                    ...AGENT
                  })
                )?.id ?? ""
            })
          )?.revision
        }
      })
    );
    expect(await t.status(secondOtherTry)).toBe("deleted");
    expect(await t.linked(secondOtherTry)).toBe(false);
    expect(await t.status(second)).toBe("deleted");
    expect(await t.linked(second)).toBe(false);
    expect(await t.deletions(second)).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({ requestedBy: "draft_discarded" })
      })
    ]);
    // The Build conversation stays.
    expect(await t.status(build)).toBe("active");
  }, 120_000);

  it("goes with its Build conversation", async () => {
    const t = await fixture();
    const build = await t.converse();
    const tried = await t.opened(build);
    await t.ok(t.app.call("conversations.delete", { params: { conversationId: build } }));
    expect(await t.status(tried)).toBe("deleted");
    expect(await t.linked(tried)).toBe(false);
    expect(await t.deletions(tried)).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({ requestedBy: "build_conversation_deleted" })
      })
    ]);
  }, 120_000);

  it("keeps a replaced Try conversation in reach of the retry until its cleanup is through", async () => {
    const t = await fixture({ filesStore: true });
    const before = await t.live();
    const build = await t.converse();
    const first = await t.opened(build);
    // A call in the Try conversation leaves an Operation Run, and nothing else to clean up.
    await t.call(first, "platform.assets.get");
    expect(await t.operationRuns(first)).toBeGreaterThan(0);
    await t.propose(build, "Proposed.", before.revision);

    // The cleanup after the Discard fails once, at the Operation Runs.
    const removeRuns = vi
      .spyOn(t.app.stores.operationRuns, "deleteOfConversations")
      .mockRejectedValueOnce(new Error("transient"));
    await t.ok(
      t.app.call("agents.draft.discard", {
        params: { name: AGENT.name },
        payload: {
          expectedRevision: (
            await t.app.stores.agentProposals.get({
              clientInstanceId: t.clientInstanceId,
              agentId:
                (
                  await t.app.stores.configAssets.getConfigAsset({
                    clientInstanceId: t.clientInstanceId,
                    ...AGENT
                  })
                )?.id ?? ""
            })
          )?.revision
        }
      })
    );
    expect(removeRuns).toHaveBeenCalled();
    removeRuns.mockRestore();
    expect(await t.status(first)).toBe("deleted");
    expect(await t.operationRuns(first)).toBeGreaterThan(0);

    // The next open makes another beside it; the deleted one stays in reach of the retry.
    const second = await t.opened(build);
    expect(second).not.toBe(first);
    expect(await t.linked(first)).toBe(true);
    expect(await t.listed()).not.toContain(second);
    expect(
      await t.app.stores.files.listConversationsPendingObjectCleanup({
        clientInstanceId: t.clientInstanceId,
        limit: 100
      })
    ).toContain(first);

    // The retention job retries the cleanup: it removes what was left, then the link. The new
    // one stays.
    await t.app.stores.jobs.enqueue(
      expireConversationsJob,
      {},
      {
        clientInstanceId: t.clientInstanceId,
        dedupeKey: scheduleDedupeKey(expireConversationsJob.kind)
      }
    );
    await getTestJobs(t.app).runDue();
    expect(await t.operationRuns(first)).toBe(0);
    expect(await t.linked(first)).toBe(false);
    expect(await t.opened(build)).toBe(second);
  }, 120_000);

  it("goes with an account deletion that reaches its Build conversation first", async () => {
    const t = await fixture();
    const build = await t.converse(OTHER, true);
    await t.aboutAgent(build);
    const person = await t.app.stores.conversations.getConversation(
      t.clientInstanceId,
      asConversationId(build)
    );
    // Opened as the store opens it: the person holds no write right on the agent here.
    const agent = await t.app.stores.configAssets.getConfigAsset({
      clientInstanceId: t.clientInstanceId,
      ...AGENT
    });
    const { conversation } = await t.app.stores.agentTryConversations.open({
      clientInstanceId: t.clientInstanceId,
      buildConversationId: asConversationId(build),
      agentId: agent?.id ?? "",
      agent: AGENT,
      createdByUserId: person?.createdByUserId ?? "",
      createdByExternalUserId: OTHER,
      title: "Try",
      retainedUntil: new Date(Date.now() + 86_400_000).toISOString()
    });
    // The Build conversation is the newer one, so the deletion lists it first.
    await t.say(conversation.id, "Try it.", OTHER);
    await t.say(build, "Build it.", OTHER);

    const deleted = await t.app.call("users.delete", {
      params: { userId: person?.createdByUserId ?? "" }
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    // The personal workspace went with the account, its conversations' rows with it.
    expect(await t.status(build)).toBeUndefined();
    expect(await t.status(conversation.id)).toBeUndefined();
    expect(await t.linked(conversation.id)).toBe(false);
  }, 120_000);
});
