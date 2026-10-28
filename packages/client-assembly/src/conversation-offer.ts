import {
  createScheduledStartTools,
  createDataStoreDescriptionTool,
  createDataStoreUseTool,
  DATA_STORE_USE_VERBS,
  SCHEDULED_START_TOOL_NAMES
} from "@work-shape/catalyst-tool-execution";
import { describeAgentDataTools } from "@work-shape/catalyst-agent-runtime";
import { createPlatformAssetCalls, type AssetWorkflowOptions } from "@work-shape/catalyst-server";
import { connectionProposalCatalogue } from "./connection-proposal-catalogue";
import { HTTP_API_CONNECTOR_TYPE, type Catalogue } from "@work-shape/catalyst-connections";
import {
  ASK_QUESTION_TOOL_NAME,
  RUN_AGENT_TOOL_NAME,
  DATA_STORE_ASSET_KIND,
  DATA_STORE_DESCRIPTION_TOOL_NAME,
  DATA_STORE_USE_TOOL_NAME,
  asCollaborationWorkspaceId,
  getSubjectUserId,
  isAuthenticatedServicePrincipal,
  mayUseOwnInChat,
  dataStoreOperationName,
  resolvePolicy,
  type PolicyDefaults,
  type ObjectStorage,
  type CentralPolicySetting,
  type DataToolSource,
  SUBJECT_TOOL_PREFIX,
  type ConnectorTypeRegistry,
  type AccessResource,
  type Authorizer,
  type Conversation,
  type ConversationOfferSource,
  type ModuleSnapshot,
  type PlatformStores,
  type ProjectFolderPort,
  type ProjectInstructions,
  type ProjectSkillsPort,
  type AuditRecorder,
  auditActorFromUser,
  PROJECT_INSTRUCTIONS_PATH,
  projectFolderManifest,
  projectInstructionsText,
  type ToolExecutionContext
} from "@work-shape/catalyst-core";
import {
  KNOWLEDGE_ADD_FILES_TOOL_NAME,
  createKnowledgeAddFilesTool,
  APP_SAVE_TOOL_NAME,
  APP_PUBLISH_TOOL_NAME,
  createAppPublishTool,
  createAppTryTools,
  APP_TRY_TOOL_NAMES,
  PREVIEW_CAPTURE_TOOL_NAME,
  WORKSPACE_OPEN_TOOL_NAME,
  createAppSaveTool,
  createAskQuestionTool,
  createAppEditTool,
  APP_EDIT_TOOL_NAME,
  createConnectionDraftTool,
  createConnectionOfferTool,
  createConnectionProposeTool,
  CONNECTION_DRAFT_TOOL_NAME,
  CONNECTION_OFFER_TOOL_NAME,
  CONNECTION_PROPOSE_TOOL_NAME,
  createPlatformAssetBinding,
  createPlatformAssetTools,
  createPlatformDiscoveryTools,
  createRunAgentTool,
  createWorkflowTestTools,
  WORKFLOW_TEST_TOOL_NAMES,
  ToolRegistry,
  type PlatformAssetBinding
} from "@work-shape/catalyst-tool-execution";
import type { AnyToolDefinition } from "@work-shape/catalyst-tool-sdk";
import {
  PLATFORM_MODULE_TOOL_NAMES,
  PLATFORM_ORIENTATION,
  PLATFORM_TOOL_NAMES
} from "./platform-orientation";
import { offeredSkillNames } from "./shipped-skills";

// What a conversation is offered beyond its agent's definition. An agent holds the platform's
// tools when its own definition lists them: it is offered those it lists, the orientation on
// the platform in its system prompt and the skills the platform ships, the documentation in
// every conversation, in one about an asset those for its kind and in one about none yet those
// of every kind, since the agent may open any. Every other agent gets none of them. Every
// agent, where Apps exist, is offered what opens a folder in the preview and saves it as an App,
// and every agent is offered the question to the person (ASK-1). Every agent of a conversation
// is offered the read tools of the Data Stores the person added to it (STORE-USE-1): the
// person's step is the consent, and each call still asks the person's right.

/** Whether an agent whose definition lists these tools holds the platform's. */
function holdsPlatformTools(agentToolNames: readonly string[]): boolean {
  return agentToolNames.some((toolName) => PLATFORM_TOOL_NAMES.includes(toolName));
}

/** The tool an agent reads a skill with. A shipped skill is read through it like any other. */
const READ_SKILL_TOOL = "read_skill";

/** The tool an App's folder is written with. Without it nothing can be opened. */
const WRITE_FILE_TOOL = "workspace.write_file";

/**
 * What every agent builds an App with: the open, the save, and the file tools that write,
 * change and read its folder. Offered only where a folder can be written and opened, each tool
 * as far as the process has it.
 */
const APP_TOOLS = [
  WORKSPACE_OPEN_TOOL_NAME,
  PREVIEW_CAPTURE_TOOL_NAME,
  APP_SAVE_TOOL_NAME,
  APP_EDIT_TOOL_NAME,
  APP_PUBLISH_TOOL_NAME,
  ...APP_TRY_TOOL_NAMES,
  WRITE_FILE_TOOL,
  "workspace.edit_file",
  "workspace.read_file"
];

/**
 * What an agent works on its project's folder with (PRJ-2): the file tools, which reach it at
 * `project/`. Offered in a chat of a project whose folder the run's person reads.
 */
const PROJECT_FOLDER_TOOLS = [
  "workspace.list_files",
  "workspace.read_file",
  "workspace.write_file",
  "workspace.edit_file"
];

/** The tools that build an App, where this process can build one. */
function appToolNames(hasTool: (toolName: string) => boolean): string[] {
  return hasTool(WORKSPACE_OPEN_TOOL_NAME) && hasTool(WRITE_FILE_TOOL) ? APP_TOOLS : [];
}

interface ConversationOfferInput {
  stores: {
    conversations: Pick<PlatformStores["conversations"], "getConversation"> &
      Partial<Pick<PlatformStores["conversations"], "listConversationDataStores">>;
    /**
     * The run an offer is for: whether it is its person's own (SCOPE-MYCHATS). Where the run
     * records the project's instructions it took (PRJ-3).
     */
    agentRuns?: Pick<PlatformStores["agentRuns"], "getAgentRun"> &
      Partial<Pick<PlatformStores["agentRuns"], "recordAgentRunProject">>;
    /** The skills a person switched on for their own chats (SCOPE-MYCHATS). */
    configAssets?: Pick<PlatformStores["configAssets"], "listPersonalChatSkills">;
    /**
     * Whose chat the offer is for: only one its person alone reads (SCOPE-MYCHATS). Where a
     * store added to a conversation is owned: a Personal Workspace's stays in it (STORE-USE-1).
     */
    workspaces?: Pick<PlatformStores["workspaces"], "getWorkspace">;
    /** A person's own settings: a tool they set to Never is not offered to their runs (OP-6). */
    userOperationSettings?: Pick<PlatformStores["userOperationSettings"], "list">;
  };
  modules: ModuleSnapshot;
  /** Attached after module startup; the source drops draft and unavailable stores. */
  dataTools?: () => DataToolSource | undefined;
  dataToolDescribeTimeoutMs?: number;
  policy?: {
    instanceDefaults: PolicyDefaults;
    centralSettings(): readonly CentralPolicySetting[] | Promise<readonly CentralPolicySetting[]>;
  };
  /** Whether this process has a tool: registered, enabled and of no module that is off. */
  hasTool(toolName: string): boolean;
  /** The folder of the project a chat is in (PRJ-2): its manifest goes into the run's prompt. */
  projectFolder?: () => ProjectFolderPort | undefined;
  /**
   * The skills (PRJ-7) and Knowledge Bases (PRJ-8) of the project a chat is in: offered beside
   * its agent's own.
   */
  projectSkills?: () => ProjectSkillsPort | undefined;
  /** Where a run's read of the project's instructions is audited, by project and version. */
  audit?: AuditRecorder;
  /**
   * The right a person needs to be offered a tool, by tool: a listed tool whose right the
   * person of the run lacks is withheld from the model. Asked of the instance's authorizer.
   */
  toolRights?: Readonly<Record<string, { action: string; resource: AccessResource }>>;
  authorizer?: () => Authorizer | undefined;
}

/**
 * The tools the person of the run set to Never (OP-6): their agents are not offered them. A
 * call that arrives anyway is refused by the policy. A run without a person withholds nothing.
 */
async function neverToolNames(
  input: ConversationOfferInput,
  clientInstanceId: Parameters<ConversationOfferSource["offerOf"]>[0]["clientInstanceId"],
  toolNames: readonly string[],
  user: Parameters<ConversationOfferSource["offerOf"]>[0]["user"]
): Promise<string[]> {
  const settings = input.stores.userOperationSettings;
  if (!user || !settings || toolNames.length === 0 || isAuthenticatedServicePrincipal(user)) {
    return [];
  }
  const never = new Set(
    (await settings.list({ clientInstanceId, userId: getSubjectUserId(user) }))
      .filter((setting) => setting.value === "never")
      .map((setting) => setting.operation)
  );
  return toolNames.filter((toolName) => never.has(toolName));
}

/** The listed tools of a right the person lacks. A run without a person withholds nothing. */
async function withheldToolNames(
  input: ConversationOfferInput,
  agentToolNames: readonly string[],
  user: Parameters<ConversationOfferSource["offerOf"]>[0]["user"],
  workspaceId: string
): Promise<string[]> {
  const rights = input.toolRights ?? {};
  const listed = agentToolNames.filter((toolName) => Object.hasOwn(rights, toolName));
  const authorizer = input.authorizer?.();
  if (listed.length === 0 || !user || !authorizer) return [];
  const access = await authorizer.forActor(user, { workspaceId });
  return listed.filter((toolName) => {
    const right = rights[toolName];
    return right !== undefined && !access.authorize(right.action, right.resource).allowed;
  });
}

type OfferRequest = Parameters<ConversationOfferSource["offerOf"]>[0];
type OfferedConversation = NonNullable<
  Awaited<ReturnType<ConversationOfferInput["stores"]["conversations"]["getConversation"]>>
>;

/**
 * The skills the run's person switched on for their own chats (SCOPE-MYCHATS): only for a run
 * of a chat that its owner started themself in a first-party session, as the stored run records
 * it, and that acts for that person now, in a chat they created that no one else reads (as a
 * personal Connection requires). A chat other people read gets none, whoever's turn it is; a
 * subagent, a Workflow step, a service principal, and a run started or acting with a key or for
 * an embedding host get none.
 */
async function personalSkillNames(
  input: ConversationOfferInput,
  request: OfferRequest,
  conversation: OfferedConversation
): Promise<string[]> {
  const person = await ownRunPerson(input, request, conversation);
  if (person === undefined || !input.stores.configAssets) return [];
  return (
    await input.stores.configAssets.listPersonalChatSkills({
      clientInstanceId: request.clientInstanceId,
      userId: person
    })
  )
    .filter((skill) => skill.inMyChats)
    .map((skill) => skill.name);
}

/**
 * The person of a run that may be offered what is theirs alone (SCOPE-MYCHATS): the rules of
 * `personalSkillNames`. Nothing for any other run.
 */
async function ownRunPerson(
  input: ConversationOfferInput,
  request: OfferRequest,
  conversation: OfferedConversation
): Promise<string | undefined> {
  const { user, runId, clientInstanceId } = request;
  const { agentRuns, configAssets, workspaces } = input.stores;
  if (!user || !runId || !agentRuns || !configAssets || !workspaces) return undefined;
  // Only a chat no one but its person reads, as for a personal Connection: one they created,
  // in their own Personal Workspace or private. A team-visible chat, or one another person
  // created, gets none, as the skill's text would reach its other readers.
  const workspace = await workspaces.getWorkspace(
    clientInstanceId,
    conversation.collaborationWorkspaceId
  );
  if (!mayUseOwnInChat(user, conversation, workspace)) return undefined;
  const person = getSubjectUserId(user);
  const run = await agentRuns.getAgentRun({ clientInstanceId, runId });
  const authorization = run?.authorization;
  if (
    !run ||
    !authorization ||
    run.conversationId !== conversation.id ||
    run.ownerUserId !== person ||
    run.parentRunId ||
    run.workflowStepRunId ||
    run.principalId ||
    authorization.personalConnectionsAllowed !== true ||
    authorization.delegatedActor !== undefined ||
    authorization.subjectUserId !== person ||
    authorization.principal.kind !== "user" ||
    authorization.principal.id !== person
  ) {
    return undefined;
  }
  return person;
}

/**
 * The Knowledge Bases of the chat's project (PRJ-8): those every reader of the chat may search,
 * and the person's own only where the run may be offered what is theirs alone. Nothing where
 * the module `knowledge` is off.
 */
async function projectKnowledgeBaseNames(
  input: ConversationOfferInput,
  request: OfferRequest,
  conversation: OfferedConversation
): Promise<string[]> {
  const port = input.projectSkills?.();
  if (!port?.knowledgeBasesOf) return [];
  const found = await port.knowledgeBasesOf({
    clientInstanceId: request.clientInstanceId,
    conversationId: request.conversationId,
    ...(request.user ? { user: request.user } : {})
  });
  if (!found) return [];
  const own =
    found.own.length > 0 && (await ownRunPerson(input, request, conversation)) !== undefined
      ? found.own
      : [];
  return [...new Set([...found.shared, ...own])];
}

/**
 * The skills of the chat's project (PRJ-7): those its audience may use, and the person's own
 * only where the run may be offered what is theirs alone, as their own chats are. Reading one
 * of those marks the chat personal, as `read_skill` marks any of the person's own.
 */
async function projectSkillNames(
  input: ConversationOfferInput,
  request: OfferRequest,
  conversation: OfferedConversation
): Promise<{ shared: string[]; own: string[] }> {
  const port = input.projectSkills?.();
  if (!port) return { shared: [], own: [] };
  const skills = await port.skillsOf({
    clientInstanceId: request.clientInstanceId,
    conversationId: request.conversationId,
    ...(request.user ? { user: request.user } : {})
  });
  if (!skills) return { shared: [], own: [] };
  const own =
    skills.own.length > 0 && (await ownRunPerson(input, request, conversation)) !== undefined
      ? skills.own
      : [];
  return { shared: skills.shared, own };
}

/**
 * The names of the Data Stores the person added to the conversation (STORE-USE-1). A store of a
 * Personal Workspace is offered only in a conversation of that workspace: one moved elsewhere
 * since leaves it out (owner reach).
 */
async function usedStores(
  input: ConversationOfferInput,
  conversation: Pick<Conversation, "id" | "clientInstanceId" | "collaborationWorkspaceId">
): Promise<string[]> {
  const list = input.stores.conversations.listConversationDataStores;
  if (!list) return [];
  const stores = await list({
    clientInstanceId: conversation.clientInstanceId,
    conversationId: conversation.id
  });
  const names: string[] = [];
  for (const store of stores) {
    if (
      store.scope.kind === "workspace" &&
      store.scope.workspaceId !== conversation.collaborationWorkspaceId
    ) {
      const owner = await input.stores.workspaces?.getWorkspace(
        conversation.clientInstanceId,
        asCollaborationWorkspaceId(store.scope.workspaceId)
      );
      if (owner?.kind !== "shared") continue;
    }
    names.push(store.name);
  }
  return names;
}

function createConversationOffer(input: ConversationOfferInput): ConversationOfferSource {
  return {
    async offerOf(request) {
      const { clientInstanceId, conversationId, agentToolNames, user } = request;
      const conversation = await input.stores.conversations.getConversation(
        clientInstanceId,
        conversationId
      );
      if (!conversation) return undefined;
      const { subject } = conversation;
      const holds = holdsPlatformTools(agentToolNames);
      // A skill nobody can read is not listed: it would promise what no tool answers.
      const readsSkills = input.hasTool(READ_SKILL_TOOL);
      const project = readsSkills
        ? await projectSkillNames(input, request, conversation)
        : { shared: [], own: [] };
      const skillNames = [
        ...new Set([
          ...(holds && readsSkills ? offeredSkillNames(subject, input.modules) : []),
          ...project.shared
        ])
      ];
      const ownSkillNames = readsSkills
        ? [
            ...new Set([
              ...(await personalSkillNames(input, request, conversation)),
              ...project.own
            ])
          ]
        : [];
      const subjectRowNames =
        holds && subject?.kind === DATA_STORE_ASSET_KIND
          ? (["describe", "query", "preview_rows", "insert", "update", "delete_rows"] as const).map(
              (verb) => dataStoreOperationName(subject.name, verb)
            )
          : [];
      const rowNames = [
        ...new Set([
          ...subjectRowNames,
          ...(await usedStores(input, conversation)).flatMap((name) =>
            DATA_STORE_USE_VERBS.map((verb) => dataStoreOperationName(name, verb))
          )
        ])
      ];
      const source = input.dataTools?.();
      // Use the run's existing bounded description path. An unavailable source offers nothing.
      const rowTools = (
        await describeAgentDataTools(
          { toolNames: rowNames },
          source
            ? {
                describe: (names) =>
                  source.describe(names, { workspaceId: conversation.collaborationWorkspaceId })
              }
            : undefined,
          input.dataToolDescribeTimeoutMs
        )
      ).described;
      const centralSettings =
        rowTools.length > 0 ? ((await input.policy?.centralSettings()) ?? []) : [];
      const offeredRowTools = rowTools.filter(
        (tool) =>
          tool.permission?.mode !== "deny" &&
          (!input.policy ||
            resolvePolicy({
              definition: { name: tool.name, effect: tool.effect },
              origin: { kind: "user" },
              instanceDefaults: input.policy.instanceDefaults,
              centralSettings,
              targets: [
                {
                  assetKind: DATA_STORE_ASSET_KIND,
                  workspaceId: conversation.collaborationWorkspaceId
                }
              ],
              callerCanConfirm: false,
              canPause: true
            }).value !== "deny")
      );
      const folder = await projectFolderOf(input, request);
      const knowledgeBases = await projectKnowledgeBaseNames(input, request, conversation);
      const toolNames = [
        ...PLATFORM_TOOL_NAMES.filter((toolName) => agentToolNames.includes(toolName)),
        ...(holds
          ? [
              DATA_STORE_DESCRIPTION_TOOL_NAME,
              DATA_STORE_USE_TOOL_NAME,
              ...WORKFLOW_TEST_TOOL_NAMES,
              KNOWLEDGE_ADD_FILES_TOOL_NAME,
              ...SCHEDULED_START_TOOL_NAMES
            ]
          : []),
        ...(holds ? [CONNECTION_PROPOSE_TOOL_NAME] : []),
        ...(holds || subject?.kind === "connection"
          ? [CONNECTION_DRAFT_TOOL_NAME, CONNECTION_OFFER_TOOL_NAME]
          : []),
        ...appToolNames(input.hasTool),
        ...(folder ? PROJECT_FOLDER_TOOLS : []),
        ASK_QUESTION_TOOL_NAME,
        ...(skillNames.length > 0 || ownSkillNames.length > 0 ? [READ_SKILL_TOOL] : [])
      ]
        .filter((toolName) => input.hasTool(toolName))
        .concat(offeredRowTools.map((tool) => tool.name));
      const withheld = [
        ...(await withheldToolNames(
          input,
          agentToolNames,
          user,
          conversation.collaborationWorkspaceId
        )),
        ...(await neverToolNames(
          input,
          clientInstanceId,
          [...new Set([...agentToolNames, ...toolNames])],
          user
        ))
      ];
      return {
        ...(subject ? { subject } : {}),
        ...(withheld.length > 0 ? { withheldToolNames: withheld } : {}),
        toolNames,
        skillNames,
        ...(ownSkillNames.length > 0 ? { personalSkillNames: ownSkillNames } : {}),
        ...(holds ? { orientation: PLATFORM_ORIENTATION } : {}),
        ...(folder ? { projectFolder: folder } : {}),
        ...(knowledgeBases.length > 0 ? { knowledgeBases } : {})
      };
    },
    projectInstructionsOf: (request) => projectInstructionsOf(input, request)
  };
}

/**
 * The project's instructions a run takes at its start (PRJ-3): the chat's project's `AGENTS.md`
 * where the person of the run reads the project, as its file tools reach it; a subagent's thread
 * reaches its root chat's. The run records the project and the version it took, and the read is
 * audited by the two ids. A run that goes on after a pause recorded them already and takes that
 * version again, so a change during the run is used from the next one.
 */
async function projectInstructionsOf(
  input: ConversationOfferInput,
  request: Parameters<NonNullable<ConversationOfferSource["projectInstructionsOf"]>>[0]
): Promise<ProjectInstructions | undefined> {
  const port = input.projectFolder?.();
  const runs = input.stores.agentRuns;
  if (!port) return undefined;
  const folder = await port.folderOf({
    clientInstanceId: request.clientInstanceId,
    conversationId: request.conversationId,
    ...(request.user ? { user: request.user } : {})
  });
  if (!folder) return undefined;
  const run = await runs?.getAgentRun({
    clientInstanceId: request.clientInstanceId,
    runId: request.runId
  });
  const recorded = run?.project?.projectId === folder.projectId ? run.project : undefined;
  let version: number | undefined;
  let bytes: Uint8Array | undefined;
  if (recorded) {
    version = recorded.instructionsVersion;
    bytes =
      version === undefined
        ? undefined
        : await port.readVersion(folder, PROJECT_INSTRUCTIONS_PATH, version);
  } else {
    const current = await port.read(folder, PROJECT_INSTRUCTIONS_PATH);
    version = current?.file.version;
    bytes = current?.bytes;
    if (run) {
      await runs?.recordAgentRunProject?.({
        clientInstanceId: request.clientInstanceId,
        runId: request.runId,
        project: {
          projectId: folder.projectId,
          ...(version === undefined ? {} : { instructionsVersion: version })
        }
      });
    }
    if (version !== undefined && request.user) {
      // The project and the version: never the path or the text.
      await input.audit?.record({
        type: "project.instructions_read",
        status: "success",
        actor: auditActorFromUser(request.user),
        subject: folder.projectId,
        correlationId: run?.correlationId ?? request.runId,
        metadata: { version, runId: request.runId }
      });
    }
  }
  if (version === undefined || !bytes) return undefined;
  const { text, truncated } = projectInstructionsText(new TextDecoder().decode(bytes));
  if (text.trim() === "") return undefined;
  return { projectId: folder.projectId, title: folder.title, version, text, truncated };
}

/**
 * The manifest of the chat's project folder, where the chat is in a project whose folder the
 * person of the run reads and this process has the file tools that reach it.
 */
async function projectFolderOf(
  input: ConversationOfferInput,
  request: OfferRequest
): Promise<string | undefined> {
  const port = input.projectFolder?.();
  if (!port || !input.hasTool("workspace.read_file")) return undefined;
  const folder = await port.folderOf({
    clientInstanceId: request.clientInstanceId,
    conversationId: request.conversationId,
    ...(request.user ? { user: request.user } : {})
  });
  if (!folder) return undefined;
  return projectFolderManifest({ title: folder.title, files: await port.list(folder) });
}

/**
 * The tools an agent may call in one conversation: those its definition lists, without the
 * asset tools, and those the conversation is offered, which holds the asset tools the agent
 * lists.
 */
export async function conversationToolNames(
  listed: readonly string[],
  offer: Awaited<ReturnType<ConversationOfferSource["offerOf"]>>
): Promise<string[]> {
  return [
    ...new Set([
      ...listed.filter((toolName) => !toolName.startsWith(SUBJECT_TOOL_PREFIX)),
      ...(offer?.toolNames ?? [])
    ])
  ];
}

/**
 * Everything a process has of the tools the platform offers a conversation: the tools
 * themselves, the port they are carried out through, which the process binds once it has its
 * asset operations, and what a conversation is offered. The tools are built before the
 * registry that holds them, so the registry is attached when it exists; a run asks for it
 * only after that.
 */
export function createPlatformTools(
  input: Pick<
    ConversationOfferInput,
    | "stores"
    | "modules"
    | "dataTools"
    | "dataToolDescribeTimeoutMs"
    | "policy"
    | "toolRights"
    | "projectFolder"
    | "projectSkills"
    | "audit"
  > & {
    /**
     * The Connections of the instance, where the module `connections` is on: the agent's draft
     * of a REST API's tools is checked against their Connector types.
     */
    connections?: { connectorTypes: ConnectorTypeRegistry; catalogue?: Catalogue } | undefined;
    /**
     * The process's stores, from which the agent's proposal of a catalogue entry reads the
     * instance's Connections and the person's sign-in. Without them it proposes no entry.
     */
    catalogueStores?: PlatformStores;
    workspaceObjects?: ObjectStorage;
  }
) {
  const attached: { tools?: ToolRegistry; authorizer?: Authorizer } = {};
  const catalogue =
    input.connections?.catalogue && input.catalogueStores
      ? connectionProposalCatalogue({
          catalogue: input.connections.catalogue,
          connectorTypes: input.connections.connectorTypes,
          stores: input.catalogueStores,
          authorizer: () => attached.authorizer
        })
      : undefined;
  const platformAssets: PlatformAssetBinding = createPlatformAssetBinding();
  return {
    /**
     * Binds the tools to the workflow of the asset operations of this process: the one the
     * API's own asset operations run, with the stores, kinds and audit of the instance. Every
     * process that runs agents binds it, the API process and an agent-run worker alike.
     */
    bind(options: AssetWorkflowOptions): void {
      attached.authorizer = options.authorizer;
      platformAssets.bind(createPlatformAssetCalls(options, input.workspaceObjects));
    },
    /** What `read_skill` says of a save of the skill it reads, for the person of the call. */
    skillSaveApproval: (context: ToolExecutionContext, name: string) =>
      platformAssets.calls.skillSaveApproval(context, name),
    tools: [
      createDataStoreDescriptionTool(),
      ...createPlatformDiscoveryTools(platformAssets.calls, {
        connectorTypes: input.connections?.connectorTypes,
        catalogue
      }),
      ...createPlatformAssetTools(platformAssets.calls),
      ...createWorkflowTestTools(),
      ...createScheduledStartTools(),
      createKnowledgeAddFilesTool(),
      createRunAgentTool(),
      createAskQuestionTool(),
      createAppSaveTool(platformAssets.calls),
      createAppEditTool(platformAssets.calls),
      createDataStoreUseTool(platformAssets.calls),
      createAppPublishTool(),
      ...createAppTryTools(),
      ...(input.connections
        ? [
            createConnectionProposeTool({
              connectorTypes: input.connections.connectorTypes,
              ...(catalogue ? { catalogue } : {})
            }),
            createConnectionDraftTool({
              connectorTypes: input.connections.connectorTypes,
              connectorType: HTTP_API_CONNECTOR_TYPE
            }),
            createConnectionOfferTool()
          ]
        : [])
    ],
    conversationOffer: createConversationOffer({
      stores: input.stores,
      modules: input.modules,
      ...(input.dataTools ? { dataTools: input.dataTools } : {}),
      ...(input.dataToolDescribeTimeoutMs === undefined
        ? {}
        : { dataToolDescribeTimeoutMs: input.dataToolDescribeTimeoutMs }),
      ...(input.policy ? { policy: input.policy } : {}),
      ...(input.toolRights ? { toolRights: input.toolRights } : {}),
      ...(input.projectFolder ? { projectFolder: input.projectFolder } : {}),
      ...(input.projectSkills ? { projectSkills: input.projectSkills } : {}),
      ...(input.audit ? { audit: input.audit } : {}),
      authorizer: () => attached.authorizer,
      hasTool: (toolName) => attached.tools?.has(toolName) ?? false
    }),
    /**
     * The tool registry of the process. The platform's tools are the platform's, so no release
     * names them: they are enabled beside the tools the release names, an agent's definition
     * decides which agent holds them, and the switch of their module turns them off. The tool
     * that reads a skill is enabled with them, so that the skills the platform ships are
     * readable wherever they are offered whatever the release enables: an agent's own
     * definition still lists the tool only where the release names it. So are the open and the
     * save of an App, which the `apps` module turns off; the file tools its folder is written
     * with stay the release's to enable. So is the question to the person (ASK-1).
     */
    registry(tools: AnyToolDefinition[], enabledByRelease: ReadonlySet<string>): ToolRegistry {
      attached.tools = new ToolRegistry({
        tools,
        enabledToolNames: new Set([
          ...enabledByRelease,
          ...PLATFORM_TOOL_NAMES,
          ...PLATFORM_MODULE_TOOL_NAMES,
          READ_SKILL_TOOL,
          RUN_AGENT_TOOL_NAME,
          ASK_QUESTION_TOOL_NAME,
          WORKSPACE_OPEN_TOOL_NAME,
          APP_SAVE_TOOL_NAME,
          APP_EDIT_TOOL_NAME
        ]),
        modules: input.modules
      });
      return attached.tools;
    }
  };
}
