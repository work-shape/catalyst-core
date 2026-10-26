import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { GuardrailHits, ShippedGuardrailView } from "@work-shape/catalyst-api-client";
import { useTranslation } from "../../shared/i18n";
import { useSettingsPage, type SettingsPageContextValue } from "../../shared/settings-page-context";
import { instanceSentence, PendingApprovalError } from "./build-refusals";

/** The newest hits of one Guardrail, as its page asked for them. */
export type GuardrailHitsRead =
  | { status: "loading" }
  /** The read failed. The sentence is the instance's own, where it sent one. */
  | { status: "failed"; message: string | undefined; retry(): void }
  | { status: "ready"; hits: GuardrailHits };

/** The guardrails the release ships, as the Guardrails list reads them. */
export type ShippedGuardrailsRead =
  | { status: "loading" }
  | { status: "failed"; message: string | undefined; retry(): void }
  | {
      status: "ready";
      items: readonly ShippedGuardrailView[];
      /** The guardrail whose switch is being sent. */
      switching: string | undefined;
      /** Switches one on or off. Answers the instance's sentence where it refused. */
      switchTo(name: string, enabled: boolean): Promise<string | undefined>;
    };

/**
 * What the Guardrail page reads beyond the asset the frame hands it. The page is handed this
 * and reads nothing else, so a test hands it answers of its own.
 */
export interface GuardrailSource {
  /** A hook: the newest hits of the Guardrail, read when the page opens. */
  useHits(name: string): GuardrailHitsRead;
}

/**
 * The guardrails the release ships on the instance: `guardrails.list_shipped` reads them and
 * `guardrails.switch_shipped` switches one.
 */
export function useShippedGuardrails(
  settings: Pick<SettingsPageContextValue, "apiBaseUrl" | "authScope" | "client">
): ShippedGuardrailsRead {
  const { t } = useTranslation();
  const { apiBaseUrl, authScope, client } = settings;
  const queryClient = useQueryClient();
  const key = ["shipped-guardrails", apiBaseUrl, authScope];
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => client.guardrails.list_shipped({ signal }),
    retry: false
  });
  const change = useMutation({
    mutationFn: async (input: { name: string; enabled: boolean }) => {
      const outcome = await client.guardrails.switch_shipped({
        params: { name: input.name },
        body: { enabled: input.enabled }
      });
      if (outcome.status !== "done") throw new PendingApprovalError();
      return outcome.output;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key })
  });
  if (query.data) {
    return {
      status: "ready",
      items: query.data.items,
      switching: change.isPending ? change.variables.name : undefined,
      switchTo: (name, enabled) =>
        change.mutateAsync({ name, enabled }).then(
          () => undefined,
          (error: unknown) => instanceSentence(error, t) ?? ""
        )
    };
  }
  if (query.error && !query.isFetching) {
    return {
      status: "failed",
      message: instanceSentence(query.error, t),
      retry: () => void query.refetch().catch(() => undefined)
    };
  }
  return { status: "loading" };
}

/** The Guardrail page on the instance: `guardrails.list_hits` answers the hits. */
export function useGuardrailSource(): GuardrailSource {
  const { t } = useTranslation();
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
          message: instanceSentence(query.error, t),
          retry: () => void query.refetch().catch(() => undefined)
        };
      }
      return { status: "loading" };
    }
  };
}
