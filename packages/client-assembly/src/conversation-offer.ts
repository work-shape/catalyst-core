import { createPlatformAssetCalls, type AssetWorkflowOptions } from "@vivd-catalyst/chat-server";
import {
  SUBJECT_TOOL_PREFIX,
  type ConversationOfferSource,
  type ModuleSnapshot,
  type PlatformStores
} from "@vivd-catalyst/core";
import {
  PLATFORM_ASSET_TOOL_NAMES,
  PLATFORM_DISCOVERY_TOOL_NAMES,
  createPlatformAssetBinding,
  createPlatformAssetTools,
  createPlatformDiscoveryTools,
  ToolRegistry,
  type PlatformAssetBinding
} from "@vivd-catalyst/tool-execution";
import type { AnyToolDefinition } from "@vivd-catalyst/tool-sdk";
import { offeredSkillNames } from "./shipped-skills";

// What a conversation is offered beyond its agent's definition. Every conversation: the tools
// that find, open, read and save an asset of the platform and the skill that says how the
// platform works. A conversation about an asset the skills the platform ships for its kind,
// one about none yet those of every kind, since the agent may open any.

/** The tool an agent reads a skill with. A shipped skill is read through it like any other. */
const READ_SKILL_TOOL = "read_skill";

interface ConversationOfferInput {
  stores: Pick<PlatformStores, "conversations">;
  modules: ModuleSnapshot;
  /** Whether this process has a tool: registered, enabled and of no module that is off. */
  hasTool(toolName: string): boolean;
}

function createConversationOffer(input: ConversationOfferInput): ConversationOfferSource {
  return {
    async offerOf({ clientInstanceId, conversationId }) {
      const conversation = await input.stores.conversations.getConversation(
        clientInstanceId,
        conversationId
      );
      if (!conversation) return undefined;
      const { subject } = conversation;
      // A skill nobody can read is not listed: it would promise what no tool answers.
      const skillNames = input.hasTool(READ_SKILL_TOOL)
        ? offeredSkillNames(subject, input.modules)
        : [];
      return {
        ...(subject ? { subject } : {}),
        toolNames: [
          ...PLATFORM_DISCOVERY_TOOL_NAMES,
          ...PLATFORM_ASSET_TOOL_NAMES,
          ...(skillNames.length > 0 ? [READ_SKILL_TOOL] : [])
        ].filter((toolName) => input.hasTool(toolName)),
        skillNames
      };
    }
  };
}

/**
 * The tools an agent may call in one conversation: those its definition lists, without the
 * asset tools, and those the conversation is offered.
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
export function createPlatformTools(input: Pick<ConversationOfferInput, "stores" | "modules">) {
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
    tools: [
      ...createPlatformDiscoveryTools(platformAssets.calls),
      ...createPlatformAssetTools(platformAssets.calls)
    ],
    conversationOffer: createConversationOffer({
      ...input,
      hasTool: (toolName) => attached.tools?.has(toolName) ?? false
    }),
    /**
     * The tool registry of the process. The tools the platform offers a conversation are
     * listed by no agent, so no release names them: they are enabled beside the tools the
     * release names, and the switch of their module turns them off. The tool that reads a
     * skill is enabled with them, so that the skills the platform ships are readable in every
     * conversation whatever the release enables: an agent's own definition still lists the
     * tool only where the release names it.
     */
    registry(tools: AnyToolDefinition[], enabledByRelease: ReadonlySet<string>): ToolRegistry {
      attached.tools = new ToolRegistry({
        tools,
        enabledToolNames: new Set([
          ...enabledByRelease,
          ...PLATFORM_DISCOVERY_TOOL_NAMES,
          ...PLATFORM_ASSET_TOOL_NAMES,
          READ_SKILL_TOOL
        ]),
        modules: input.modules
      });
      return attached.tools;
    }
  };
}
