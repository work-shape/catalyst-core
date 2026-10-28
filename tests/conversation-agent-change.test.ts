import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { asAgentRunId, type AgentRuntime } from "@work-shape/catalyst-core";
import {
  agent,
  clientInstanceId,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";

// T30: a conversation keeps the agent it was held with. Wish 2: its thread names the agent of
// each run by the message that started it, so the history can say where another agent answers
// from. Wish 3: making a new agent sets it neither as the default nor into an existing chat.

const instances: AccessInstance[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((t) => t.instance.close()));
});

const refuse = (): never => {
  throw new Error("Not used here");
};
/** Takes every run the start service prepared, without running it. */
const queuedRuntime: AgentRuntime = {
  async start(input) {
    const prepared = input.preparedRun ?? refuse();
    return { runId: prepared.id, status: "queued", startedAt: prepared.startedAt };
  },
  observe: () => refuse(),
  getStatus: async () => refuse(),
  resume: async () => refuse(),
  cancel: async () => refuse()
};

const threadSchema = z.object({
  agentName: z.string().optional(),
  messages: z.array(z.object({ id: z.string(), role: z.string() })),
  runAgents: z.array(z.object({ inputMessageId: z.string(), agentName: z.string() })).optional()
});
const agentsSchema = z.object({
  defaultAgentName: z.string().optional(),
  items: z.array(z.object({ name: z.string() }))
});

async function setup() {
  const t = await setupAccessInstance({
    storedAssetSource: true,
    server: () => ({ agentRuntime: queuedRuntime })
  });
  instances.push(t);
  const team = await t.sharedWorkspace("Team");
  const conversationId = z.object({ id: z.string() }).parse(
    (
      await t.expectOk(t.admin.id, "conversations.create", {
        payload: { title: "Held", collaborationWorkspaceId: team }
      })
    ).json()
  ).id;
  let runs = 0;
  /** One turn, ended before the next starts. Without a name, the conversation's default runs. */
  const turn = async (agentName?: string) => {
    runs += 1;
    const started = await t.expectOk(t.admin.id, "conversations.runs.start", {
      params: { conversationId },
      payload: {
        ...(agentName === undefined ? {} : { agentName }),
        idempotencyKey: `turn-${runs}`,
        message: { text: `Turn ${runs}` }
      }
    });
    const runId = z.object({ run: z.object({ id: z.string() }) }).parse(started.json()).run.id;
    const at = new Date().toISOString();
    await t.stores.agentRuns.updateAgentRunStatus({
      clientInstanceId,
      runId: asAgentRunId(runId),
      status: "completed",
      updatedAt: at,
      completedAt: at
    });
  };
  const thread = async () =>
    threadSchema.parse(
      (
        await t.expectOk(t.admin.id, "conversations.thread.get", { params: { conversationId } })
      ).json()
    );
  const agents = async () =>
    agentsSchema.parse(
      (
        await t.expectOk(t.admin.id, "workspaces.agents.list", {
          params: { collaborationWorkspaceId: team }
        })
      ).json()
    );
  const storedDefault = async () =>
    (await t.stores.configAssets.getConfigAssetState({ clientInstanceId })).defaultAgentName;
  return { t, turn, thread, agents, storedDefault };
}

describe("the agent of each run of a conversation (T30)", () => {
  it("makes a new agent neither the default nor the agent of an existing chat", async () => {
    const { t, turn, thread, agents, storedDefault } = await setup();
    await turn();
    expect((await thread()).agentName).toBe("assistant");

    await t.expectOk(t.admin.id, "assets.put", {
      params: { kind: "agent", name: "personal" },
      payload: {
        config: agent("personal", { displayName: "Persönlicher Assistent" }),
        availableIn: "all"
      }
    });

    expect(await storedDefault()).toBe("assistant");
    const listed = await agents();
    expect(listed.items.map((item) => item.name)).toContain("personal");
    expect(listed.defaultAgentName).toBe("assistant");
    // The existing chat is still held with its agent, and its next turn runs with it.
    expect((await thread()).agentName).toBe("assistant");
    await turn();
    const after = await thread();
    expect(after.agentName).toBe("assistant");
    expect(after.runAgents?.map((run) => run.agentName)).toEqual(["assistant", "assistant"]);
  });

  it("names each run's agent by the message that started it, a change and a change back", async () => {
    const { t, turn, thread } = await setup();
    // Before its first run, a conversation names no agent.
    expect((await thread()).runAgents).toBeUndefined();
    await t.expectOk(t.admin.id, "assets.put", {
      params: { kind: "agent", name: "personal" },
      payload: { config: agent("personal"), availableIn: "all" }
    });
    await turn();
    await turn("personal");
    await turn("assistant");

    const snapshot = await thread();
    const userMessages = snapshot.messages.filter((message) => message.role === "user");
    expect(snapshot.runAgents).toEqual([
      { inputMessageId: userMessages[0]?.id, agentName: "assistant" },
      { inputMessageId: userMessages[1]?.id, agentName: "personal" },
      { inputMessageId: userMessages[2]?.id, agentName: "assistant" }
    ]);
    expect(snapshot.agentName).toBe("assistant");
  });
});
