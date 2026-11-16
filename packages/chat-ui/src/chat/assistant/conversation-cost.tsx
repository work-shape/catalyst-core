import { useQuery } from "@tanstack/react-query";
import type { ConversationCost } from "@work-shape/catalyst-api-client";
import { useWorkspaceApiClient } from "../../shared/api/workspace-api-client";
import { workspaceQueryKeys } from "../../shared/api/workspace-query-keys";
import { retryUnlessRefused } from "../../shared/api/workspace-queries";
import { useTranslation, type TranslationContextValue } from "../../shared/i18n";
import { WORKSPACE_AUTH_SCOPE } from "../workspace/workspace-chat-state";

/**
 * The line "Cost so far" of the context indicator (LU-7). It mounts with the open hover card and
 * asks then, so each opening shows what the calls that ended since cost. It shows nothing
 * until the instance answers, and nothing where it refuses or no rate card prices the calls.
 */
export function ConversationCostLine({ conversationId }: { conversationId: string }) {
  const i18n = useTranslation();
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  const query = useQuery({
    queryKey: workspaceQueryKeys.conversationCost(apiBaseUrl, WORKSPACE_AUTH_SCOPE, conversationId),
    queryFn: () => client.conversations.cost.get({ params: { conversationId } }),
    retry: retryUnlessRefused
  });
  const text = query.data ? conversationCostText(query.data, i18n) : undefined;
  if (!text) return null;
  return (
    <div className="mt-1 border-t pt-1 text-muted-foreground" data-testid="conversation-cost">
      {text}
    </div>
  );
}

/** The sentence of the line, or nothing where no currency prices the calls. */
function conversationCostText(
  cost: ConversationCost,
  { t, locale }: Pick<TranslationContextValue, "t" | "locale">
): string | undefined {
  if (cost.currency === undefined) return undefined;
  const amount = formatConversationCost(cost.costMicros, cost.currency, locale);
  // In a chat others read too, the person's own calls are their share of it.
  if (cost.scope === "own" && cost.shared) {
    return t(cost.complete ? "conversationOwnCostSoFar" : "conversationOwnCostAtLeast", { amount });
  }
  return t(cost.complete ? "conversationCostSoFar" : "conversationCostAtLeast", { amount });
}

/** Cents, and two more digits below one cent, where a short chat would read as zero. */
function formatConversationCost(micros: number, currency: string, locale: string): string {
  const amount = micros / 1_000_000;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: amount > 0 && amount < 0.01 ? 4 : 2
  }).format(amount);
}
