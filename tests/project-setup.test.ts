import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createConfigAssetSource,
  createPlatformTools,
  resolveInstanceModules
} from "@work-shape/catalyst-client-assembly";
import {
  asConversationId,
  asUserId,
  createPlatformId,
  createUserPrincipal,
  type AgentRun,
  type AgentRuntime,
  type AuthenticatedUser,
  type CollaborationWorkspaceId,
  type Conversation,
  type UserRecord
} from "@work-shape/catalyst-core";
import { ProjectSetupService } from "@work-shape/catalyst-server";
import { createReadSkillTool } from "@work-shape/catalyst-tool-execution";
import {
  agent,
  clientInstanceId,
  setupAccessInstance,
  skill,
  type AccessInstance
} from "./support/access-instance";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import { withTestSql } from "./support/test-sql";

// PRJ-7: a project names the agent a new chat in it starts with and the skills every run in it
// is offered beside its agent's own. What the project's audience may rely on is the one owner
// rule: a project others read offers the agents of its workspace and the skills its workspace
// owns or its agents use; a person's own agent or skill ("Nur ich") only where they alone read
// the project, and a chat that uses it is marked personal. Kai and Lena are members of TEAM.

const ON = { projects: { enabled: true } };
const OWN_AGENT = "kai-own";
const OWN_SKILL = "kai-notes";
const TEAM_SKILL = "team-check";
const AGENT_SKILL = "agent-skill";
const LOOSE_SKILL = "loose-skill";

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

const projectSchema = z.looseObject({
  id: z.string(),
  defaultAgent: z.string().optional(),
  skills: z.array(z.string()).optional()
});
const choiceSchema = z.object({
  name: z.string(),
  own: z.boolean(),
  refusal: z.string().optional(),
  asset: z.object({ id: z.string(), workspaceId: z.string() }).optional()
});
const setupSchema = z.object({
  defaultAgent: z.string().optional(),
  skills: z.array(z.string()),
  workspaceDefaultAgent: z.string().optional(),
  agents: z.array(choiceSchema.extend({ displayName: z.string() })),
  skillChoices: z.array(choiceSchema.extend({ title: z.string() }))
});
const startedSchema = z.object({
  conversation: z.object({ id: z.string(), visibility: z.string() }),
  run: z.object({ agentName: z.string() })
});

describe("a project's default agent and skills", () => {
  let t: AccessInstance;
  let team: CollaborationWorkspaceId;
  let kaiHome: CollaborationWorkspaceId;
  let setupService: ProjectSetupService;
  let modules: ReturnType<typeof resolveInstanceModules>["snapshot"];
  let runs = 0;

  const createProject = async (title: string, audience: "workspace" | "private") =>
    projectSchema.parse(
      (
        await t.expectOk(t.kai.id, "projects.create", {
          payload: { collaborationWorkspaceId: team, title, audience }
        })
      ).json()
    );
  const readSetup = async (userId: string, projectId: string) =>
    setupSchema.parse(
      (await t.expectOk(userId, "projects.setup.get", { params: { projectId } })).json()
    );
  const setSetup = (
    userId: string,
    projectId: string,
    payload: { defaultAgent: string | null; skills: string[] }
  ) => t.call(userId, "projects.setup.set", { params: { projectId }, payload });
  /** A chat started in the project with its first message, naming no agent. */
  const startIn = async (userId: string, projectId: string) => {
    runs += 1;
    const response = await t.call(userId, "conversations.runs.create", {
      payload: {
        idempotencyKey: `prj7-${String(runs)}`,
        message: { text: "Wie weit sind wir?" },
        conversation: { collaborationWorkspaceId: team, projectId }
      }
    });
    expect(response.statusCode, response.body).toBe(200);
    return startedSchema.parse(response.json());
  };
  const marked = async (conversationId: string) =>
    (
      await t.stores.conversations.getConversation(
        clientInstanceId,
        asConversationId(conversationId)
      )
    )?.personalDataAt !== undefined;
  /** What a project of another audience would be after a change PRJ-6 makes: set directly. */
  const shareNow = async (projectId: string) => {
    await withTestSql(async (sql) => {
      await sql`update projects set audience = 'workspace' where asset_id = ${projectId}`;
      await sql`update conversations set visibility = 'workspace' where project_id = ${projectId}`;
    });
  };

  beforeAll(async () => {
    let config: Parameters<typeof resolveInstanceModules>[0] | undefined;
    t = await setupAccessInstance({
      modules: ON,
      storedAssetSource: true,
      furtherToolNames: ["read_skill"],
      server: (_stores, instanceConfig) => {
        config = instanceConfig;
        return { agentRuntime: queuedRuntime };
      }
    });
    team = (
      await t.stores.workspaces.createWorkspace({
        clientInstanceId,
        kind: "shared",
        name: "Team",
        creatorUserId: t.kai.id
      })
    ).id;
    await t.stores.workspaces.addMembership({
      clientInstanceId,
      collaborationWorkspaceId: team,
      userId: asUserId(t.lena.id),
      role: "member"
    });
    kaiHome = (
      await t.stores.workspaces.ensurePersonalWorkspace({
        clientInstanceId,
        userId: asUserId(t.kai.id)
      })
    ).id;
    await applyAtCurrentRevisions(t.stores.configAssets, {
      clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "agent",
          name: "helper",
          config: agent("helper", { displayName: "Helfer", skillNames: [AGENT_SKILL] })
        },
        { type: "upsert", kind: "agent", name: "fiona", config: agent("fiona") },
        { type: "upsert", kind: "skill", name: AGENT_SKILL, config: skill(AGENT_SKILL) },
        { type: "upsert", kind: "skill", name: LOOSE_SKILL, config: skill(LOOSE_SKILL) },
        {
          type: "upsert",
          kind: "skill",
          name: TEAM_SKILL,
          config: skill(TEAM_SKILL),
          scope: { kind: "workspace", workspaceId: team }
        },
        {
          type: "upsert",
          kind: "skill",
          name: OWN_SKILL,
          config: skill(OWN_SKILL, "Kai's own notes."),
          scope: { kind: "workspace", workspaceId: kaiHome }
        }
      ]
    });
    // As a draft Kai publishes is stored: owned by his Personal Workspace, offered nowhere.
    await applyAtCurrentRevisions(t.stores.configAssets, {
      clientInstanceId,
      initialAgentAvailability: "hidden",
      mutations: [
        {
          type: "upsert",
          kind: "agent",
          name: OWN_AGENT,
          config: agent(OWN_AGENT, { displayName: "Kais Agent" }),
          scope: { kind: "workspace", workspaceId: kaiHome }
        }
      ]
    });
    // The app is built on its first request, and with it the config this file reads.
    await createProject("Start", "workspace");
    if (!config) throw new Error("The instance has no config");
    modules = resolveInstanceModules(config, []).snapshot;
    setupService = new ProjectSetupService({
      stores: t.stores,
      clientInstanceId,
      config,
      modules,
      configAssets: {
        store: t.stores.configAssets,
        source: createConfigAssetSource({ store: t.stores.configAssets, clientInstanceId })
      }
    });
  });
  afterAll(async () => {
    await t?.instance.close();
  });

  it("offers a shared project the workspace's agents and skills, and greys the person's own with the reason", async () => {
    const project = await createProject("Hoheluft", "workspace");
    const kai = await readSetup(t.kai.id, project.id);
    expect(kai.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "helper", displayName: "Helfer", own: false }),
        expect.objectContaining({ name: "fiona", own: false }),
        expect.objectContaining({
          name: OWN_AGENT,
          own: true,
          refusal: "own_in_shared_project",
          asset: expect.objectContaining({ workspaceId: kaiHome })
        })
      ])
    );
    expect(kai.agents.filter((choice) => choice.refusal).map((choice) => choice.name)).toEqual([
      OWN_AGENT
    ]);
    // The workspace's own skill and its agents' skills; never one no agent here uses.
    expect(kai.skillChoices.map((choice) => [choice.name, choice.refusal ?? "ok"])).toEqual(
      expect.arrayContaining([
        [TEAM_SKILL, "ok"],
        [AGENT_SKILL, "ok"],
        [OWN_SKILL, "own_in_shared_project"]
      ])
    );
    expect(kai.skillChoices.map((choice) => choice.name)).not.toContain(LOOSE_SKILL);
    expect(kai.workspaceDefaultAgent).toBeDefined();

    // Another member never sees what is Kai's own; someone outside the workspace sees nothing.
    const lena = await readSetup(t.lena.id, project.id);
    expect(lena.agents.map((choice) => choice.name)).not.toContain(OWN_AGENT);
    expect(lena.skillChoices.map((choice) => choice.name)).not.toContain(OWN_SKILL);
    await t.expectRefused(
      t.admin.id,
      "projects.setup.get",
      { params: { projectId: project.id } },
      { status: 404, code: "NOT_FOUND" }
    );
  });

  it("is set by anyone in the audience; the person's own is refused in a shared project; audited by counts only", async () => {
    const project = await createProject("Bauzeiten", "workspace");
    const set = await setSetup(t.lena.id, project.id, {
      defaultAgent: "fiona",
      skills: [TEAM_SKILL, AGENT_SKILL]
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(setupSchema.parse(set.json())).toMatchObject({
      defaultAgent: "fiona",
      skills: [TEAM_SKILL, AGENT_SKILL]
    });
    expect(
      projectSchema.parse(
        (
          await t.expectOk(t.kai.id, "projects.get", {
            params: { projectName: String((await readName(project.id)) ?? "") }
          })
        ).json()
      )
    ).toMatchObject({ defaultAgent: "fiona", skills: [TEAM_SKILL, AGENT_SKILL] });

    const own = {
      status: 422,
      code: "VALIDATION_FAILED",
      details: { reason: "own_in_shared_project" }
    };
    await t.expectRefused(
      t.kai.id,
      "projects.setup.set",
      { params: { projectId: project.id }, payload: { defaultAgent: OWN_AGENT, skills: [] } },
      own
    );
    await t.expectRefused(
      t.kai.id,
      "projects.setup.set",
      {
        params: { projectId: project.id },
        payload: { defaultAgent: "fiona", skills: [OWN_SKILL] }
      },
      own
    );
    await t.expectRefused(
      t.kai.id,
      "projects.setup.set",
      { params: { projectId: project.id }, payload: { defaultAgent: "nobody", skills: [] } },
      {
        status: 422,
        code: "VALIDATION_FAILED",
        details: { reason: "project_agent_not_offered" }
      }
    );
    await t.expectRefused(
      t.kai.id,
      "projects.setup.set",
      { params: { projectId: project.id }, payload: { defaultAgent: null, skills: [LOOSE_SKILL] } },
      {
        status: 422,
        code: "VALIDATION_FAILED",
        details: { reason: "project_skill_not_offered" }
      }
    );
    // A refused change leaves the project as it was.
    expect(await readSetup(t.kai.id, project.id)).toMatchObject({
      defaultAgent: "fiona",
      skills: [TEAM_SKILL, AGENT_SKILL]
    });

    const audited = await withTestSql(
      (sql) => sql`
        select subject, metadata from audit_events
        where type = 'project.setup_changed' and subject = ${project.id}`
    );
    expect(audited).toHaveLength(1);
    expect(audited[0]?.metadata).toMatchObject({
      defaultAgentChanged: true,
      skillsAdded: 2,
      skillsRemoved: 0
    });
    expect(JSON.stringify(audited[0])).not.toContain(TEAM_SKILL);
    expect(JSON.stringify(audited[0])).not.toContain("fiona");
  });

  it("starts a chat with the project's default where none is named", async () => {
    const project = await createProject("Vertrieb", "workspace");
    const before = await startIn(t.lena.id, project.id);
    const { workspaceDefaultAgent } = await readSetup(t.lena.id, project.id);
    expect(before.run.agentName).toBe(workspaceDefaultAgent);
    await t.expectOk(t.lena.id, "projects.setup.set", {
      params: { projectId: project.id },
      payload: { defaultAgent: "helper", skills: [] }
    });
    expect((await startIn(t.lena.id, project.id)).run.agentName).toBe("helper");
  });

  it("lets a private project's creator choose their own; a chat started there runs it and is marked personal", async () => {
    const project = await createProject("Notizen Kai", "private");
    const kai = await readSetup(t.kai.id, project.id);
    expect(kai.agents.find((choice) => choice.name === OWN_AGENT)?.refusal).toBeUndefined();
    expect(kai.skillChoices.find((choice) => choice.name === OWN_SKILL)?.refusal).toBeUndefined();
    await t.expectOk(t.kai.id, "projects.setup.set", {
      params: { projectId: project.id },
      payload: { defaultAgent: OWN_AGENT, skills: [OWN_SKILL, AGENT_SKILL] }
    });
    await t.expectRefused(
      t.lena.id,
      "projects.setup.get",
      { params: { projectId: project.id } },
      { status: 404, code: "NOT_FOUND" }
    );

    const started = await startIn(t.kai.id, project.id);
    expect(started.conversation.visibility).toBe("private");
    expect(started.run.agentName).toBe(OWN_AGENT);
    expect(await marked(started.conversation.id)).toBe(true);

    // Shared since, the project keeps what no longer applies and says so; a new chat starts
    // with the workspace's default and stays unmarked, and an unchanged default may stay.
    await shareNow(project.id);
    const shared = await readSetup(t.kai.id, project.id);
    expect(shared).toMatchObject({ defaultAgent: OWN_AGENT, skills: [OWN_SKILL, AGENT_SKILL] });
    expect(shared.agents.find((choice) => choice.name === OWN_AGENT)?.refusal).toBe(
      "own_in_shared_project"
    );
    const after = await startIn(t.kai.id, project.id);
    expect(after.run.agentName).toBe(shared.workspaceDefaultAgent);
    expect(await marked(after.conversation.id)).toBe(false);
    await t.expectOk(t.kai.id, "projects.setup.set", {
      params: { projectId: project.id },
      payload: { defaultAgent: OWN_AGENT, skills: [OWN_SKILL] }
    });
    // Lena reads the project now; Kai's own agent and skill are none of hers to see.
    const lena = await readSetup(t.lena.id, project.id);
    expect(lena.agents.map((choice) => choice.name)).not.toContain(OWN_AGENT);
    expect(lena.skillChoices.map((choice) => choice.name)).not.toContain(OWN_SKILL);
  });

  it("offers a run its project's skills, and the person's own only in a chat they alone read, which a read marks", async () => {
    const runsById = new Map<string, AgentRun>();
    const platform = createPlatformTools({
      stores: {
        conversations: t.stores.conversations,
        configAssets: t.stores.configAssets,
        workspaces: t.stores.workspaces,
        agentRuns: { getAgentRun: async ({ runId }) => runsById.get(runId) }
      },
      modules,
      projectSkills: () => setupService
    });
    const readSkill = createReadSkillTool({
      assetSource: createConfigAssetSource({ store: t.stores.configAssets, clientInstanceId }),
      conversationOffer: platform.conversationOffer,
      conversations: t.stores.conversations
    });
    platform.registry([readSkill, ...platform.tools], new Set());
    const runIn = async (conversation: Conversation, user: UserRecord) => {
      const message = await t.stores.conversations.appendMessage({
        clientInstanceId,
        conversationId: conversation.id,
        role: "user",
        text: "Lies die Skills."
      });
      const run = await t.stores.agentRuns.createAgentRun({
        id: createPlatformId<"AgentRunId">("run"),
        clientInstanceId,
        conversationId: conversation.id,
        ownerUserId: user.id,
        inputMessageId: message.id,
        agentName: "fiona",
        authorization: {
          personalConnectionsAllowed: true,
          principal: createUserPrincipal(person(user)),
          subjectUserId: user.id,
          scopes: ["*"]
        },
        correlationId: "corr_prj7"
      });
      runsById.set(run.id, run);
      return run;
    };
    const offered = async (run: AgentRun, user: UserRecord) => {
      const offer = await platform.conversationOffer.offerOf({
        clientInstanceId,
        conversationId: run.conversationId,
        agentToolNames: [],
        user: person(user),
        runId: run.id
      });
      return {
        shared: offer?.skillNames ?? [],
        own: offer?.personalSkillNames ?? [],
        readSkill: offer?.toolNames.includes("read_skill") ?? false
      };
    };
    const chatIn = async (userId: string, projectId: string) => {
      const created = await t.expectOk(userId, "conversations.create", {
        payload: { title: "Chat", collaborationWorkspaceId: team, projectId }
      });
      const id = z.object({ id: z.string() }).parse(created.json()).id;
      const conversation = await t.stores.conversations.getConversation(
        clientInstanceId,
        asConversationId(id)
      );
      if (!conversation) throw new Error("The chat is not there");
      return conversation;
    };

    const shared = await createProject("Geteilt", "workspace");
    await t.expectOk(t.kai.id, "projects.setup.set", {
      params: { projectId: shared.id },
      payload: { defaultAgent: null, skills: [TEAM_SKILL] }
    });
    const lenaRun = await runIn(await chatIn(t.lena.id, shared.id), t.lena);
    expect(await offered(lenaRun, t.lena)).toEqual({
      shared: [TEAM_SKILL],
      own: [],
      readSkill: true
    });

    const own = await createProject("Eigen", "private");
    await t.expectOk(t.kai.id, "projects.setup.set", {
      params: { projectId: own.id },
      payload: { defaultAgent: null, skills: [OWN_SKILL, AGENT_SKILL] }
    });
    const chat = await chatIn(t.kai.id, own.id);
    const kaiRun = await runIn(chat, t.kai);
    expect(await offered(kaiRun, t.kai)).toEqual({
      shared: [AGENT_SKILL],
      own: [OWN_SKILL],
      readSkill: true
    });
    expect(await marked(chat.id)).toBe(false);
    const read = await readSkill.execute(
      { name: OWN_SKILL },
      {
        clientInstanceId,
        correlationId: "corr_prj7",
        user: person(t.kai),
        toolRequest: {
          toolName: "read_skill",
          toolCallId: createPlatformId<"ToolCallId">("toolcall"),
          agentRunId: kaiRun.id,
          conversationId: kaiRun.conversationId,
          agentName: "fiona",
          input: { name: OWN_SKILL }
        }
      }
    );
    expect(read).toMatchObject({ status: "success" });
    expect(await marked(chat.id)).toBe(true);

    // Shared since: Kai's own skill reaches no chat of the project, his or Lena's.
    await shareNow(own.id);
    const later = await runIn(await chatIn(t.kai.id, own.id), t.kai);
    expect(await offered(later, t.kai)).toMatchObject({ shared: [AGENT_SKILL], own: [] });
    const lenaLater = await runIn(await chatIn(t.lena.id, own.id), t.lena);
    expect(await offered(lenaLater, t.lena)).toMatchObject({ shared: [AGENT_SKILL], own: [] });
  });

  /** The project's name, which `projects.get` reads it by. */
  async function readName(projectId: string): Promise<string | undefined> {
    return (await t.stores.projects.getProject({ clientInstanceId, projectId }))?.name;
  }

  function person(user: UserRecord): AuthenticatedUser {
    return {
      id: user.id,
      externalUserId: user.id,
      displayLabel: user.displayLabel,
      roles: ["user"],
      permissionRefs: [],
      clientInstanceId,
      authSource: "test"
    };
  }
});
