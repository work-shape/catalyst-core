import { useQuery } from "@tanstack/react-query";
import type { GuardrailHits } from "@vivd-catalyst/api-client";
import { useSettingsPage } from "../settings/settings-page-context";
import { instanceSentence } from "./build-refusals";

/** The newest hits of one Guardrail, as its page asked for them. */
export type GuardrailHitsRead =
  | { status: "loading" }
  /** The read failed. The sentence is the instance's own, where it sent one. */
  | { status: "failed"; message: string | undefined; retry(): void }
  | { status: "ready"; hits: GuardrailHits };

/**
 * What the Guardrail page reads beyond the asset the frame hands it. The page is handed this
 * and reads nothing else, so a test hands it answers of its own.
 */
export interface GuardrailSource {
  /** A hook: the newest hits of the Guardrail, read when the page opens. */
  useHits(name: string): GuardrailHitsRead;
}

/** The Guardrail page on the instance: `guardrails.list_hits` answers the hits. */
export function useGuardrailSource(): GuardrailSource {
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  return {
    useHits(name) {
      const query = useQuery({
        queryKey: ["guardrail-hits", apiBaseUrl, authScope, name],
        queryFn: ({ signal }) => client.guardrails.list_hits({ params: { name }, signal }),
        retry: false
      });
      if (query.data) {
        return { status: "ready", hits: query.data };
      }
      if (query.error && !query.isFetching) {
        return {
          status: "failed",
          message: instanceSentence(query.error),
          retry: () => void query.refetch().catch(() => undefined)
        };
      }
      return { status: "loading" };
    }
  };
}
