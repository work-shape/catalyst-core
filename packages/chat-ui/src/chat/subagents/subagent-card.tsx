import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Bot } from "lucide-react";
import type { SubagentSummary } from "@work-shape/catalyst-api-client";
import { Badge, Button, IconTile, Spinner } from "@work-shape/catalyst-ui";
import { useWorkspaceApiClient } from "../../shared/api/workspace-api-client";
import { useWorkspaceThreadQuery } from "../../shared/api/workspace-queries";
import { useTranslation } from "../../shared/i18n";
import { routeCollaborationWorkspaceId } from "../../shared/workspace-route";
import { useWorkspaceRouteState } from "../workspace/workspace-ui-state";
import { WORKSPACE_AUTH_SCOPE } from "../workspace/workspace-chat-state";
import {
  answeredSubagentState,
  isSubagentActive,
  subagentDuration,
  subagentState,
  subagentStateLabel,
  subagentStateTone,
  takeToolCallReveal,
  type SubagentState
} from "./subagent-model";
import { useFollowSubagent, useStopSubagent, useSubagentsQuery } from "./subagent-queries";

const CLOCK_MS = 1000;

/** The time now, read again each second while `ticking`, for a duration that runs. */
function useNow(ticking: boolean): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!ticking) return undefined;
    setNow(new Date());
    const interval = window.setInterval(() => setNow(new Date()), CLOCK_MS);
    return () => window.clearInterval(interval);
  }, [ticking]);
  return now;
}

/**
 * Opens a subagent's thread of the conversation on the screen at its own address. Nothing
 * while the conversation's workspace is not known.
 */
function useOpenSubagentThread(
  rootConversationId: string | undefined
): ((threadId: string) => void) | undefined {
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  const { route, showRoute } = useWorkspaceRouteState();
  const root = useWorkspaceThreadQuery({
    apiBaseUrl,
    authScope: WORKSPACE_AUTH_SCOPE,
    client,
    conversationId: rootConversationId,
    enabled: false
  });
  const collaborationWorkspaceId =
    root.data?.conversation.id === rootConversationId
      ? root.data?.conversation.collaborationWorkspaceId
      : routeCollaborationWorkspaceId(route);
  const open = useCallback(
    (threadId: string) => {
      if (!rootConversationId || !collaborationWorkspaceId) return;
      showRoute({
        kind: "subagent-thread",
        collaborationWorkspaceId,
        conversationId: rootConversationId,
        threadId
      });
    },
    [collaborationWorkspaceId, rootConversationId, showRoute]
  );
  return rootConversationId && collaborationWorkspaceId ? open : undefined;
}

/**
 * The card of a `run_agent` call in the parent's thread: what the subagent does, how it
 * stands and for how long, Open, and Stop while it runs. Its state comes from the child's own
 * stream; its steps and its answer are in its thread.
 */
export function SubagentCard({
  toolCallId,
  description,
  result
}: {
  toolCallId: string;
  /** The call's description, until the subagent it started is known. */
  description: string | undefined;
  /** The call's result: how its subagent ended, once the call has answered. */
  result: unknown;
}) {
  const { selectedConversationId } = useWorkspaceRouteState();
  const query = useSubagentsQuery({ conversationId: selectedConversationId, enabled: true });
  const subagent = query.data?.find((item) => item.toolCallId === toolCallId);
  // The answer of the call says how the subagent ended, even while the list is behind.
  const state: SubagentState =
    answeredSubagentState(result) ??
    (subagent === undefined ? "starting" : subagentState(subagent.status));
  const active = isSubagentActive(state);
  useFollowSubagent({
    rootConversationId: selectedConversationId,
    threadId: subagent?.threadId,
    runId: subagent?.runId,
    active: active && subagent !== undefined
  });

  const cardRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (takeToolCallReveal(toolCallId)) {
      cardRef.current?.scrollIntoView({ block: "center" });
      cardRef.current?.focus({ preventScroll: true });
    }
  }, [toolCallId]);

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      className="chat-tool-part my-3 max-w-3xl outline-none"
      data-testid="subagent-card"
      data-tool-call-id={toolCallId}
    >
      <SubagentLine
        subagent={subagent}
        description={subagent?.description ?? description ?? ""}
        rootConversationId={selectedConversationId}
        state={state}
        framed
      />
    </div>
  );
}

/**
 * One subagent in a line: its description, agent, state and duration, with Open and, while it
 * runs, Stop. The card draws it framed; the Resources panel draws it as a row.
 */
export function SubagentLine({
  subagent,
  description,
  rootConversationId,
  state,
  framed = false,
  openable = true
}: {
  subagent: SubagentSummary | undefined;
  description: string;
  rootConversationId: string | undefined;
  state: SubagentState;
  framed?: boolean;
  /** Offers Open; the head of the thread itself does not. */
  openable?: boolean;
}) {
  const { locale, t } = useTranslation();
  const active = isSubagentActive(state);
  const now = useNow(active && subagent !== undefined);
  const openThread = useOpenSubagentThread(rootConversationId);
  const stop = useStopSubagent(rootConversationId);
  const details = subagent
    ? [
        subagent.agentName,
        subagentDuration(subagent, now, locale, (duration) => t("subagents.soFar", { duration }))
      ].join(" · ")
    : t("subagents.subagent");

  return (
    <div
      className={
        framed
          ? "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border bg-card px-3 py-2.5"
          : "flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-md px-2 py-2"
      }
    >
      <IconTile aria-hidden="true">
        <Bot />
      </IconTile>
      <span className="min-w-0 flex-1 basis-32">
        <span className="block truncate text-label text-foreground" title={description}>
          {description}
        </span>
        <span className="block truncate text-caption text-muted-foreground">{details}</span>
      </span>
      <Badge
        tone={subagentStateTone(state)}
        leading={active ? <Spinner size="sm" /> : undefined}
        dot={!active}
      >
        {t(subagentStateLabel(state))}
      </Badge>
      {subagent ? (
        <span className="flex items-center gap-1.5">
          {state === "running" ? (
            <Button
              size="sm"
              variant="outline"
              aria-label={t("subagents.stopLabel", { description })}
              disabled={stop.isPending}
              onClick={() => stop.mutate({ threadId: subagent.threadId, runId: subagent.runId })}
            >
              {t("subagents.stop")}
            </Button>
          ) : null}
          {openable && openThread ? (
            <Button
              size="sm"
              variant="secondary"
              aria-label={t("subagents.openLabel", { description })}
              onClick={() => openThread(subagent.threadId)}
            >
              {t("subagents.open")}
            </Button>
          ) : null}
        </span>
      ) : null}
      {stop.isError ? (
        <p role="alert" className="basis-full text-caption text-destructive">
          {t("subagents.stopFailed")}
        </p>
      ) : null}
    </div>
  );
}
