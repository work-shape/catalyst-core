import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createPlatformAssetCalls } from "@work-shape/catalyst-server";
import {
  createPlatformAssetBinding,
  createPlatformAssetTools
} from "@work-shape/catalyst-tool-execution";
import {
  asAgentRunId,
  asConversationId,
  asToolCallId,
  asUserId,
  createAuthorizer,
  type CollaborationWorkspaceId,
  type ToolExecutionContext,
  type UserRecord
} from "@work-shape/catalyst-core";
import {
  agent,
  clientInstanceId,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";
import { testServerOptions } from "./support/test-instance";

// A chat started under Studio's scope "Instance" creates for the instance (studio-chat-entry.md,
// section 4a; access acceptance check 49). The conversation keeps the target it was created
// with; the agent's first save creates an agent the instance owns where the person may create
// one there, and is refused, creating nothing anywhere, where not. The model cannot move it.

/** Kai builds agents in one workspace and holds no right on the instance's agents. */
async function setup() {
  const t = await setupAccessInstance();
  const team = await t.sharedWorkspace("Team");
  await t.stores.workspaces.addMembership({
    clientInstanceId,
    collaborationWorkspaceId: team,
    userId: asUserId(t.kai.id),
    role: "member"
  });
  for (const action of ["agent.read", "agent.write"]) {
    await t.grant(t.kai.id, action, { workspaceId: team });
  }
  await t.instance.call("health.get");
  const options = testServerOptions(t.instance);
  if (!options) throw new Error("The instance has no server options");
  return { t, team, calls: createPlatformAssetCalls(options) };
}

const startedSchema = z.object({
  id: z.string(),
  creationTarget: z.literal("instance").optional()
});

/** A conversation of the person's own, started from Studio's scope "Instance" where `instance`. */
async function conversationOf(
  t: AccessInstance,
  user: UserRecord,
  options: { workspaceId?: CollaborationWorkspaceId; instance: boolean }
) {
  const started = await t.expectOk(user.id, "conversations.create", {
    payload: {
      visibility: "private",
      ...(options.workspaceId === undefined
        ? {}
        : { collaborationWorkspaceId: options.workspaceId }),
      ...(options.instance ? { creationTarget: "instance" } : {})
    }
  });
  return startedSchema.parse(started.json());
}

/** What a platform tool of the person's conversation is called with. */
function contextOf(user: UserRecord, conversationId: string): ToolExecutionContext {
  return {
    user: {
      id: user.id,
      externalUserId: user.id,
      displayLabel: user.displayLabel,
      roles: user.roles,
      permissions: user.permissions,
      permissionRefs: user.permissionRefs,
      clientInstanceId,
      authSource: "test"
    },
    clientInstanceId,
    correlationId: `corr_${randomUUID()}`,
    toolRequest: {
      toolName: "platform.assets.put",
      toolCallId: asToolCallId(`call_${randomUUID()}`),
      agentRunId: asAgentRunId(`run_${randomUUID()}`),
      conversationId: asConversationId(conversationId),
      agentName: "assistant",
      input: {}
    }
  };
}

const ownerOf = async (t: AccessInstance, name: string) =>
  (await t.stores.configAssets.getConfigAsset({ clientInstanceId, kind: "agent", name }))?.scope;

const storedTarget = async (t: AccessInstance, conversationId: string) =>
  (await t.stores.conversations.getConversation(clientInstanceId, asConversationId(conversationId)))
    ?.creationTarget;

describe("a chat started under Studio's scope Instance", () => {
  it("creates nothing for a person without the instance's create right, also not in the workspace", async () => {
    const { t, team, calls } = await setup();
    const conversation = await conversationOf(t, t.kai, { workspaceId: team, instance: true });
    expect(conversation.creationTarget).toBe("instance");

    const refusal = { code: "FORBIDDEN", details: { reason: "instance_create_refused" } };
    // Refused before the confirmation, under the person's own rights.
    await expect(
      calls.authorizePut(
        { kind: "agent", name: "team-helper", config: agent("team-helper") },
        {
          actor: contextOf(t.kai, conversation.id).user,
          origin: {
            kind: "agent",
            conversationId: asConversationId(conversation.id),
            agentRunId: asAgentRunId(`run_${randomUUID()}`),
            agentName: "assistant",
            toolCallId: asToolCallId(`call_${randomUUID()}`),
            toolName: "platform.assets.put"
          },
          correlationId: `corr_${randomUUID()}`,
          access: await createAuthorizer(t.stores.access).forActor(
            contextOf(t.kai, conversation.id).user
          ),
          resource: undefined
        }
      )
    ).rejects.toMatchObject(refusal);
    // And at the save itself.
    await expect(
      calls.put(contextOf(t.kai, conversation.id), {
        kind: "agent",
        name: "team-helper",
        config: agent("team-helper")
      })
    ).rejects.toMatchObject({
      ...refusal,
      message: expect.stringContaining("You may not create agents of the instance here")
    });
    // No fallback: the agent exists nowhere, not in Kai's workspace either, where Kai may write.
    expect(await ownerOf(t, "team-helper")).toBeUndefined();

    // The refusal is audited as a minimized event: the conversation and the kind, no name.
    const audited = await t.stores.audit.listAuditEvents({
      clientInstanceId,
      type: "conversation.instance_create_refused"
    });
    expect(audited.length).toBeGreaterThan(0);
    for (const event of audited) {
      expect(event).toMatchObject({ status: "denied", subject: conversation.id });
      expect(event.actor?.userId).toBe(t.kai.id);
      expect(event.metadata).toEqual({ kind: "agent" });
    }

    // Without the target, the same person's conversation in the workspace creates there.
    const plain = await conversationOf(t, t.kai, { workspaceId: team, instance: false });
    expect(plain.creationTarget).toBeUndefined();
    expect(
      await calls.put(contextOf(t.kai, plain.id), {
        kind: "agent",
        name: "team-helper",
        config: agent("team-helper")
      })
    ).toMatchObject({ saved: true, created: true, workspaceId: team });
    expect(await ownerOf(t, "team-helper")).toEqual({ kind: "workspace", workspaceId: team });
  });

  it("creates an agent the instance owns for a person who may create one there", async () => {
    const { t, calls } = await setup();
    const conversation = await conversationOf(t, t.admin, { instance: true });
    const created = await calls.put(contextOf(t.admin, conversation.id), {
      kind: "agent",
      name: "instance-helper",
      config: agent("instance-helper", { displayName: "Instance helper" })
    });
    expect(created).toMatchObject({ saved: true, created: true, name: "instance-helper" });
    // The answer names no workspace: the instance owns it.
    expect(created).not.toHaveProperty("workspaceId");
    expect(await ownerOf(t, "instance-helper")).toEqual({ kind: "instance" });

    // The same person's conversation without the target creates in its own workspace.
    const plain = await conversationOf(t, t.admin, { instance: false });
    const beside = await calls.put(contextOf(t.admin, plain.id), {
      kind: "agent",
      name: "personal-helper",
      config: agent("personal-helper")
    });
    expect(beside).toHaveProperty("workspaceId");
    expect(await ownerOf(t, "personal-helper")).toMatchObject({ kind: "workspace" });
  });

  it("is never moved by the model: a save that names an owner is refused and the target stays", async () => {
    const { t, team } = await setup();
    const conversation = await conversationOf(t, t.kai, { workspaceId: team, instance: true });
    const put = createPlatformAssetTools(createPlatformAssetBinding().calls).find(
      (tool) => tool.name === "platform.assets.put"
    );
    if (!put) throw new Error("No platform.assets.put tool");
    const base = { kind: "agent", name: "team-helper", config: agent("team-helper") };
    expect(put.inputSchema.safeParse(base).success).toBe(true);
    for (const switched of [
      { workspaceId: team },
      { owner: "workspace" },
      { creationTarget: "workspace" },
      { scope: { kind: "workspace", workspaceId: team } }
    ]) {
      expect(
        put.inputSchema.safeParse({ ...base, ...switched }).success,
        Object.keys(switched)[0]
      ).toBe(false);
    }
    // The conversation's target is as it was created.
    expect(await storedTarget(t, conversation.id)).toBe("instance");
  });
});
