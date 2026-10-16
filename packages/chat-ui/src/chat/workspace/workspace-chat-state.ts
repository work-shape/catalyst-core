import {
  type CollaborationWorkspaceAgents,
  type SafeConfig
} from "@work-shape/catalyst-api-client";
import { type TranslationContextValue } from "../../shared/i18n";
import { type ConversationControllerState } from "../conversation/conversation-controller-state";

export const WORKSPACE_AUTH_SCOPE = "standalone";

/**
 * Narrows the instance config to the agents the active Collaboration Workspace
 * offers. `getConfig` only knows the caller's Personal Workspace view, so it
 * stands in solely where that view is the right one: fixed-context sessions,
 * the Personal Workspace itself, and a failed workspace lookup. Anything else
 * waits for the workspace's own list instead of showing the wrong agents.
 */
export function workspaceScopedConfigFor(input: {
  config: SafeConfig | undefined;
  collaborationWorkspacesAvailable: boolean;
  workspaceAgents: CollaborationWorkspaceAgents | undefined;
  instanceViewApplies: boolean;
}): { config: SafeConfig | undefined; agentsLoading: boolean; workspaceScoped: boolean } {
  const { config } = input;
  if (!config || !input.collaborationWorkspacesAvailable) {
    return { config, agentsLoading: false, workspaceScoped: false };
  }
  if (input.workspaceAgents) {
    return {
      config: {
        ...config,
        agents: input.workspaceAgents.items,
        defaultAgentName: input.workspaceAgents.defaultAgentName
      },
      agentsLoading: false,
      workspaceScoped: true
    };
  }
  if (input.instanceViewApplies) {
    return { config, agentsLoading: false, workspaceScoped: false };
  }
  return {
    config: { ...config, agents: [], defaultAgentName: undefined },
    agentsLoading: true,
    workspaceScoped: true
  };
}

/**
 * Whether the conversation on screen holds nothing the user would lose: it is the selected one,
 * its thread is loaded and empty, and no run is underway.
 */
export function isAbandonedDraftConversation(input: {
  conversationId: string;
  selectedConversationId: string | undefined;
  messagesLoaded: boolean;
  messageCount: number;
  running: boolean;
}): boolean {
  return (
    input.conversationId === input.selectedConversationId &&
    input.messagesLoaded &&
    input.messageCount === 0 &&
    !input.running
  );
}

/**
 * The agent a new run would use: the user's pick while this workspace offers
 * it, otherwise the workspace default. Derived rather than stored, so switching
 * to a workspace without the picked agent never renders an unavailable one.
 */
export function activeAgentNameFor(
  config: Pick<SafeConfig, "agents" | "defaultAgentName"> | undefined,
  selectedAgentName: string | undefined
): string | undefined {
  const agents = config?.agents ?? [];
  const offered = (name: string | undefined) =>
    name !== undefined && agents.some((agent) => agent.name === name);
  return offered(selectedAgentName)
    ? selectedAgentName
    : offered(config?.defaultAgentName)
      ? config?.defaultAgentName
      : agents[0]?.name;
}

// The code a run is failed with when no worker took it within its queue limit.
const RUN_NOT_STARTED_CODE = "AGENT_RUN_NOT_STARTED";

// The codes a run is failed with when it stood still while it waited for a tool (`@work-shape/catalyst-core`).
const RUN_TOOL_SILENT_CODE = "AGENT_RUN_TOOL_SILENT";

const RUN_COMMAND_NOT_TAKEN_CODE = "AGENT_RUN_COMMAND_NOT_TAKEN";

// The code a run is failed with when its model has no price on the rate card (`@work-shape/catalyst-core`).
const MODEL_NOT_PRICED_CODE = "MODEL_NOT_PRICED";

/**
 * What the person reads above the composer when a run ended as failed or cancelled. The
 * reason of a cancellation and the message of an interruption are written for operators, so
 * the person reads a sentence in their language instead. A model without a price is named
 * with its remedy to someone who sees the usage of the instance; anyone else reads what they
 * can do themselves.
 */
export function terminalRunNotice(
  error: ConversationControllerState["error"],
  t: TranslationContextValue["t"],
  viewer: { seesRateCard: boolean } = { seesRateCard: false }
): string | undefined {
  if (error?.class === "run_cancelled") return t("runStopped");
  if (error?.class !== "run_failed") return undefined;
  if (error.code === MODEL_NOT_PRICED_CODE) {
    return t(viewer.seesRateCard ? "runModelNotPricedOperator" : "runModelNotPriced");
  }
  if (error.category !== "runtime_interrupted") return error.message;
  if (error.code === RUN_NOT_STARTED_CODE) return t("runNotStarted");
  if (error.code === RUN_COMMAND_NOT_TAKEN_CODE) return t("runCommandNotTaken");
  if (error.tool !== undefined && error.code === RUN_TOOL_SILENT_CODE)
    return t("runToolSilent", { tool: error.tool });
  return t("runInterrupted");
}
