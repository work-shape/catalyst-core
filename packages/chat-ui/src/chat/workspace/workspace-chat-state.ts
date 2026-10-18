import {
  type CollaborationWorkspaceAgents,
  type SafeConfig
} from "@work-shape/catalyst-api-client";
import { type ModelUsageRefusal } from "@work-shape/catalyst-core";
import { type TranslationContextValue, type TranslationKey } from "../../shared/i18n";
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

// The code a run is failed with when a usage safeguard or spend budget refused its next model
// call (`@work-shape/catalyst-core`).
const MODEL_USAGE_LIMIT_REACHED_CODE = "MODEL_USAGE_LIMIT_REACHED";

// The words for each part of the limit that refused a run. Its windows are UTC days and months.
const USAGE_LIMIT_PERIODS: Record<ModelUsageRefusal["period"], TranslationKey> = {
  day: "runUsageLimitPeriodDay",
  month: "runUsageLimitPeriodMonth"
};
const USAGE_LIMIT_RESETS: Record<ModelUsageRefusal["period"], TranslationKey> = {
  day: "runUsageLimitResetDay",
  month: "runUsageLimitResetMonth"
};
const USAGE_LIMIT_METRICS: Record<ModelUsageRefusal["metric"], TranslationKey> = {
  modelCallCount: "runUsageLimitMetricModelCallCount",
  tokens: "runUsageLimitMetricTokens",
  costMicros: "runUsageLimitMetricCostMicros"
};
const USAGE_LIMIT_SCOPES: Record<ModelUsageRefusal["scope"], TranslationKey> = {
  user: "runUsageLimitScopeUser",
  system: "runUsageLimitScopeSystem",
  instance: "runUsageLimitScopeInstance"
};

/**
 * The notice of a reached usage limit: which limit and when it resets, where the run names
 * it, and otherwise only that a limit was reached. Never the server's message.
 */
function usageLimitNotice(
  limit: ModelUsageRefusal | undefined,
  t: TranslationContextValue["t"],
  seesRateCard: boolean
): string {
  const advice = t(seesRateCard ? "runUsageLimitAdviceOperator" : "runUsageLimitAdvice");
  if (!limit) return t("runUsageLimitReached", { advice });
  return t("runUsageLimitNamed", {
    period: t(USAGE_LIMIT_PERIODS[limit.period]),
    metric: t(USAGE_LIMIT_METRICS[limit.metric]),
    scope: t(USAGE_LIMIT_SCOPES[limit.scope]),
    reset: t(USAGE_LIMIT_RESETS[limit.period]),
    advice
  });
}

/**
 * What the person reads above the composer when a run ended as failed or cancelled. The
 * reason of a cancellation and the message of any failure but an application's refusal are
 * written for operators, so the person reads a sentence in their language instead. A model
 * without a price and a reached usage limit are named with their remedy to someone who sees the
 * usage of the instance; anyone else reads what they can do themselves. A usage limit is also
 * named by its window, what it counts and whose calls, and when it resets.
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
  if (error.code === MODEL_USAGE_LIMIT_REACHED_CODE) {
    return usageLimitNotice(error.usageLimit, t, viewer.seesRateCard);
  }
  // Only a refusal of the application speaks to the person. An internal, aborted or unknown
  // failure carries the worker's words, such as "Agent run failed": it reads as interrupted.
  // Only a cancellation says stopped.
  if (error.category === "app_error") return error.message;
  if (error.code === RUN_NOT_STARTED_CODE) return t("runNotStarted");
  if (error.code === RUN_COMMAND_NOT_TAKEN_CODE) return t("runCommandNotTaken");
  if (error.tool !== undefined && error.code === RUN_TOOL_SILENT_CODE)
    return t("runToolSilent", { tool: error.tool });
  return t("runInterrupted");
}
