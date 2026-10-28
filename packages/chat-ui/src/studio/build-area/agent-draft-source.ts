import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type {
  AgentAvailability,
  AgentDraft,
  OperationOutcome,
  SkillDraft
} from "@work-shape/catalyst-api-client";
import { invalidateOfferedAgents } from "../../shared/api/agent-placement-mutations";
import { workspaceQueryKeys } from "../../shared/api/workspace-query-keys";
import type { SharedDraftKind } from "../../shared/build-rights";
import { useTranslation, type TranslationContextValue } from "../../shared/i18n";
import { useSettingsPage } from "../../shared/settings-page-context";
import { apiErrorCode } from "../../shared/workspace-utils";
import { readDraftRefusal, type AgentDraftRefusal } from "./agent-draft-model";
import type { AgentAvailabilityForm } from "./asset-form-model";
import type { DraftDecision } from "./build-data";
import { instanceSentence } from "./build-refusals";

type Translate = TranslationContextValue["t"];

/** What the last Publish or Discard answered, for the page to say. */
export type AgentDraftAnswer =
  { kind: AgentDraftRefusal } | { kind: "waits" } | { kind: "failed"; message: string };

/**
 * Where a publish was asked to offer the agent, and could not: the publish stands. The page
 * starts again after it, so the choice and the instance's sentence are kept for the next page.
 */
export interface UnsetOffer {
  form: AgentAvailabilityForm;
  message: string;
}

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
  /** The reader's translator: a refusal the refusal table knows is told in their language. */
  t: Translate;
}): Promise<AgentDraftAnswer | undefined> {
  let outcome: OperationOutcome<unknown>;
  try {
    outcome = await input.call();
  } catch (error) {
    await input.reread().catch(() => undefined);
    const refusal = readDraftRefusal(error);
    if (refusal !== undefined) return { kind: refusal };
    return { kind: "failed", message: instanceSentence(error, input.t) ?? input.failedMessage };
  }
  if (outcome.status !== "done") return { kind: "waits" };
  await input.done().catch(() => undefined);
  return undefined;
}

/**
 * The one shared draft of an agent, or of a skill the instance or a Shared Workspace owns
 * (SKILL-DRAFT-1), as a page reads it. A skill's names the skill in `agent` and comes with the
 * files of its folder.
 */
export type SharedDraft = AgentDraft & { files?: readonly DraftFile[] };
/** A file of a skill draft's folder, with its content. */
type DraftFile = NonNullable<SkillDraft["files"]>[number];

/** The agent's draft as the page reads it, and what the page does with it. */
export interface AgentDraftSource {
  /** Undefined while the first read is on its way; `null` where the agent has no draft. */
  latest: SharedDraft | null | undefined;
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
  }): SharedDraft;
  /**
   * Publish and Discard of the draft revision the page shows. Each reads the agent again once
   * it is made. A publish may also make what the draft uses available where the agent is: in
   * the workspaces the reader reviewed, `expectedAvailability`, which the instance compares with
   * the agent's availability now and refuses where it changed. `afterPublish` runs once the
   * publish is made and before the agent is read again, such as the save of where it is offered:
   * where that was refused it answers the choice and the sentence, which the next page shows.
   */
  decide(
    kind: DraftDecision,
    revision: number,
    options?: {
      makeDependenciesAvailable: boolean;
      expectedAvailability: AgentAvailability | null;
      afterPublish?: () => Promise<UnsetOffer | undefined>;
    }
  ): Promise<void>;
  /** The offer the last publish could not set, until the page saves or drops it. */
  unsetOffer?: UnsetOffer | undefined;
  /** The page saved or dropped the offer that was not set. */
  settleOffer?(): void;
  /** The decision on its way. */
  busy: DraftDecision | undefined;
  /** What the last decision answered, while it is about the draft on the page. */
  answerFor(revision: number | undefined): AgentDraftAnswer | undefined;
}

/**
 * The one draft of the agent on the page (AD-4), or of the skill a team or the instance owns
 * (SKILL-DRAFT-1). Only a holder of the write right reads it; the page of anybody else shows
 * the live asset. The draft is read again with every read of the assets, which the dock drops
 * whenever its agent saves, so a draft the agent writes shows.
 */
export function useAgentDraft(input: {
  /** The kind whose draft it is. An agent's where it is left out. */
  kind?: SharedDraftKind;
  /** The agent or the skill on the page. Absent for a new one, which has no draft. */
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
  const { kind: assetKind = "agent", agent, workspaceId, enabled, reload } = input;
  const scope = workspaceId === undefined ? {} : { workspaceId };
  const queryKey = (
    assetKind === "skill" ? workspaceQueryKeys.skillDraft : workspaceQueryKeys.agentDraft
  )(apiBaseUrl, authScope, agent ?? "", workspaceId);
  const reads = enabled && agent !== undefined;
  const offerKey = workspaceQueryKeys.agentUnsetOffer(
    apiBaseUrl,
    authScope,
    agent ?? "",
    workspaceId
  );
  const [unsetOffer, setUnsetOffer] = useState(() =>
    queryClient.getQueryData<UnsetOffer>(offerKey)
  );
  const query = useQuery({
    queryKey,
    enabled: reads,
    queryFn: async ({ signal }): Promise<SharedDraft | null> => {
      if (agent === undefined) return null;
      try {
        if (assetKind === "skill") {
          // A skill's draft is read with its folder: the page edits the draft's files.
          const { draft } = await client.skills.draft.get({
            params: { name: agent },
            query: { ...scope, files: "true" },
            signal
          });
          if (draft === null) return null;
          const { skill, ...rest } = draft;
          return { ...rest, agent: skill };
        }
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

  const decide: AgentDraftSource["decide"] = async (kind, revision, options) => {
    if (agent === undefined) return;
    setBusy(kind);
    setAnswered(undefined);
    const next = await decideDraft({
      call: () =>
        kind === "publish"
          ? client.assets.publish({
              params: { kind: assetKind, name: agent },
              body: {
                revision,
                ...scope,
                ...(options?.makeDependenciesAvailable
                  ? {
                      makeDependenciesAvailable: true,
                      expectedAvailability: options.expectedAvailability
                    }
                  : {})
              }
            })
          : (assetKind === "skill" ? client.skills.draft : client.agents.draft).discard({
              params: { name: agent },
              body: { expectedRevision: revision, ...scope }
            }),
      done: async () => {
        if (kind === "publish") {
          const unset = await options?.afterPublish?.();
          if (unset !== undefined) queryClient.setQueryData(offerKey, unset);
        }
        queryClient.setQueryData(queryKey, null);
        // The published draft is the live agent, which the lists of offered agents also show.
        // The page does not wait for them, as a save in Build does not.
        if (kind === "publish" && assetKind !== "skill") {
          invalidateOfferedAgents(queryClient, apiBaseUrl, authScope).catch(() => undefined);
        }
        await reload();
      },
      reread,
      failedMessage: t("agentDraft.failed"),
      t
    });
    setAnswered({ sent: revision, answer: next });
    setBusy(undefined);
  };
  return {
    latest,
    reread,
    saved: ({ revision, config, liveRevision }) => {
      const draft: SharedDraft = {
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
      // A skill's draft is read again for its folder as stored, which a page opened later
      // starts from.
      if (assetKind === "skill") {
        queryClient.invalidateQueries({ queryKey }).catch(() => undefined);
      }
      return draft;
    },
    decide,
    unsetOffer,
    settleOffer: () => {
      queryClient.removeQueries({ queryKey: offerKey });
      setUnsetOffer(undefined);
    },
    busy,
    answerFor: (revision) => answerOfRevision(answered, revision)
  };
}

/**
 * How a page follows the shared draft it holds (AD-4, SKILL-DRAFT-1): a newer draft somebody
 * else wrote is taken over where nothing is typed, and said beside what is typed otherwise; a
 * draft published or discarded elsewhere reads the live asset again. The agent's page and the
 * skill's both follow theirs by it.
 */
export function useDraftFollow(
  draft: AgentDraftSource | undefined,
  input: {
    /** The draft the page holds: the one it started from or last saved. */
    held: SharedDraft | null;
    setHeld(next: SharedDraft): void;
    /** The page holds changes the reader has not saved. */
    dirty: boolean;
    saving: boolean;
    /** Reads the live asset again: the page starts again from it. */
    reload: (() => Promise<unknown>) | undefined;
    /** Starts the form again from a newer draft. */
    take(latest: SharedDraft): void;
    /** Hears the draft revision the page shows, or that it shows none. */
    onRead: ((revision: number | null) => void) | undefined;
  }
) {
  const { held, setHeld, dirty, saving, reload, onRead } = input;
  const take = useRef(input.take);
  take.current = input.take;
  const latest = draft?.latest;
  const latestRevision = latest === undefined ? undefined : (latest?.revision ?? null);
  const differs = latestRevision !== undefined && latestRevision !== (held?.revision ?? null);
  const busy = draft?.busy;
  // Somebody else wrote the draft, or published or discarded it, while the reader types: the
  // page keeps what was typed and says who, and saves nothing over it.
  const behind = draft !== undefined && differs && dirty ? { latest: latest ?? null } : undefined;
  // The live asset is read again once: the page starts again from it.
  const reloading = useRef(false);
  useEffect(() => {
    if (latest === undefined || saving || busy !== undefined) return;
    if (!differs) {
      // The same revision read again names its author as the instance does.
      if (latest !== null && latest !== held) setHeld(latest);
      return;
    }
    if (dirty) return;
    if (latest === null) {
      // Published or discarded elsewhere: the live asset is read again.
      if (!reloading.current) {
        reloading.current = true;
        reload?.().catch(() => undefined);
      }
      return;
    }
    take.current(latest);
    setHeld(latest);
  }, [busy, differs, dirty, held, latest, reload, saving, setHeld]);
  useEffect(() => {
    onRead?.(held?.revision ?? null);
  }, [held, onRead]);
  const answer = draft?.answerFor(held?.revision);
  const stale = held !== null && (held.stale || answer?.kind === "stale");
  return { latest, latestRevision, behind, busy, answer, stale };
}
