import { ENDED_AGENT_RUN_STATUSES } from "@work-shape/catalyst-core";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useWorkspaceApiClient } from "../../shared/api/workspace-api-client";
import { workspaceQueryKeys } from "../../shared/api/workspace-query-keys";
import {
  savedDraftCalls,
  subjectOpenedInRun,
  type SubjectAsset,
  type SubjectRunPart
} from "./subject-run";
import { useSubjectTitle } from "./subject-title";

/** The run of the open conversation as the thread watches it. */
interface WatchedSubjectRun {
  run: { id: string };
  projection: { status: string; parts: readonly SubjectRunPart[] };
}

/** The asset of the open conversation, as the line over the composer says it. */
export interface ConversationSubjectState {
  subject: SubjectAsset;
  title: string;
}

const FINISHED_RUN_STATES = new Set(ENDED_AGENT_RUN_STATUSES);

/**
 * The asset the open conversation is about: the stored one, or the one the agent opened while
 * the run goes, which makes that asset the subject. Each saved draft drops the reads of the
 * assets, so the asset's page shows what was saved. Answers the asset and the name people read
 * for it.
 */
export function useConversationSubject(input: {
  activeRun: WatchedSubjectRun | undefined;
  storedSubject: SubjectAsset | undefined;
  workspaceId: string | undefined;
}): ConversationSubjectState | undefined {
  const { activeRun, storedSubject, workspaceId } = input;
  const queryClient = useQueryClient();
  const { apiBaseUrl } = useWorkspaceApiClient();
  const watchedRunIds = useRef(new Set<string>());
  const handledSaves = useRef(new Set<string>());

  // Only a run seen while it went tells of a change: the replay of an earlier run says what
  // the stored subject already says.
  const watched =
    activeRun !== undefined &&
    (watchedRunIds.current.has(activeRun.run.id) ||
      !FINISHED_RUN_STATES.has(activeRun.projection.status));
  const parts = watched ? activeRun.projection.parts : undefined;
  const subject = (parts ? subjectOpenedInRun(parts) : undefined)?.subject ?? storedSubject;
  const title = useSubjectTitle(subject, workspaceId);

  useEffect(() => {
    if (activeRun && watched) {
      watchedRunIds.current.add(activeRun.run.id);
    }
  }, [activeRun, watched]);

  useEffect(() => {
    if (!parts) {
      return;
    }
    const saves = savedDraftCalls(parts).filter((id) => !handledSaves.current.has(id));
    if (saves.length === 0) {
      return;
    }
    for (const id of saves) {
      handledSaves.current.add(id);
    }
    // A read that fails again shows on the page that made it.
    queryClient
      .invalidateQueries({ queryKey: workspaceQueryKeys.assets(apiBaseUrl, "standalone") })
      .catch(() => undefined);
  }, [apiBaseUrl, parts, queryClient]);

  return subject === undefined ? undefined : { subject, title };
}
