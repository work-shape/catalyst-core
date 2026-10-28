import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createConfigAssetSource,
  createPlatformTools,
  platformModules
} from "@work-shape/catalyst-client-assembly";
import {
  asServicePrincipalId,
  asUserId,
  createModuleRegistry,
  createPlatformId,
  createUserPrincipal,
  servicePrincipalAsRunUser,
  type AgentRun,
  type AuthenticatedUser,
  type Conversation,
  type ToolExecutionContext,
  type UserRecord
} from "@work-shape/catalyst-core";
import { createReadSkillTool } from "@work-shape/catalyst-tool-execution";
import {
  clientInstanceId,
  setupAccessInstance,
  skill,
  type AccessInstance
} from "./support/access-instance";
import { applyAtCurrentRevisions } from "./support/asset-revisions";

// SCOPE-MYCHATS: a person switches on "In meinen Chats verwenden" for a skill of their own
// Personal Workspace, and in their own chats every agent may read it, as its own skills. It
// shares nothing: only the skill's owner switches it, only the owner's own runs read it, and a
// run of another member, a subagent, a Workflow step and a run of a key read nothing.

const KAI_SKILL = "kai-tax-check";
const LENA_SKILL = "lena-notes";
const HOUSE_SKILL = "house-style";
const KEY = { "x-test-key": "personal" };
const itemsSchema = z.object({
  items: z.array(z.object({ name: z.string(), inMyChats: z.boolean() }))
});

async function setup() {
  const t = await setupAccessInstance({ furtherToolNames: ["read_skill"] });
  const home = async (user: UserRecord) =>
    (
      await t.stores.workspaces.ensurePersonalWorkspace({
        clientInstanceId,
        userId: asUserId(user.id)
      })
    ).id;
  const kaiHome = await home(t.kai);
  const lenaHome = await home(t.lena);
  await applyAtCurrentRevisions(t.stores.configAssets, {
    clientInstanceId,
    mutations: [
      {
        type: "upsert",
        kind: "skill",
        name: KAI_SKILL,
        config: skill(KAI_SKILL, "Kai's checklist."),
        scope: { kind: "workspace", workspaceId: kaiHome }
      },
      {
        type: "upsert",
        kind: "skill",
        name: LENA_SKILL,
        config: skill(LENA_SKILL, "Lena's notes."),
        scope: { kind: "workspace", workspaceId: lenaHome }
      },
      { type: "upsert", kind: "skill", name: HOUSE_SKILL, config: skill(HOUSE_SKILL) }
    ]
  });
  return { t, kaiHome };
}

async function listed(t: AccessInstance, userId: string) {
  return itemsSchema.parse((await t.expectOk(userId, "me.chat_skills.list")).json()).items;
}

const switchOn = (t: AccessInstance, userId: string, name: string, headers = {}) =>
  t.call(userId, "me.chat_skills.set", {
    params: { name },
    payload: { inMyChats: true },
    headers
  });

/** The person a run acts for, signed in themself unless the overrides say otherwise. */
function personOf(user: UserRecord, overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    id: user.id,
    externalUserId: user.id,
    displayLabel: user.displayLabel,
    roles: ["user"],
    permissionRefs: [],
    clientInstanceId,
    authSource: "test",
    ...overrides
  };
}

/** A run as the store records it: its owner's own, started in their own session. */
function runOf(
  conversation: Conversation,
  user: UserRecord,
  overrides: Partial<AgentRun> = {}
): AgentRun {
  const person = personOf(user);
  return {
    id: createPlatformId<"AgentRunId">("run"),
    clientInstanceId,
    conversationId: conversation.id,
    ownerUserId: user.id,
    inputMessageId: createPlatformId<"MessageId">("msg"),
    agentName: "assistant",
    authorization: {
      personalConnectionsAllowed: true,
      principal: createUserPrincipal(person),
      subjectUserId: user.id,
      scopes: ["*"]
    },
    status: "running",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastSequence: 0,
    correlationId: "corr_my_chats",
    ...overrides
  };
}

/** The offer of a conversation and the read of a skill, for the runs this test records. */
function runSkills(t: AccessInstance) {
  const runs = new Map<string, AgentRun>();
  const platform = createPlatformTools({
    stores: {
      conversations: t.stores.conversations,
      configAssets: t.stores.configAssets,
      agentRuns: { getAgentRun: async ({ runId }) => runs.get(runId) }
    },
    modules: createModuleRegistry(platformModules).snapshot({})
  });
  const readSkill = createReadSkillTool({
    assetSource: createConfigAssetSource({ store: t.stores.configAssets, clientInstanceId }),
    conversationOffer: platform.conversationOffer
  });
  platform.registry([readSkill, ...platform.tools], new Set());
  return {
    record(run: AgentRun) {
      runs.set(run.id, run);
      return run;
    },
    /** What the run is offered of the person's own skills, and whether `read_skill` with it. */
    async offered(
      run: AgentRun,
      user: AuthenticatedUser,
      conversationId: Conversation["id"] = run.conversationId
    ) {
      const offer = await platform.conversationOffer.offerOf({
        clientInstanceId,
        conversationId,
        // An agent that lists none of the platform's tools and no skill of its own.
        agentToolNames: [],
        user,
        runId: run.id
      });
      return {
        skills: offer?.personalSkillNames ?? [],
        readSkill: offer?.toolNames.includes("read_skill") ?? false
      };
    },
    async read(run: AgentRun, user: AuthenticatedUser, name: string) {
      const context: ToolExecutionContext = {
        clientInstanceId,
        correlationId: "corr_my_chats",
        user,
        toolRequest: {
          toolName: "read_skill",
          toolCallId: createPlatformId<"ToolCallId">("toolcall"),
          agentRunId: run.id,
          conversationId: run.conversationId,
          agentName: "assistant",
          input: { name }
        }
      };
      return readSkill.execute({ name }, context);
    }
  };
}

async function chatOf(
  t: AccessInstance,
  user: UserRecord,
  collaborationWorkspaceId: Conversation["collaborationWorkspaceId"]
) {
  return t.stores.conversations.createConversation({
    clientInstanceId,
    collaborationWorkspaceId,
    createdByUserId: user.id,
    createdByExternalUserId: user.id,
    visibility: "workspace",
    title: "Chat",
    retainedUntil: new Date(Date.now() + 86_400_000).toISOString()
  });
}

describe("a person's skill in their own chats", () => {
  it("is switched by its owner alone, and lists only the person's own skills", async () => {
    const { t } = await setup();

    expect(await listed(t, t.kai.id)).toEqual([{ name: KAI_SKILL, inMyChats: false }]);
    expect(await listed(t, t.lena.id)).toEqual([{ name: LENA_SKILL, inMyChats: false }]);
    // An administrator sees no other person's skill: a Personal Workspace is private.
    expect(await listed(t, t.admin.id)).toEqual([]);
    expect(await listed(t, t.root.id)).toEqual([]);

    const on = await switchOn(t, t.kai.id, KAI_SKILL);
    expect(on.statusCode).toBe(200);
    expect(on.json()).toEqual({ name: KAI_SKILL, inMyChats: true });
    expect(await listed(t, t.kai.id)).toEqual([{ name: KAI_SKILL, inMyChats: true }]);

    // Another person's skill, and the instance's, answer as skills that do not exist.
    for (const userId of [t.lena.id, t.admin.id, t.root.id]) {
      const refused = await switchOn(t, userId, KAI_SKILL);
      expect(refused.statusCode, userId).toBe(404);
    }
    expect((await switchOn(t, t.kai.id, HOUSE_SKILL)).statusCode).toBe(404);
    expect((await switchOn(t, t.kai.id, LENA_SKILL)).statusCode).toBe(404);
    expect(await listed(t, t.lena.id)).toEqual([{ name: LENA_SKILL, inMyChats: false }]);

    // An outside key of the owner switches nothing and reads nothing.
    const byKey = await t.call(t.kai.id, "me.chat_skills.set", {
      params: { name: KAI_SKILL },
      payload: { inMyChats: false },
      headers: KEY
    });
    expect(byKey.statusCode).toBe(403);
    expect((await t.call(t.kai.id, "me.chat_skills.list", { headers: KEY })).statusCode).toBe(403);
    expect(await listed(t, t.kai.id)).toEqual([{ name: KAI_SKILL, inMyChats: true }]);

    const off = await t.call(t.kai.id, "me.chat_skills.set", {
      params: { name: KAI_SKILL },
      payload: { inMyChats: false }
    });
    expect(off.json()).toEqual({ name: KAI_SKILL, inMyChats: false });
  });

  it("is read in the owner's own run with any agent, and in no other run", async () => {
    const { t, kaiHome } = await setup();
    const skills = runSkills(t);
    const kai = personOf(t.kai);
    const lena = personOf(t.lena);
    const own = skills.record(runOf(await chatOf(t, t.kai, kaiHome), t.kai));

    // Off: nothing is offered and nothing is read.
    expect(await skills.offered(own, kai)).toEqual({ skills: [], readSkill: false });
    expect(await skills.read(own, kai, KAI_SKILL)).toMatchObject({
      status: "failed",
      error: { code: "not_allowed" }
    });

    expect((await switchOn(t, t.kai.id, KAI_SKILL)).statusCode).toBe(200);
    expect(await skills.offered(own, kai)).toEqual({ skills: [KAI_SKILL], readSkill: true });
    expect(await skills.read(own, kai, KAI_SKILL)).toMatchObject({
      status: "success",
      output: { name: KAI_SKILL, content: "Kai's checklist." }
    });
    // The person's own skills only: Lena's skill is no part of Kai's run.
    expect(await skills.read(own, kai, LENA_SKILL)).toMatchObject({ status: "failed" });

    // A conversation Kai and Lena share: Kai's turns read it, Lena's never do.
    const team = await t.sharedWorkspace("Team");
    for (const user of [t.kai, t.lena]) {
      await t.stores.workspaces.addMembership({
        clientInstanceId,
        collaborationWorkspaceId: team,
        userId: asUserId(user.id),
        role: "member"
      });
    }
    const shared = await chatOf(t, t.kai, team);
    const kaiTurn = skills.record(runOf(shared, t.kai));
    const lenaTurn = skills.record(runOf(shared, t.lena));
    expect(await skills.offered(kaiTurn, kai)).toEqual({ skills: [KAI_SKILL], readSkill: true });
    expect(await skills.offered(lenaTurn, lena)).toEqual({ skills: [], readSkill: false });
    expect(await skills.read(lenaTurn, lena, KAI_SKILL)).toMatchObject({
      status: "failed",
      error: { code: "not_allowed" }
    });

    // Refusals, each with the run as the store would hold it.
    const refused: [string, AgentRun, AuthenticatedUser][] = [
      // Another person's run in Kai's chat, and Lena acting for Kai's run.
      ["another person's run", skills.record(runOf(shared, t.lena)), lena],
      ["another person for the owner's run", own, lena],
      // A run started with Kai's own key, and Kai's key acting for his own run.
      [
        "a run started with a key",
        skills.record(
          runOf(await chatOf(t, t.kai, kaiHome), t.kai, {
            authorization: {
              personalConnectionsAllowed: false,
              principal: createUserPrincipal(kai),
              subjectUserId: t.kai.id,
              delegatedActor: {
                kind: "api_key",
                id: createPlatformId<"ApiCredentialId">("key"),
                displayLabel: "Key",
                authSource: "test"
              },
              scopes: ["*"]
            }
          })
        ),
        kai
      ],
      [
        "the owner's key",
        own,
        personOf(t.kai, {
          delegatedActor: {
            kind: "api_key",
            id: createPlatformId<"ApiCredentialId">("key"),
            displayLabel: "Key",
            authSource: "test"
          },
          keyScopes: ["skill.read"]
        })
      ],
      // A subagent of Kai's run, and a Workflow's agent step.
      [
        "a subagent",
        skills.record(runOf(await chatOf(t, t.kai, kaiHome), t.kai, { parentRunId: own.id })),
        kai
      ],
      [
        "a Workflow step",
        skills.record(
          runOf(await chatOf(t, t.kai, kaiHome), t.kai, { workflowStepRunId: "wfstep_1" })
        ),
        kai
      ],
      // A run the store does not hold, and one of another conversation.
      ["an unknown run", runOf(await chatOf(t, t.kai, kaiHome), t.kai), kai]
    ];
    for (const [what, run, user] of refused) {
      expect(await skills.offered(run, user), what).toEqual({ skills: [], readSkill: false });
      expect(await skills.read(run, user, KAI_SKILL), what).toMatchObject({ status: "failed" });
    }
    // The run of one conversation asks for the offer of another.
    const elsewhere = await chatOf(t, t.kai, kaiHome);
    expect(await skills.offered(own, kai, elsewhere.id), "another conversation").toEqual({
      skills: [],
      readSkill: false
    });
    // A Workflow step's principal in the shape of a run's user.
    expect(
      await skills.offered(
        own,
        servicePrincipalAsRunUser({
          kind: "service",
          id: asServicePrincipalId("sp_books"),
          workflowRunId: createPlatformId<"WorkflowRunId">("wfrun"),
          displayLabel: "Books",
          permissionRefs: [],
          permissions: [],
          clientInstanceId,
          authSource: "test",
          scopes: []
        })
      ),
      "a service principal"
    ).toEqual({ skills: [], readSkill: false });
    // The owner's own run still reads it after all of these.
    expect(await skills.offered(own, kai)).toEqual({ skills: [KAI_SKILL], readSkill: true });
  });
});
