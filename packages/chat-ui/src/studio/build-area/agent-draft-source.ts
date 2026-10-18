import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { AgentDraft, OperationOutcome } from "@work-shape/catalyst-api-client";
import { invalidateOfferedAgents } from "../../shared/api/agent-placement-mutations";
import { workspaceQueryKeys } from "../../shared/api/workspace-query-keys";
import { useTranslation } from "../../shared/i18n";
import { useSettingsPage } from "../../shared/settings-page-context";
import { apiErrorCode } from "../../shared/workspace-utils";
import { readDraftRefusal, type AgentDraftRefusal } from "./agent-draft-model";
import type { DraftDecision } from "./build-data";
import { instanceSentence } from "./build-refusals";

/** What the last Publish or Discard answered, for the page to say. */
export type AgentDraftAnswer =
  { kind: AgentDraftRefusal } | { kind: "waits" } | { kind: "failed"; message: string };

/** An answer and the draft revision the decision was sent for. */
interface AnsweredRevision {
  sent: number;
  answer: AgentDraftAnswer | undefined;
}

/**
 * The answer that still holds for the draft on the page. "Changed" is about a newer revision
 * than the one sent, which the page reads after it; every other answer is about the revision
 * sent, so a newer draft written meanwhile is shown as it is.
 */
export function answerOfRevision(
  answered: AnsweredRevision | undefined,
  revision: number | undefined
): AgentDraftAnswer | undefined {
  if (answered === undefined) return undefined;
  if (answered.answer?.kind === "changed") {
    return revision === undefined || revision > answered.sent ? answered.answer : undefined;
  }
  return answered.sent === revision ? answered.answer : undefined;
}

/**
 * Makes one decision on the draft and says how it went. A decision that was made reads the page
 * again; a refusal reads the draft again, so the page shows what holds now: a newer draft, a
 * stale one or none.
 */
export async function decideDraft(input: {
  call(): Promise<OperationOutcome<unknown>>;
  /** Reads the agent again after the decision: the page starts again from what holds. */
  done(): Promise<unknown>;
  /** Reads the draft again. */
  reread(): Promise<unknown>;
  failedMessage: string;
}): Promise<AgentDraftAnswer | undefined> {
  let outcome: OperationOutcome<unknown>;
  try {
    outcome = await input.call();
  } catch (error) {
    await input.reread().catch(() => undefined);
    const refusal = readDraftRefusal(error);
    if (refusal !== undefined) return { kind: refusal };
    return { kind: "failed", message: instanceSentence(error) ?? input.failedMessage };
  }
  if (outcome.status !== "done") return { kind: "waits" };
  await input.done().catch(() => undefined);
  return undefined;
}

/** The agent's draft as the page reads it, and what the page does with it. */
export interface AgentDraftSource {
  /** Undefined while the first read is on its way; `null` where the agent has no draft. */
  latest: AgentDraft | null | undefined;
  /** Reads the draft again, as after a refused save. */
  reread(): Promise<unknown>;
  /**
   * The page's own save wrote this draft revision of the config, on the live revision the page
   * loaded: the page holds it without reading it again, written by the reader just now.
   */
  saved(input: {
    revision: number;
    config: Record<string, unknown>;
    liveRevision: number;
  }): AgentDraft;
  /**
   * Publish and Discard of the draft revision the page shows. Each reads the agent again once
   * it is made.
   */
  decide(kind: DraftDecision, revision: number): Promise<void>;
  /** The decision on its way. */
  busy: DraftDecision | undefined;
  /** What the last decision answered, while it is about the draft on the page. */
  answerFor(revision: number | undefined): AgentDraftAnswer | undefined;
}

/**
 * The one draft of the agent on the page (AD-4). Only a holder of the agent's write right reads
 * it; the page of anybody else shows the live agent. The draft is read again with every read of
 * the assets, which the dock drops whenever its agent saves, so a draft the agent writes shows.
 */
export function useAgentDraft(input: {
  /** The agent on the page. Absent for a new one, which has no draft. */
  agent: string | undefined;
  /** The workspace that owns the agent, by its id. Absent for the instance's own. */
  workspaceId?: string;
  /** The reader may change the agent: only then is the draft read. */
  enabled: boolean;
  /** Reads the agent again after a Publish or a Discard. */
  reload(): Promise<unknown>;
}): AgentDraftSource {
  const { apiBaseUrl, authScope, client, user } = useSettingsPage();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<DraftDecision>();
  const [answered, setAnswered] = useState<AnsweredRevision>();
  const { agent, workspaceId, enabled, reload } = input;
  const scope = workspaceId === undefined ? {} : { workspaceId };
  const queryKey = workspaceQueryKeys.agentDraft(apiBaseUrl, authScope, agent ?? "", workspaceId);
  const reads = enabled && agent !== undefined;
  const query = useQuery({
    queryKey,
    enabled: reads,
    queryFn: async ({ signal }): Promise<AgentDraft | null> => {
      if (agent === undefined) return null;
      try {
        const { draft } = await client.agents.draft.get({
          params: { name: agent },
          query: scope,
          signal
        });
        return draft;
      } catch (error) {
        // The instance tells the draft to a holder of the write right alone.
        if (apiErrorCode(error) === "NOT_FOUND") return null;
        throw error;
      }
    },
    retry: false
  });
  // A draft that cannot be read is no draft here: a save over one is refused and read again.
  const latest = !reads ? null : query.isPending ? undefined : (query.data ?? null);
  const reread = () => queryClient.invalidateQueries({ queryKey });

  const decide = async (kind: DraftDecision, revision: number) => {
    if (agent === undefined) return;
    setBusy(kind);
    setAnswered(undefined);
    const next = await decideDraft({
      call: () =>
        kind === "publish"
          ? client.assets.publish({
              params: { kind: "agent", name: agent },
              body: { revision, ...scope }
            })
          : client.agents.draft.discard({
              params: { name: agent },
              body: { expectedRevision: revision, ...scope }
            }),
      done: async () => {
        queryClient.setQueryData(queryKey, null);
        // The published draft is the live agent, which the lists of offered agents also show.
        // The page does not wait for them, as a save in Build does not.
        if (kind === "publish") {
          invalidateOfferedAgents(queryClient, apiBaseUrl, authScope).catch(() => undefined);
        }
        await reload();
      },
      reread,
      failedMessage: t("agentDraft.failed")
    });
    setAnswered({ sent: revision, answer: next });
    setBusy(undefined);
  };
  return {
    latest,
    reread,
    saved: ({ revision, config, liveRevision }) => {
      const draft: AgentDraft = {
        agent: agent ?? "",
        revision,
        baseRevision: liveRevision,
        liveRevision,
        stale: false,
        config,
        author: { userId: user.id, name: user.displayLabel, release: false },
        updatedAt: new Date().toISOString()
      };
      queryClient.setQueryData(queryKey, draft);
      return draft;
    },
    decide,
    busy,
    answerFor: (revision) => answerOfRevision(answered, revision)
  };
}
