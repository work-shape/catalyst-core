import { afterEach, describe, expect, it } from "vitest";
import {
  asConversationId,
  createAssistantFinalMetadata,
  createPlatformId,
  type UserRecord
} from "@work-shape/catalyst-core";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import {
  agent,
  clientInstanceId,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";
import { getTestJobs } from "./support/test-instance";
import { withTestSql } from "./support/test-sql";

// Written feedback on agent answers (LU-4, limits-usage-analytics-and-feedback.md 3.5, checks
// 18 to 23): the author sends one comment per answer, a holder of `feedback.review` reads it in
// the Inbox and marks it handled, and the author sees only its state.

const DAY_MS = 24 * 60 * 60 * 1000;
const QUESTION = "Which documents does the loan application need?";
const ANSWER = "The last three payslips and the purchase contract.";
const COMMENT = "The answer forgot the land register extract.";

let t: AccessInstance | undefined;
afterEach(async () => {
  await t?.instance.close();
  t = undefined;
});

async function setup(feedbackOn = true): Promise<AccessInstance> {
  t = await setupAccessInstance({
    modules: feedbackOn ? { feedback: { enabled: true } } : {}
  });
  return t;
}

/** A conversation of `user` with one finished answer of `agentName`. */
async function answered(at: AccessInstance, user: UserRecord, agentName = "assistant") {
  const { stores } = at;
  const conversation = await stores.createConversationForTesting({
    clientInstanceId,
    createdByUserId: user.id,
    createdByExternalUserId: user.id,
    title: "Loan",
    retainedUntil: new Date(Date.now() + 30 * DAY_MS).toISOString()
  });
  // Something said before the exchange the comment is about, which no reviewer reads.
  await stores.conversations.appendMessage({
    clientInstanceId,
    conversationId: conversation.id,
    role: "user",
    text: "An earlier private remark"
  });
  const question = await stores.conversations.appendMessage({
    clientInstanceId,
    conversationId: conversation.id,
    role: "user",
    text: QUESTION
  });
  const run = await stores.agentRuns.createAgentRun({
    id: createPlatformId<"AgentRunId">("run"),
    clientInstanceId,
    conversationId: conversation.id,
    ownerUserId: user.id,
    inputMessageId: question.id,
    agentName,
    correlationId: "corr_feedback"
  });
  await stores.conversations.appendMessage({
    clientInstanceId,
    conversationId: conversation.id,
    role: "assistant",
    text: ANSWER,
    metadata: createAssistantFinalMetadata({ runId: run.id })
  });
  const finishedAt = new Date().toISOString();
  await stores.agentRuns.updateAgentRunStatus({
    clientInstanceId,
    runId: run.id,
    status: "completed",
    updatedAt: finishedAt,
    completedAt: finishedAt
  });
  return { conversationId: conversation.id, runId: run.id };
}

async function send(
  at: AccessInstance,
  user: UserRecord,
  answer: { conversationId: string; runId: string },
  includeExchange = true
): Promise<string> {
  const sent = await at.expectOk(user.id, "feedback.send", {
    params: { conversationId: answer.conversationId },
    payload: { runId: answer.runId, text: COMMENT, includeExchange }
  });
  const body = sent.json<{ id: string; state: string; includesExchange: boolean }>();
  expect(body).toMatchObject({ state: "new", includesExchange: includeExchange });
  return body.id;
}

interface InboxItem {
  id: string;
  kind: string;
  status: string;
  preview?: Record<string, unknown>;
}

async function inbox(at: AccessInstance, user: UserRecord): Promise<InboxItem[]> {
  const listed = await at.call(user.id, "approval_requests.list", {
    query: { status: "pending" }
  });
  if (listed.statusCode === 403) return [];
  expect(listed.statusCode).toBe(200);
  return listed
    .json<{ items: InboxItem[] }>()
    .items.filter((item) => item.kind === "feedback_review");
}

/** A shared workspace that owns the agent `team-agent`. */
async function teamAgent(at: AccessInstance) {
  const workspaceId = await at.sharedWorkspace("Team");
  await applyAtCurrentRevisions(at.stores.configAssets, {
    clientInstanceId,
    mutations: [
      {
        type: "upsert",
        kind: "agent",
        name: "team-agent",
        config: agent("team-agent"),
        scope: { kind: "workspace", workspaceId }
      }
    ]
  });
  return workspaceId;
}

describe("feedback with the module off", () => {
  it("refuses every operation (check 18)", async () => {
    const at = await setup(false);
    const answer = await answered(at, at.kai);
    const refused = await at.call(at.kai.id, "feedback.send", {
      params: { conversationId: answer.conversationId },
      payload: { runId: answer.runId, text: COMMENT, includeExchange: true }
    });
    expect(refused.statusCode).toBe(404);
    expect(refused.json()).toMatchObject({ error: { details: { reason: "module_off" } } });
    const listed = await at.call(at.admin.id, "feedback.list", {});
    expect(listed.statusCode).toBe(404);
    // The client reads the switch from the config and shows no control.
    const config = await at.call(at.kai.id, "config.get", {});
    expect(config.json()).toMatchObject({ modules: { feedback: { enabled: false } } });
  });
});

describe("feedback on an agent's answer", () => {
  it("reaches the Inbox of a reviewer with the agent and its revision, and not the author's own list (check 19)", async () => {
    const at = await setup();
    const answer = await answered(at, at.kai);
    const feedbackId = await send(at, at.kai, answer);
    const revision = (
      await at.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: "agent",
        name: "assistant"
      })
    )?.revision;

    // Instance administrators hold `feedback.review` by default.
    const [item, ...more] = await inbox(at, at.admin);
    expect(more).toEqual([]);
    const opened = await at.expectOk(at.admin.id, "approval_requests.get", {
      params: { requestId: item?.id ?? "" }
    });
    expect(opened.json()).toMatchObject({
      kind: "feedback_review",
      preview: {
        agent: { name: "assistant", revision },
        author: { displayLabel: "Kai" },
        text: COMMENT
      }
    });
    const read = await at.expectOk(at.admin.id, "feedback.get", { params: { feedbackId } });
    expect(read.json()).toMatchObject({
      agent: { name: "assistant", revision },
      author: { displayLabel: "Kai" },
      text: COMMENT,
      state: "new"
    });

    // The author reads the state under the message and holds no review item.
    const own = await at.expectOk(at.kai.id, "feedback.list_own", {
      params: { conversationId: answer.conversationId }
    });
    expect(own.json()).toMatchObject({
      items: [{ id: feedbackId, agentRunId: answer.runId, state: "new" }]
    });
    const mine = await at.call(at.kai.id, "approval_requests.list_mine", {});
    expect(
      mine.json<{ items: InboxItem[] }>().items.filter((entry) => entry.kind === "feedback_review")
    ).toEqual([]);
    // Someone without the right reads nothing.
    await at.expectRefused(
      at.lena.id,
      "feedback.get",
      { params: { feedbackId } },
      {
        status: 403,
        code: "FORBIDDEN"
      }
    );
    // One comment per answer.
    const again = await at.call(at.kai.id, "feedback.send", {
      params: { conversationId: answer.conversationId },
      payload: { runId: answer.runId, text: COMMENT, includeExchange: false }
    });
    expect(again.statusCode).toBe(409);
    // Nobody else leaves feedback in Kai's conversation.
    const foreign = await at.call(at.lena.id, "feedback.send", {
      params: { conversationId: answer.conversationId },
      payload: { runId: answer.runId, text: COMMENT, includeExchange: false }
    });
    expect(foreign.statusCode).toBe(404);
  });

  it("is marked handled from the Inbox with a note, and the author then reads it as handled", async () => {
    const at = await setup();
    const answer = await answered(at, at.kai);
    const feedbackId = await send(at, at.kai, answer);
    const [item] = await inbox(at, at.admin);
    await at.expectOk(at.admin.id, "approval_requests.decide", {
      params: { requestId: item?.id ?? "" },
      payload: { decision: "approve", comment: "Added the extract to the checklist." }
    });

    expect(await inbox(at, at.admin)).toEqual([]);
    const read = await at.expectOk(at.admin.id, "feedback.get", { params: { feedbackId } });
    expect(read.json()).toMatchObject({
      state: "handled",
      handled: { byLabel: "Admin", note: "Added the extract to the checklist." }
    });
    const own = await at.expectOk(at.kai.id, "feedback.list_own", {
      params: { conversationId: answer.conversationId }
    });
    const [ownItem] = own.json<{ items: Record<string, unknown>[] }>().items;
    expect(ownItem).toMatchObject({ state: "handled" });
    // The author reads no note and no reviewer.
    expect(JSON.stringify(ownItem)).not.toContain("checklist");
    // A handled comment stays as it is.
    const changed = await at.call(at.kai.id, "feedback.update", {
      params: { conversationId: answer.conversationId, feedbackId },
      payload: { text: "Changed", includeExchange: false }
    });
    expect(changed.statusCode).toBe(409);
    const audit = await at.stores.audit.listAuditEvents({
      clientInstanceId,
      type: "feedback.handled"
    });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain("checklist");
  });

  it("is marked handled through its own operation as well", async () => {
    const at = await setup();
    const feedbackId = await send(at, at.kai, await answered(at, at.kai));
    await at.expectOk(at.admin.id, "feedback.mark_handled", {
      params: { feedbackId },
      payload: { note: "Seen." }
    });
    expect(await inbox(at, at.admin)).toEqual([]);
    const handled = await at.expectOk(at.admin.id, "feedback.list", {
      query: { state: "handled" }
    });
    expect(handled.json()).toMatchObject({ items: [{ id: feedbackId, state: "handled" }] });
  });

  it("is changed and withdrawn by its author, which takes its Inbox item away", async () => {
    const at = await setup();
    const answer = await answered(at, at.kai);
    const feedbackId = await send(at, at.kai, answer, false);
    await at.expectOk(at.kai.id, "feedback.update", {
      params: { conversationId: answer.conversationId, feedbackId },
      payload: { text: "Second thoughts.", includeExchange: true }
    });
    const read = await at.expectOk(at.admin.id, "feedback.get", { params: { feedbackId } });
    expect(read.json()).toMatchObject({
      text: "Second thoughts.",
      exchange: { question: QUESTION, answer: ANSWER }
    });

    await at.expectOk(at.kai.id, "feedback.withdraw", {
      params: { conversationId: answer.conversationId, feedbackId }
    });
    expect(await inbox(at, at.admin)).toEqual([]);
    const gone = await at.call(at.admin.id, "feedback.get", { params: { feedbackId } });
    expect(gone.statusCode).toBe(404);
  });
});

describe("a reviewer for one workspace (check 20)", () => {
  it("reads the feedback on the agents that workspace owns and nothing else", async () => {
    const at = await setup();
    const workspaceId = await teamAgent(at);
    await at.grant(at.lena.id, "feedback.review", { workspaceId });
    const onTeam = await send(at, at.kai, await answered(at, at.kai, "team-agent"));
    const onAssistant = await send(at, at.root, await answered(at, at.root, "assistant"));

    // The Inbox.
    expect((await inbox(at, at.lena)).map((item) => item.preview?.feedbackId)).toEqual([onTeam]);
    expect(await inbox(at, at.admin)).toHaveLength(2);
    // The HTTP API, which the CLI calls.
    const listed = await at.expectOk(at.lena.id, "feedback.list", {});
    expect(listed.json<{ items: { id: string }[] }>().items.map((item) => item.id)).toEqual([
      onTeam
    ]);
    await at.expectOk(at.lena.id, "feedback.get", { params: { feedbackId: onTeam } });
    const refused = await at.call(at.lena.id, "feedback.get", {
      params: { feedbackId: onAssistant }
    });
    expect(refused.statusCode).toBe(404);
    const notHandled = await at.call(at.lena.id, "feedback.mark_handled", {
      params: { feedbackId: onAssistant },
      payload: {}
    });
    expect(notHandled.statusCode).toBe(404);
    // Filtered by agent.
    const byAgent = await at.expectOk(at.admin.id, "feedback.list", {
      query: { agent: "team-agent" }
    });
    expect(byAgent.json<{ items: { id: string }[] }>().items.map((item) => item.id)).toEqual([
      onTeam
    ]);
  });
});

describe("the exchange", () => {
  it("is the one question and answer, kept after the conversation is gone (check 21)", async () => {
    const at = await setup();
    const answer = await answered(at, at.kai);
    const feedbackId = await send(at, at.kai, answer, true);
    await at.expectOk(at.kai.id, "conversations.delete", {
      params: { conversationId: answer.conversationId }
    });
    await expect(
      at.stores.conversations.getConversation(
        clientInstanceId,
        asConversationId(answer.conversationId)
      )
    ).resolves.toMatchObject({ status: "deleted" });

    const read = await at.expectOk(at.admin.id, "feedback.get", { params: { feedbackId } });
    expect(read.json()).toMatchObject({ exchange: { question: QUESTION, answer: ANSWER } });
    expect(JSON.stringify(read.json())).not.toContain("earlier private remark");
    const [item] = await inbox(at, at.admin);
    const opened = await at.expectOk(at.admin.id, "approval_requests.get", {
      params: { requestId: item?.id ?? "" }
    });
    expect(opened.json()).toMatchObject({
      preview: { exchange: { question: QUESTION, answer: ANSWER } }
    });
  });

  it("left out, leaves no chat text in the record, and the reviewer cannot open the conversation (check 22)", async () => {
    const at = await setup();
    const answer = await answered(at, at.kai);
    const feedbackId = await send(at, at.kai, answer, false);
    const rows = await withTestSql((sql) => sql`select * from feedback where id = ${feedbackId}`);
    expect(JSON.stringify(rows)).not.toContain(QUESTION);
    expect(JSON.stringify(rows)).not.toContain(ANSWER);
    expect(rows[0]).toMatchObject({ exchange_question: null, exchange_answer: null });
    // The administrator is no member of Kai's personal workspace.
    const conversation = await at.call(at.admin.id, "conversations.thread.get", {
      params: { conversationId: answer.conversationId }
    });
    expect(conversation.statusCode).toBe(404);
  });
});

describe("the record of a comment", () => {
  it("holds ids and no text in the event and its audit record (check 23)", async () => {
    const at = await setup();
    const answer = await answered(at, at.kai);
    const feedbackId = await send(at, at.kai, answer);
    const [received, ...more] = await at.stores.audit.listAuditEvents({
      clientInstanceId,
      type: "feedback.received"
    });
    expect(more).toEqual([]);
    expect(received).toMatchObject({
      subject: feedbackId,
      metadata: { feedbackId, agentName: "assistant" }
    });
    const written = JSON.stringify(received);
    expect(written).not.toContain(COMMENT);
    expect(written).not.toContain(QUESTION);
    expect(written).not.toContain(ANSWER);
  });

  it("goes after its retention, with its Inbox item", async () => {
    const at = await setup();
    const old = await send(at, at.kai, await answered(at, at.kai));
    const recent = await send(at, at.lena, await answered(at, at.lena));
    await withTestSql(
      (sql) => sql`update feedback set created_at = now() - interval '366 days' where id = ${old}`
    );
    await getTestJobs(at.instance).runDue();

    const kept = await at.expectOk(at.admin.id, "feedback.list", {});
    expect(kept.json<{ items: { id: string }[] }>().items.map((item) => item.id)).toEqual([recent]);
    expect((await inbox(at, at.admin)).map((item) => item.preview?.feedbackId)).toEqual([recent]);
    const pruned = await at.stores.audit.listAuditEvents({
      clientInstanceId,
      type: "feedback.pruned"
    });
    expect(pruned).toMatchObject([{ metadata: { count: 1, retentionDays: 365 } }]);
  });

  it("goes when its author's account is deleted", async () => {
    const at = await setup();
    await send(at, at.kai, await answered(at, at.kai));
    const kept = await send(at, at.lena, await answered(at, at.lena));
    await at.expectOk(at.root.id, "users.delete", { params: { userId: at.kai.id } });
    await getTestJobs(at.instance).runDue();

    const listed = await at.expectOk(at.admin.id, "feedback.list", {});
    expect(listed.json<{ items: { id: string }[] }>().items.map((item) => item.id)).toEqual([kept]);
    expect(await inbox(at, at.admin)).toHaveLength(1);
  });
});
