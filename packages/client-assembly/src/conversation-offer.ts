import {
  createScheduledStartTools,
  createDataStoreDescriptionTool,
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
  getSubjectUserId,
  isAuthenticatedServicePrincipal,
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
  type ConversationOfferSource,
  type ModuleSnapshot,
  type PlatformStores,
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
// and every agent is offered the question to the person (ASK-1).

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

/** The tools that build an App, where this process can build one. */
function appToolNames(hasTool: (toolName: string) => boolean): string[] {
  return hasTool(WORKSPACE_OPEN_TOOL_NAME) && hasTool(WRITE_FILE_TOOL) ? APP_TOOLS : [];
}

interface ConversationOfferInput {
  stores: {
    conversations: Pick<PlatformStores["conversations"], "getConversation">;
    /** The run an offer is for: whether it is its person's own (SCOPE-MYCHATS). */
    agentRuns?: Pick<PlatformStores["agentRuns"], "getAgentRun">;
    /** The skills a person switched on for their own chats (SCOPE-MYCHATS). */
    configAssets?: Pick<PlatformStores["configAssets"], "listPersonalChatSkills">;
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
 * it, and that acts for that person now. A run of another member of the conversation gets that
 * member's own and never the owner's; a subagent, a Workflow step, a service principal, and a
 * run started or acting with a key or for an embedding host get none.
 */
async function personalSkillNames(
  input: ConversationOfferInput,
  request: OfferRequest,
  conversation: OfferedConversation
): Promise<string[]> {
  const { user, runId, clientInstanceId } = request;
  const { agentRuns, configAssets } = input.stores;
  if (!user || !runId || !agentRuns || !configAssets) return [];
  if (
    isAuthenticatedServicePrincipal(user) ||
    user.delegatedActor !== undefined ||
    user.keyScopes !== undefined
  ) {
    return [];
  }
  if (conversation.kind !== "chat" || conversation.status !== "active") return [];
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
    return [];
  }
  return (await configAssets.listPersonalChatSkills({ clientInstanceId, userId: person }))
    .filter((skill) => skill.inMyChats)
    .map((skill) => skill.name);
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
      const skillNames = holds && readsSkills ? offeredSkillNames(subject, input.modules) : [];
      const ownSkillNames = readsSkills
        ? await personalSkillNames(input, request, conversation)
        : [];
      const rowNames =
        holds && subject?.kind === DATA_STORE_ASSET_KIND
          ? (["describe", "query", "preview_rows", "insert", "update", "delete_rows"] as const).map(
              (verb) => dataStoreOperationName(subject.name, verb)
            )
          : [];
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
      const toolNames = [
        ...PLATFORM_TOOL_NAMES.filter((toolName) => agentToolNames.includes(toolName)),
        ...(holds
          ? [
              DATA_STORE_DESCRIPTION_TOOL_NAME,
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
        ...(holds ? { orientation: PLATFORM_ORIENTATION } : {})
      };
    }
  };
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
    "stores" | "modules" | "dataTools" | "dataToolDescribeTimeoutMs" | "policy" | "toolRights"
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
