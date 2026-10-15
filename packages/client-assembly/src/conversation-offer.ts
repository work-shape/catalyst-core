import { createPlatformAssetCalls, type AssetWorkflowOptions } from "@work-shape/catalyst-server";
import { HTTP_API_CONNECTOR_TYPE } from "@work-shape/catalyst-connections";
import {
  SUBJECT_TOOL_PREFIX,
  type ConnectorTypeRegistry,
  type ConversationOfferSource,
  type ModuleSnapshot,
  type PlatformStores
} from "@work-shape/catalyst-core";
import {
  PAGE_SAVE_AS_APP_TOOL_NAME,
  PAGE_SAVE_TOOL_NAME,
  createConnectionDraftTool,
  createPageSaveAsAppTool,
  createPlatformAssetBinding,
  createPlatformAssetTools,
  createPlatformDiscoveryTools,
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
// agent, where Pages exist, is offered what builds a Page and makes it an App.

/** Whether an agent whose definition lists these tools holds the platform's. */
function holdsPlatformTools(agentToolNames: readonly string[]): boolean {
  return agentToolNames.some((toolName) => PLATFORM_TOOL_NAMES.includes(toolName));
}

/** The tool an agent reads a skill with. A shipped skill is read through it like any other. */
const READ_SKILL_TOOL = "read_skill";

/** The tool a Page's folder is written with. Without it no Page can be built. */
const WRITE_FILE_TOOL = "workspace.write_file";

/**
 * What every agent builds a Page with: the save, the step to an App, and the file tools that
 * write, change and read the Page's folder. Offered only where a folder can be written and
 * saved, each tool as far as the process has it.
 */
const PAGE_TOOLS = [
  PAGE_SAVE_TOOL_NAME,
  PAGE_SAVE_AS_APP_TOOL_NAME,
  WRITE_FILE_TOOL,
  "workspace.edit_file",
  "workspace.read_file"
];

/** The tools that build a Page, where this process can build one. */
function pageToolNames(hasTool: (toolName: string) => boolean): string[] {
  return hasTool(PAGE_SAVE_TOOL_NAME) && hasTool(WRITE_FILE_TOOL) ? PAGE_TOOLS : [];
}

interface ConversationOfferInput {
  stores: Pick<PlatformStores, "conversations">;
  modules: ModuleSnapshot;
  /** Whether this process has a tool: registered, enabled and of no module that is off. */
  hasTool(toolName: string): boolean;
}

function createConversationOffer(input: ConversationOfferInput): ConversationOfferSource {
  return {
    async offerOf({ clientInstanceId, conversationId, agentToolNames }) {
      const conversation = await input.stores.conversations.getConversation(
        clientInstanceId,
        conversationId
      );
      if (!conversation) return undefined;
      const { subject } = conversation;
      const holds = holdsPlatformTools(agentToolNames);
      // A skill nobody can read is not listed: it would promise what no tool answers.
      const skillNames =
        holds && input.hasTool(READ_SKILL_TOOL) ? offeredSkillNames(subject, input.modules) : [];
      return {
        ...(subject ? { subject } : {}),
        toolNames: [
          ...PLATFORM_TOOL_NAMES.filter((toolName) => agentToolNames.includes(toolName)),
          ...pageToolNames(input.hasTool),
          ...(skillNames.length > 0 ? [READ_SKILL_TOOL] : [])
        ].filter((toolName) => input.hasTool(toolName)),
        skillNames,
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
  input: Pick<ConversationOfferInput, "stores" | "modules"> & {
    /**
     * The Connections of the instance, where the module `connections` is on: the agent's draft
     * of a REST API's tools is checked against their Connector types.
     */
    connections?: { connectorTypes: ConnectorTypeRegistry } | undefined;
  }
) {
  const attached: { tools?: ToolRegistry } = {};
  const platformAssets: PlatformAssetBinding = createPlatformAssetBinding();
  return {
    /**
     * Binds the tools to the workflow of the asset operations of this process: the one the
     * API's own asset operations run, with the stores, kinds and audit of the instance. Every
     * process that runs agents binds it, the API process and an agent-run worker alike.
     */
    bind(options: AssetWorkflowOptions): void {
      platformAssets.bind(createPlatformAssetCalls(options));
    },
    /** What `page.save` writes the App of a conversation with. */
    pageApps: platformAssets.calls,
    tools: [
      ...createPlatformDiscoveryTools(platformAssets.calls),
      ...createPlatformAssetTools(platformAssets.calls),
      createPageSaveAsAppTool(platformAssets.calls),
      ...(input.connections
        ? [
            createConnectionDraftTool({
              connectorTypes: input.connections.connectorTypes,
              connectorType: HTTP_API_CONNECTOR_TYPE
            })
          ]
        : [])
    ],
    conversationOffer: createConversationOffer({
      stores: input.stores,
      modules: input.modules,
      hasTool: (toolName) => attached.tools?.has(toolName) ?? false
    }),
    /**
     * The tool registry of the process. The platform's tools are the platform's, so no release
     * names them: they are enabled beside the tools the release names, an agent's definition
     * decides which agent holds them, and the switch of their module turns them off. The tool
     * that reads a skill is enabled with them, so that the skills the platform ships are
     * readable wherever they are offered whatever the release enables: an agent's own
     * definition still lists the tool only where the release names it. So are the two tools of
     * a Page, which the `apps` module turns off; the file tools a Page is written with stay the
     * release's to enable.
     */
    registry(tools: AnyToolDefinition[], enabledByRelease: ReadonlySet<string>): ToolRegistry {
      attached.tools = new ToolRegistry({
        tools,
        enabledToolNames: new Set([
          ...enabledByRelease,
          ...PLATFORM_TOOL_NAMES,
          ...PLATFORM_MODULE_TOOL_NAMES,
          READ_SKILL_TOOL,
          PAGE_SAVE_TOOL_NAME,
          PAGE_SAVE_AS_APP_TOOL_NAME
        ]),
        modules: input.modules
      });
      return attached.tools;
    }
  };
}
