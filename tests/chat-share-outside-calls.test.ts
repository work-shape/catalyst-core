import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ENDED_AGENT_RUN_STATUSES,
  asAgentRunId,
  asClientInstanceId,
  type CentralPolicySetting
} from "@work-shape/catalyst-core";
import { defineTool, toolSuccess } from "@work-shape/catalyst-tool-sdk";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import { waitUntil } from "./support/assertions";
import { injectStartConversationRun } from "./support/chat-server-run-harness";
import { createTestConfig } from "./support/fixtures";
import { createToolCallingModel, TOOL_CALLING_MODEL_PROVIDER } from "./support/held-model";
import {
  createTestInstance,
  getTestConfig,
  getTestJobs,
  type TestInstance
} from "./support/test-instance";
import { withTestSql } from "./support/test-sql";

// CHAT-SHARE-6a: the subagent and the confirmed-call paths of a person who reads a shared chat
// from outside its workspace. Both ask `readsChatFromOutside`, as the run start does: a team's
// own agent never runs for them, a named holder of a Builder bundle included, and a call they
// confirmed runs while they are named and is refused once they are not.

const running: TestInstance[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((app) => app.close()));
});

const toolModel = createToolCallingModel();
const calls: string[] = [];
const change = defineTool({
  name: "demo.change",
  effect: "changing",
  permission: { mode: "allow" },
  description: "Changes something.",
  inputSchema: z.object({ text: z.string() }),
  execute(input) {
    calls.push(input.text);
    return toolSuccess({ changed: input.text });
  }
});

const person = (id: string, label: string, roles: string[] = ["user"]) => ({
  id,
  externalUserId: id,
  displayLabel: label,
  roles,
  permissionRefs: []
});

const eventSchema = z.object({ type: z.string() }).passthrough();

async function instance(central: CentralPolicySetting[] = []) {
  calls.length = 0;
  const config = createTestConfig({
    toolNames: ["run_agent", "demo.change"],
    tools: [{ name: "demo.change", enabled: true }],
    sessionToken: { issuer: "chat-share-outside", ttlSeconds: 900 },
    developmentAuth: {
      enabled: true,
      users: [
        person("admin", "Admin", ["user", "admin"]),
        person("creator", "Creator"),
        person("reader", "Reader")
      ],
      defaultUserId: "admin"
    }
  });
  config.infrastructure.models = {
    local: { provider: TOOL_CALLING_MODEL_PROVIDER, model: "local" }
  };
  const app = await createTestInstance({
    config,
    env: {
      CHAT_SESSION_TOKEN_SECRET: "chat-share-outside-session-signing-key-for-tests",
      CHAT_SERVER_CREDENTIAL: "chat-share-outside-server-credential"
    },
    capabilities: [toolModel.capability],
    tools: [change],
    operations: {
      centralPolicySettings: () => central
    }
  });
  running.push(app);
  const clientInstanceId = asClientInstanceId(getTestConfig(app).clientInstance.id);
  const plain = {
    instructions: "Use configured tools only.",
    modelProviderId: "local",
    initialPrompts: []
  };
  await applyAtCurrentRevisions(app.stores.configAssets, {
    clientInstanceId,
    mutations: [
      {
        type: "upsert",
        kind: "agent",
        name: "helper",
        config: { name: "helper", displayName: "Helper", toolNames: [], ...plain }
      },
      {
        type: "upsert",
        kind: "agent",
        name: "test_agent",
        config: {
          name: "test_agent",
          displayName: "Test Agent",
          toolNames: ["run_agent", "demo.change"],
          subagentNames: ["helper"],
          ...plain
        }
      }
    ]
  });
  const as = (userId: string) => ({ "x-dev-user-id": userId });
  const idOf = async (userId: string) =>
    (await app.call("me.get", { headers: as(userId) })).json<{ id: string }>().id;
  const creator = await idOf("creator");
  const reader = await idOf("reader");
  await idOf("admin");
  const team = (
    await app.call("workspaces.create", { payload: { name: "Team T" }, headers: as("creator") })
  ).json<{ id: string }>().id;
  const chat = (
    await app.call("conversations.create", {
      payload: { title: "Figures", collaborationWorkspaceId: team, visibility: "private" },
      headers: as("creator")
    })
  ).json<{ id: string }>().id;
  const shared = await app.call("conversations.add_person", {
    params: { conversationId: chat },
    payload: { userId: reader },
    headers: as("creator")
  });
  expect(shared.statusCode, shared.body).toBe(200);
  let sent = 0;
  const say = async (userId: string, text: string, until: string[] = ["completed"]) => {
    sent += 1;
    const started = await injectStartConversationRun(app, chat, text, {
      headers: as(userId),
      idempotencyKey: `outside-${sent}`
    });
    const runId = asAgentRunId(started.run.id);
    await waitUntil(async () => {
      const run = await app.stores.agentRuns.getAgentRun({ clientInstanceId, runId });
      return run !== undefined && [...until, "failed"].includes(run.status);
    }, "the run ends or waits");
    return (await app.stores.agentRuns.listRunObservations({ clientInstanceId, runId })).map(
      (observation) => eventSchema.parse(observation.payload)
    );
  };
  return { app, clientInstanceId, as, creator, reader, team, chat, say };
}

const runAgent = (agent: string) =>
  `/tool run_agent ${JSON.stringify({ agent, description: "Help", task: "Sub-task." })}`;

describe("CHAT-SHARE-6a: an outside reader's subagents and confirmed calls", () => {
  it("never starts a team's own agent as a subagent for them, a holder of a Builder bundle included", async () => {
    const f = await instance();
    // The helper becomes the team's own agent, offered in the team.
    await withTestSql(
      (sql) =>
        sql`update config_assets set scope_kind = 'workspace', scope_id = ${f.team} where client_instance_id = ${f.clientInstanceId} and kind = 'agent' and name = 'helper'`
    );
    const started = (events: { type: string }[]) =>
      events.filter((event) => event.type === "subagent_started").length;
    expect(started(await f.say("creator", runAgent("helper")))).toBe(1);
    const outside = await f.say("reader", runAgent("helper"));
    expect(started(outside)).toBe(0);
    expect(JSON.stringify(outside)).toContain("agent_not_available");
    // An instance agent runs for them as a subagent.
    expect(started(await f.say("reader", runAgent("test_agent")))).toBe(1);

    // A Builder bundle of the team does not make them a member: still outside.
    const granted = await f.app.call("permissions.grant", {
      payload: {
        holderKind: "user",
        holderId: f.reader,
        action: "builder",
        effect: "allow",
        scopeKind: "workspace",
        scopeId: f.team
      },
      headers: f.as("admin")
    });
    expect(granted.statusCode, granted.body).toBe(200);
    const holder = await f.say("reader", runAgent("helper"));
    expect(started(holder)).toBe(0);
    const offer = await f.app.call("conversations.reader_offer.get", {
      params: { conversationId: f.chat },
      headers: f.as("reader")
    });
    expect(offer.json()).toMatchObject({ outside: true });
    expect(
      z
        .object({ agents: z.array(z.object({ name: z.string() })) })
        .parse(offer.json())
        .agents.map((agent) => agent.name)
    ).not.toContain("helper");
  });

  it("runs a call they confirmed while they are named, and refuses it once they are removed", async () => {
    const f = await instance([{ operation: "demo.change", value: "approval" }]);
    const settle = async () => {
      await getTestJobs(f.app).runDue();
      await waitUntil(async () => {
        for (const call of await f.app.stores.operationRuns.list({
          clientInstanceId: f.clientInstanceId
        })) {
          if (call.status === "pending_approval" || call.status === "running") return false;
          if (call.origin.kind === "agent") {
            const run = await f.app.stores.agentRuns.getAgentRun({
              clientInstanceId: f.clientInstanceId,
              runId: call.origin.agentRunId
            });
            if (run && !ENDED_AGENT_RUN_STATUSES.some((status) => status === run.status)) {
              return false;
            }
          }
        }
        return true;
      }, "the calls ended");
    };
    const approveWaiting = async () => {
      const waiting = (
        await f.app.stores.operationRuns.list({ clientInstanceId: f.clientInstanceId })
      ).find((call) => call.status === "pending_approval");
      expect(waiting?.actor.id).toBe(f.reader);
      const decided = await f.app.call("approval_requests.decide", {
        params: { requestId: waiting?.approvalRequestId ?? "" },
        payload: { decision: "approve" },
        headers: f.as("admin")
      });
      expect(decided.statusCode, decided.body).toBe(200);
    };

    await f.say("reader", '/tool demo.change {"text":"named"}', ["waiting_for_decision"]);
    await approveWaiting();
    await settle();
    expect(calls).toEqual(["named"]);

    await f.say("reader", '/tool demo.change {"text":"removed"}', ["waiting_for_decision"]);
    await approveWaiting();
    await withTestSql(
      (sql) =>
        sql`delete from conversation_people where conversation_id = ${f.chat} and user_id = ${f.reader}`
    );
    await settle();
    expect(calls).toEqual(["named"]);
  });
});
