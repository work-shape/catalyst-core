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
  type AuthenticatedUser,
  type CollaborationWorkspaceId,
  type Conversation,
  type UserRecord
} from "@work-shape/catalyst-core";
import { ProjectSetupService } from "@work-shape/catalyst-server";
import {
  clientInstanceId,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import { withTestSql } from "./support/test-sql";

// PRJ-8: a project attaches Knowledge Bases, which every run in it searches beside its agent's
// own. Attaching grants nothing, and what a chat reads its readers see: a project others read
// attaches only what every member of its workspace may search (one available there), greyed
// otherwise, and the person's own only where they alone read the project. One that stops
// applying stays attached, is shown so, and answers in no chat of the project. Kai and Lena
// are members of TEAM; Kai holds `knowledge_base.use` on two Knowledge Bases himself.

const ON = {
  projects: { enabled: true },
  dataStores: { enabled: true },
  knowledge: { enabled: true }
};
/** The team's own, available in the team: every member searches it. */
const TEAM_KB = "team-handbook";
/** The instance's, available everywhere. */
const OPEN_KB = "open-rules";
/** The instance's, available nowhere: only Kai, by his own grant, searches it. */
const GRANTED_KB = "kai-granted";
/** Kai's own, of his Personal Workspace, which he searches by his own grant. */
const OWN_KB = "kai-own";
/** Another team's, available everywhere: no agent of TEAM could name it. */
const OTHER_KB = "other-team";
/** The instance's, available nowhere and granted to nobody. */
const HIDDEN_KB = "hidden-rules";

const choiceSchema = z.object({
  name: z.string(),
  title: z.string(),
  own: z.boolean(),
  unpublished: z.boolean().optional(),
  refusal: z.string().optional(),
  asset: z.object({ id: z.string(), workspaceId: z.string() }).optional()
});
const setupSchema = z.looseObject({
  defaultAgent: z.string().optional(),
  skills: z.array(z.string()),
  knowledgeBases: z.array(z.string()),
  knowledgeBaseChoices: z.array(choiceSchema).optional()
});
const projectSchema = z.looseObject({ id: z.string() });

const knowledgeBase = (name: string) => ({
  name,
  title: `Titel ${name}`,
  description: `Was in ${name} steht.`,
  methods: ["keyword"]
});

describe("a project's Knowledge Bases", () => {
  let t: AccessInstance;
  let team: CollaborationWorkspaceId;
  let kaiHome: CollaborationWorkspaceId;
  let setupService: ProjectSetupService;
  let modules: ReturnType<typeof resolveInstanceModules>["snapshot"];
  let instanceConfig: Parameters<typeof resolveInstanceModules>[0];

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
  const attach = (userId: string, projectId: string, knowledgeBases: string[]) =>
    t.call(userId, "projects.setup.set", { params: { projectId }, payload: { knowledgeBases } });
  const choicesOf = (setup: z.infer<typeof setupSchema>) =>
    Object.fromEntries(
      (setup.knowledgeBaseChoices ?? []).map((choice) => [choice.name, choice.refusal ?? "ok"])
    );
  const availableIn = async (name: string, workspaceIds: CollaborationWorkspaceId[] | "all") =>
    t.stores.configAssets.setAgentAvailability({
      clientInstanceId,
      agentName: name,
      kind: "knowledge_base",
      availability:
        workspaceIds === "all"
          ? { mode: "all", personalWorkspaces: false, collaborationWorkspaceIds: [] }
          : {
              mode: "selected",
              personalWorkspaces: false,
              collaborationWorkspaceIds: workspaceIds
            }
    });
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
      server: (_stores, instanceConfig) => {
        config = instanceConfig;
        return {};
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
    const otherTeam = (
      await t.stores.workspaces.createWorkspace({
        clientInstanceId,
        kind: "shared",
        name: "Anderes Team",
        creatorUserId: t.lena.id
      })
    ).id;
    kaiHome = (
      await t.stores.workspaces.ensurePersonalWorkspace({
        clientInstanceId,
        userId: asUserId(t.kai.id)
      })
    ).id;
    const owned = (workspaceId: CollaborationWorkspaceId) => ({
      kind: "workspace" as const,
      workspaceId
    });
    const placed: [string, ReturnType<typeof owned> | undefined][] = [
      [TEAM_KB, owned(team)],
      [OPEN_KB, undefined],
      [GRANTED_KB, undefined],
      [OWN_KB, owned(kaiHome)],
      [OTHER_KB, owned(otherTeam)],
      [HIDDEN_KB, undefined]
    ];
    await applyAtCurrentRevisions(t.stores.configAssets, {
      clientInstanceId,
      mutations: placed.map(([name, scope]) => ({
        type: "upsert" as const,
        kind: "knowledge_base",
        name,
        config: knowledgeBase(name),
        ...(scope ? { scope } : {})
      }))
    });
    for (const [name] of placed) {
      const asset = await t.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: "knowledge_base",
        name
      });
      if (!asset) throw new Error(`${name} is not there`);
      await t.stores.configAssets.publishConfigAssetRevision({
        clientInstanceId,
        kind: "knowledge_base",
        name,
        assetId: asset.id,
        revision: asset.revision,
        revisionId: asset.activeRevisionId
      });
      if (name === GRANTED_KB || name === OWN_KB) {
        await t.stores.access.createGrant({
          clientInstanceId,
          holderKind: "user",
          holderId: t.kai.id,
          action: "knowledge_base.use",
          effect: "allow",
          scopeKind: "asset",
          scopeId: asset.id,
          grantedBy: asUserId(t.admin.id)
        });
      }
    }
    await availableIn(TEAM_KB, [team]);
    await availableIn(OPEN_KB, "all");
    await availableIn(OTHER_KB, "all");
    await availableIn(GRANTED_KB, []);
    await availableIn(HIDDEN_KB, []);
    // The app is built on its first request, and with it the config this file reads.
    await createProject("Start", "workspace");
    if (!config) throw new Error("The instance has no config");
    instanceConfig = config;
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

  it("offers a shared project what every member may search, and greys the rest with the reason", async () => {
    const project = await createProject("Hoheluft", "workspace");
    const kai = await readSetup(t.kai.id, project.id);
    expect(kai.knowledgeBases).toEqual([]);
    expect(choicesOf(kai)).toEqual({
      [TEAM_KB]: "ok",
      [OPEN_KB]: "ok",
      [GRANTED_KB]: "not_everyone_may_use",
      [OWN_KB]: "own_in_shared_project"
    });
    // The person's own carries where it sits, for the share that opens it to the team.
    expect(kai.knowledgeBaseChoices?.find((choice) => choice.name === OWN_KB)).toMatchObject({
      own: true,
      title: `Titel ${OWN_KB}`,
      asset: { workspaceId: kaiHome }
    });
    // Lena searches neither Kai's grant nor his own: she is offered none of them.
    expect(choicesOf(await readSetup(t.lena.id, project.id))).toEqual({
      [TEAM_KB]: "ok",
      [OPEN_KB]: "ok"
    });
  });

  it("attaches only what applies; refused changes leave the project as it was; audited by counts", async () => {
    const project = await createProject("Bauzeiten", "workspace");
    await t.expectOk(t.lena.id, "projects.setup.set", {
      params: { projectId: project.id },
      payload: { defaultAgent: null, skills: [] }
    });
    const set = await attach(t.lena.id, project.id, [TEAM_KB, OPEN_KB]);
    expect(set.statusCode, set.body).toBe(200);
    expect(setupSchema.parse(set.json()).knowledgeBases).toEqual([TEAM_KB, OPEN_KB]);
    for (const [name, reason] of [
      [GRANTED_KB, "not_everyone_may_use"],
      [OWN_KB, "own_in_shared_project"],
      [HIDDEN_KB, "project_knowledge_base_not_offered"],
      [OTHER_KB, "project_knowledge_base_not_offered"]
    ] as const) {
      await t.expectRefused(
        t.kai.id,
        "projects.setup.set",
        { params: { projectId: project.id }, payload: { knowledgeBases: [TEAM_KB, name] } },
        { status: 422, code: "VALIDATION_FAILED", details: { reason } }
      );
    }
    expect((await readSetup(t.kai.id, project.id)).knowledgeBases).toEqual([TEAM_KB, OPEN_KB]);

    const audited = await withTestSql(
      (sql) => sql`
        select metadata from audit_events
        where type = 'project.setup_changed' and subject = ${project.id}
        order by created_at`
    );
    expect(audited.at(-1)?.metadata).toMatchObject({
      defaultAgentChanged: false,
      skillsAdded: 0,
      knowledgeBasesAdded: 2,
      knowledgeBasesRemoved: 0
    });
    expect(JSON.stringify(audited)).not.toContain(TEAM_KB);
  });

  it("leaves what a call does not name as it is", async () => {
    const project = await createProject("Teilweise", "workspace");
    await attach(t.kai.id, project.id, [TEAM_KB]);
    await t.expectOk(t.kai.id, "projects.setup.set", {
      params: { projectId: project.id },
      payload: { defaultAgent: null, skills: [] }
    });
    expect((await readSetup(t.kai.id, project.id)).knowledgeBases).toEqual([TEAM_KB]);
  });

  it("lets a private project's creator attach what they alone may search, their own among it", async () => {
    const project = await createProject("Notizen Kai", "private");
    expect(choicesOf(await readSetup(t.kai.id, project.id))).toEqual({
      [TEAM_KB]: "ok",
      [OPEN_KB]: "ok",
      [GRANTED_KB]: "ok",
      [OWN_KB]: "ok"
    });
    const set = await attach(t.kai.id, project.id, [GRANTED_KB, OWN_KB]);
    expect(set.statusCode, set.body).toBe(200);
  });

  it("offers a run what every reader of its chat may search; what stops applying answers in no chat", async () => {
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
    // One run per chat: a chat has one active run at a time.
    const runOf = new Map<string, AgentRun["id"]>();
    const offered = async (conversation: Conversation, user: UserRecord) => {
      const runId = runOf.get(conversation.id) ?? (await startRun(conversation, user));
      const offer = await platform.conversationOffer.offerOf({
        clientInstanceId,
        conversationId: conversation.id,
        agentToolNames: [],
        user: person(user),
        runId
      });
      return offer?.knowledgeBases ?? [];
    };
    const startRun = async (conversation: Conversation, user: UserRecord) => {
      const message = await t.stores.conversations.appendMessage({
        clientInstanceId,
        conversationId: conversation.id,
        role: "user",
        text: "Was steht im Handbuch?"
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
        correlationId: "corr_prj8"
      });
      runsById.set(run.id, run);
      runOf.set(conversation.id, run.id);
      return run.id;
    };

    const shared = await createProject("Geteilt", "workspace");
    await attach(t.kai.id, shared.id, [TEAM_KB, OPEN_KB]);
    const lenaChat = await chatIn(t.lena.id, shared.id);
    expect(await offered(lenaChat, t.lena)).toEqual(expect.arrayContaining([TEAM_KB, OPEN_KB]));
    // Taken out of the team, the team's handbook stays attached, shown as not applying, and is
    // searched in no chat of the project, Kai's or Lena's.
    await availableIn(TEAM_KB, []);
    const narrowed = await readSetup(t.kai.id, shared.id);
    expect(narrowed.knowledgeBases).toEqual([TEAM_KB, OPEN_KB]);
    // Nobody may search it any more, so it is no choice; the page lists it as not applying.
    expect(choicesOf(narrowed)[TEAM_KB]).toBeUndefined();
    expect(await offered(lenaChat, t.lena)).toEqual([OPEN_KB]);
    expect(await offered(await chatIn(t.kai.id, shared.id), t.kai)).toEqual([OPEN_KB]);
    await availableIn(TEAM_KB, [team]);

    // A private project: Kai's own chat searches his grant and his own.
    const own = await createProject("Eigen", "private");
    await attach(t.kai.id, own.id, [GRANTED_KB, OWN_KB, TEAM_KB]);
    const kaiChat = await chatIn(t.kai.id, own.id);
    expect(await offered(kaiChat, t.kai)).toEqual(
      expect.arrayContaining([GRANTED_KB, OWN_KB, TEAM_KB])
    );
    // Shared since: neither reaches a chat others read, whoever's turn it is.
    await shareNow(own.id);
    const after = await readSetup(t.kai.id, own.id);
    expect(after.knowledgeBases).toEqual([GRANTED_KB, OWN_KB, TEAM_KB]);
    expect(choicesOf(after)).toMatchObject({
      [GRANTED_KB]: "not_everyone_may_use",
      [OWN_KB]: "own_in_shared_project"
    });
    expect(await offered(kaiChat, t.kai)).toEqual([TEAM_KB]);
    expect(await offered(await chatIn(t.lena.id, own.id), t.lena)).toEqual([TEAM_KB]);
  });

  it("lists no choices and offers nothing where the module `knowledge` is off", async () => {
    const project = await createProject("Ohne Wissen", "workspace");
    await attach(t.kai.id, project.id, [TEAM_KB]);
    const off = {
      ...modules,
      isEnabled: (name: Parameters<typeof modules.isEnabled>[0]) =>
        name !== "knowledge" && modules.isEnabled(name)
    };
    const service = new ProjectSetupService({
      stores: t.stores,
      clientInstanceId,
      config: instanceConfig,
      modules: off,
      configAssets: {
        store: t.stores.configAssets,
        source: createConfigAssetSource({ store: t.stores.configAssets, clientInstanceId })
      }
    });
    const setup = await service.setup(person(t.kai), project.id);
    expect(setup.knowledgeBases).toEqual([TEAM_KB]);
    expect(setup.knowledgeBaseChoices).toBeUndefined();
  });

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
