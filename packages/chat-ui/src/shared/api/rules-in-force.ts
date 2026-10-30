import { useMutation, useQuery } from "@tanstack/react-query";
import {
  completedOutput,
  type ApiClient,
  type RulesInForceView
} from "@work-shape/catalyst-api-client";

// The rules in force for the signed-in person (GR-3): one read feeds the Rules in force page and
// every guardrail answer, which looks its rule up there for who can change it.

interface RulesInForceInput {
  apiBaseUrl: string;
  /** Absent outside a workspace's client: nothing is read then. */
  client: { guardrails: Pick<ApiClient["guardrails"], "in_force"> } | undefined;
  enabled?: boolean;
}

/** How long a read stays fresh: the answers on a page of cards share one read. */
const RULES_STALE_MS = 60_000;

function rulesInForceKey(apiBaseUrl: string) {
  return ["rules-in-force", apiBaseUrl] as const;
}

/** `guardrails.in_force`: the rules that apply to the person, with who can change each. */
export function useRulesInForceQuery(input: RulesInForceInput) {
  return useQuery<RulesInForceView>({
    queryKey: rulesInForceKey(input.apiBaseUrl),
    queryFn: ({ signal }) => {
      if (!input.client) throw new Error("No API client");
      return input.client.guardrails.in_force({ signal });
    },
    enabled: input.client !== undefined && (input.enabled ?? true),
    staleTime: RULES_STALE_MS,
    retry: false
  });
}

/** `guardrails.ask`: sends the person's question to the Inbox of who can change the rule. */
export function useAskAboutRule(client: { guardrails: Pick<ApiClient["guardrails"], "ask"> }) {
  return useMutation({
    mutationFn: async (input: { name: string; text: string }) => {
      const outcome = await client.guardrails.ask({
        params: { name: input.name },
        body: { text: input.text }
      });
      return completedOutput(outcome);
    }
  });
}
