import {
  SUBJECT_TOOL_PREFIX,
  WORKFLOW_ASSET_KIND,
  type ConversationOfferSource,
  type ModuleSnapshot,
  type PlatformStores,
  type ShippedSkill
} from "@vivd-catalyst/core";
import {
  PLATFORM_ASSET_TOOL_NAMES,
  createPlatformAssetBinding,
  createPlatformAssetTools,
  ToolRegistry,
  type PlatformAssetBinding
} from "@vivd-catalyst/tool-execution";
import type { AnyToolDefinition } from "@vivd-catalyst/tool-sdk";
import { workflowAuthoringSkill, workflowsModule } from "@vivd-catalyst/workflows";

// What a conversation about an asset is offered beyond its agent's definition: the tools the
// server binds to its subject, and the skill the platform ships for an asset of that kind.

/** The tool an agent reads a skill with. A shipped skill is read through it like any other. */
const READ_SKILL_TOOL = "read_skill";

interface ConversationOfferInput {
  stores: Pick<PlatformStores, "conversations">;
  modules: ModuleSnapshot;
  /** Whether this process has a tool: registered, enabled and of no module that is off. */
  hasTool(toolName: string): boolean;
}

/** The skills the platform ships for the assets of one kind. */
function shippedSkillsOf(kind: string, modules: ModuleSnapshot): ShippedSkill[] {
  return kind === WORKFLOW_ASSET_KIND && modules.isEnabled(workflowsModule.name)
    ? [workflowAuthoringSkill]
    : [];
}

function createConversationOffer(input: ConversationOfferInput): ConversationOfferSource {
  return {
    async offerOf({ clientInstanceId, conversationId }) {
      const conversation = await input.stores.conversations.getConversation(
        clientInstanceId,
        conversationId
      );
      const subject = conversation?.subject;
      if (!subject) return undefined;
      // A skill nobody can read is not listed: it would promise what no tool answers.
      const skills = input.hasTool(READ_SKILL_TOOL)
        ? shippedSkillsOf(subject.kind, input.modules)
        : [];
      return {
        toolNames: [
          ...PLATFORM_ASSET_TOOL_NAMES,
          ...(skills.length > 0 ? [READ_SKILL_TOOL] : [])
        ].filter((toolName) => input.hasTool(toolName)),
        skills
      };
    }
  };
}

/**
 * The tools an agent may call in one conversation: those its definition lists, without the
 * tools of a subject, and those the conversation is offered.
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
 * Everything a process has of the tools of a subject: the tools themselves, the port they are
 * carried out through, which the process binds once it has its asset operations, and what a
 * conversation is offered. The tools are built before the registry that holds them, so the
 * registry is attached when it exists; a run asks for it only after that.
 */
export function createSubjectTools(input: Pick<ConversationOfferInput, "stores" | "modules">) {
  const attached: { tools?: ToolRegistry } = {};
  const platformAssets: PlatformAssetBinding = createPlatformAssetBinding();
  return {
    platformAssets,
    tools: createPlatformAssetTools(platformAssets.calls),
    conversationOffer: createConversationOffer({
      ...input,
      hasTool: (toolName) => attached.tools?.has(toolName) ?? false
    }),
    /**
     * The tool registry of the process. The tools of a subject are bound to a conversation by
     * the server and listed by no agent, so no release names them: they are enabled beside
     * the tools the release names, and the switch of their module turns them off.
     */
    registry(tools: AnyToolDefinition[], enabledByRelease: ReadonlySet<string>): ToolRegistry {
      attached.tools = new ToolRegistry({
        tools,
        enabledToolNames: new Set([...enabledByRelease, ...PLATFORM_ASSET_TOOL_NAMES]),
        modules: input.modules
      });
      return attached.tools;
    }
  };
}
