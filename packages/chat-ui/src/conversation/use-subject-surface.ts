import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { APP_ASSET_KIND } from "@vivd-catalyst/api-client";
import { WORKFLOW_ASSET_KIND } from "@vivd-catalyst/core";
import { useWorkspaceApiClient } from "../api/workspace-api-client";
import { workspaceQueryKeys } from "../api/workspace-query-keys";
import { useApp } from "../apps/app-data";
import { appTitle } from "../apps/app-model";
import { AGENT_ASSET_KIND } from "../build-area/build-rights";
import { agentConfigToForm } from "../build-area/asset-form-model";
import { useTranslation } from "../i18n";
import { useToolDisplayPanel } from "../tool-display-panel";
import { useWorkflowNames } from "../workflows/workflow-data";
import { agentTitle, useAgentAsset } from "./agent-surface";
import {
  savedDraftCalls,
  subjectOpenedInRun,
  subjectSurface,
  type SubjectAsset,
  type SubjectRunPart
} from "./subject-run";

/** The run of the open conversation as the thread watches it. */
interface WatchedSubjectRun {
  run: { id: string };
  projection: { status: string; parts: readonly SubjectRunPart[] };
}

/** The asset of the open conversation, as the line over the composer says it. */
export interface SubjectSurfaceState {
  subject: SubjectAsset;
  title: string;
  /** Shows the asset beside the conversation. Absent while it is shown, and for a kind without a surface. */
  show?: () => void;
}

const FINISHED_RUN_STATES = new Set(["completed", "failed", "cancelled"]);

/** The name people read for the asset a conversation is about, once its record arrived. */
function useSubjectTitle(subject: SubjectAsset | undefined, workspaceId: string | undefined) {
  const { locale } = useTranslation();
  const kind = subject?.kind;
  const name = subject?.name ?? "";
  const [workflowTitle] = useWorkflowNames(
    kind === WORKFLOW_ASSET_KIND ? workspaceId : undefined,
    kind === WORKFLOW_ASSET_KIND ? [name] : []
  );
  const app = useApp(workspaceId ?? "", name, kind === APP_ASSET_KIND && workspaceId !== undefined);
  const agent = useAgentAsset(name, kind === AGENT_ASSET_KIND);
  if (kind === WORKFLOW_ASSET_KIND) {
    return workflowTitle ?? name;
  }
  if (kind === APP_ASSET_KIND) {
    return appTitle(app.app, name);
  }
  if (kind === AGENT_ASSET_KIND && agent.data) {
    return agentTitle(agentConfigToForm(agent.data.config), locale, name);
  }
  return name;
}

/**
 * Shows the asset a conversation is about beside it: when the conversation opens, and each
 * time its agent opens an asset while the run goes, which makes that asset the subject. A
 * reader who closed it keeps it closed until the agent opens an asset again. Each saved draft
 * drops the reads of the assets, so what is shown is drawn again. Answers the asset the conversation is about now,
 * the name people read for it, and how to show it again where its surface is closed.
 *
 * The parent closes the surface as a layout effect when another conversation is selected, so
 * it closes before this opens the surface of the next one.
 */
export function useSubjectSurface(input: {
  activeRun: WatchedSubjectRun | undefined;
  conversationId: string | undefined;
  storedSubject: SubjectAsset | undefined;
  workspaceId: string | undefined;
  /**
   * The conversation stands in the dock of a page. The asset is not shown beside it there: its
   * page shows it, and the line over the composer links there.
   */
  docked: boolean;
}): SubjectSurfaceState | undefined {
  const { activeRun, conversationId, storedSubject, workspaceId, docked } = input;
  const panel = useToolDisplayPanel();
  const queryClient = useQueryClient();
  const { apiBaseUrl } = useWorkspaceApiClient();
  const watchedRunIds = useRef(new Set<string>());
  const handledSaves = useRef(new Set<string>());
  const opened = useRef<string | undefined>(undefined);
  const handledOpens = useRef(new Set<string>());

  // Only a run seen while it went tells of a change: the replay of an earlier run says what
  // the stored subject already says.
  const watched =
    activeRun !== undefined &&
    (watchedRunIds.current.has(activeRun.run.id) ||
      !FINISHED_RUN_STATES.has(activeRun.projection.status));
  const parts = watched ? activeRun.projection.parts : undefined;
  const openedInRun = parts ? subjectOpenedInRun(parts) : undefined;
  const subject = openedInRun?.subject ?? storedSubject;
  const openCall = openedInRun?.callId;
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
    // A read that fails again shows on the surface that made it.
    queryClient
      .invalidateQueries({ queryKey: workspaceQueryKeys.assets(apiBaseUrl, "standalone") })
      .catch(() => undefined);
  }, [apiBaseUrl, parts, queryClient]);

  useEffect(() => {
    if (conversationId === undefined || subject === undefined || !panel.available || docked) {
      return;
    }
    const surface = subjectSurface({ subject, workspaceId, title });
    if (!surface) {
      return;
    }
    const openedKey = `${conversationId}|${surface.key}`;
    // Each open of the agent shows the asset, also one its reader closed.
    if (openCall !== undefined && !handledOpens.current.has(openCall)) {
      handledOpens.current.add(openCall);
      opened.current = openedKey;
      panel.show(surface);
      return;
    }
    if (opened.current !== openedKey) {
      opened.current = openedKey;
      panel.show(surface);
      return;
    }
    // The name arrived after the surface opened under the asset's id.
    if (panel.open && panel.entry?.key === surface.key && panel.entry.title !== surface.title) {
      panel.show(surface);
    }
  }, [conversationId, docked, openCall, panel, subject, title, workspaceId]);

  if (subject === undefined) {
    return undefined;
  }
  const surface = subjectSurface({ subject, workspaceId, title });
  const shown = panel.open && panel.entry?.key === surface?.key;
  return {
    subject,
    title,
    ...(surface === undefined || shown || !panel.available || docked
      ? {}
      : { show: () => panel.show(surface) })
  };
}
