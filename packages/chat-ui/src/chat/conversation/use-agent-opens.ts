import type { ApiClient, Message } from "@work-shape/catalyst-api-client";
import { ENDED_AGENT_RUN_STATUSES } from "@work-shape/catalyst-core";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { buildRouteOfLocation } from "../../shared/build-route";
import { showOwnerInStudio } from "../../shared/build-rights";
import { CONNECTIONS_BUILD_PATH } from "../../studio/build-area/connection-tools";
import { connectCardOfProposal } from "../../studio/build-area/connection-connect-card-model";
import { workspaceRoutePath, type WorkspaceRoute } from "../../shared/routes";
import type { WorkspaceDock } from "../workspace/use-workspace-dock";
import {
  CONNECTION_PROPOSE_TOOL_NAME,
  readConnectionProposal,
  type ConnectionDraft
} from "../../studio/build-area/connection-draft";
import {
  lastRunParts,
  pendingOpen,
  placeFollowsOpens,
  planOpenMoves,
  type WatchedRun
} from "./open-move";
import {
  assetPageRoute,
  opensInRun,
  sameAsset,
  type AssetOpen,
  type SubjectAsset,
  type SubjectRunPart
} from "./subject-run";

const FINISHED_RUN_STATES = new Set<string>(ENDED_AGENT_RUN_STATUSES);

/** What the opens of the agent offer the conversation. */
export interface AgentOpens {
  /**
   * The last open of the run that did not take the person to the asset: the dock says
   * "Opened <name> · Go to it". Absent once the person is on its page and it is the subject.
   */
  pending: AssetOpen | undefined;
  /**
   * Takes the person to the page of an asset the agent opened. An open that waits for the
   * person makes it the subject first: the person's step is the confirmation.
   */
  goTo(open: AssetOpen): Promise<void>;
  /** The page of an asset the agent opened, for the link of its line. */
  pageOf(open: AssetOpen): WorkspaceRoute | undefined;
  /**
   * Takes the person to a page a link in the conversation names, the conversation docked
   * beside it and the page in front. The page reads with the person's rights, as any visit does.
   */
  goToPage(page: WorkspaceRoute): void;
  /** Notes a run this tab started: only such a run takes the person anywhere. */
  sent(runId: string): void;
  /**
   * Notes the list page whose "New" started a conversation: an open of it takes the person on
   * from there, as from its chat route.
   */
  startedFrom(conversationId: string, path: string): void;
}

/**
 * The navigation rule of the agent's opens (navigation-and-layout.md, 4.7b). It lives with the
 * workspace, not with the thread: the thread's pane is drawn anew for each conversation, and the
 * runs this tab sent and the pages it was taken to outlast that.
 *
 * An open moves this tab only where `openMoves` says so. The first move of a run adds a step to
 * the history and later ones take its place, so Back returns to where the person was. Every
 * other open leaves the offer to go to it.
 */
export function useAgentOpens(input: {
  activeRun: WatchedRun | undefined;
  /** The messages of the thread and the projections of its ended runs, for the last run. */
  messages: readonly Message[];
  completedRunProjections: Readonly<Record<string, { parts: readonly SubjectRunPart[] }>>;
  conversationId: string | undefined;
  storedSubject: SubjectAsset | undefined;
  workspaceId: string | undefined;
  route: WorkspaceRoute;
  dock: WorkspaceDock;
  client: ApiClient;
  /** The conversation is about another asset now: its thread is read again. */
  onSubjectChanged(conversationId: string): void;
  onError(message: string): void;
  /**
   * Opens the New connection dialog a proposal of the agent fills, the conversation docked
   * beside it (CHAT-CONN-1), where the person may create Connections. Called under the rule of
   * an open: once per proposal, for a run this tab sent and watches, where opens take the person.
   */
  openProposal?(
    proposal: ConnectionDraft,
    from: { conversationId: string; agentName?: string }
  ): void;
}): AgentOpens {
  const {
    activeRun,
    messages,
    completedRunProjections,
    conversationId,
    storedSubject,
    workspaceId,
    route,
    dock,
    client,
    onSubjectChanged,
    onError,
    openProposal
  } = input;
  const sentRuns = useRef(new Set<string>());
  // The runs seen going while their conversation was on the screen. A run seen only after it
  // ended is replayed: it moves nothing.
  const liveRuns = useRef(new Set<string>());
  const handledOpens = useRef(new Set<string>());
  const movedRuns = useRef(new Set<string>());
  const movedTo = useRef(new Map<string, Set<string>>());
  const startedFromPages = useRef(new Map<string, string>());
  const routeRef = useRef(route);
  useLayoutEffect(() => {
    routeRef.current = route;
  }, [route]);

  // A conversation left behind is no longer watched: its run is read later when it comes back.
  const shownConversation = useRef(conversationId);
  useEffect(() => {
    if (shownConversation.current !== undefined && shownConversation.current !== conversationId) {
      liveRuns.current.clear();
    }
    shownConversation.current = conversationId;
  }, [conversationId]);

  const sent = useCallback((runId: string) => {
    sentRuns.current.add(runId);
    liveRuns.current.add(runId);
  }, []);

  const startedFrom = useCallback((startedConversation: string, path: string) => {
    startedFromPages.current.set(startedConversation, path);
  }, []);

  const pageOf = useCallback(
    (open: AssetOpen) => assetPageRoute(open.subject, workspaceId),
    [workspaceId]
  );

  const runId = activeRun?.run.id;
  const runAgent = activeRun?.run.agentName;
  const status = activeRun?.projection.status;
  const parts = activeRun?.projection.parts;
  const { openPage } = dock;
  useEffect(() => {
    if (runId === undefined || status === undefined || parts === undefined) {
      return;
    }
    if (conversationId === undefined) {
      return;
    }
    if (!FINISHED_RUN_STATES.has(status)) {
      liveRuns.current.add(runId);
    }
    const conversationMoves = movedTo.current.get(conversationId) ?? new Set<string>();
    const newFrom = startedFromPages.current.get(conversationId);
    const plan = planOpenMoves({
      runId,
      opens: opensInRun(parts),
      storedSubject,
      workspaceId,
      handled: handledOpens.current,
      sentHere: sentRuns.current.has(runId),
      live: liveRuns.current.has(runId),
      here: routeRef.current,
      conversationId,
      movedTo: conversationMoves,
      ...(newFrom === undefined ? {} : { startedFrom: newFrom }),
      movedInRun: movedRuns.current.has(runId)
    });
    for (const key of plan.handled) {
      handledOpens.current.add(key);
    }
    for (const move of plan.moves) {
      showOwnerOf(move.page, move.owner);
      openPage(move.page, conversationId, { replace: move.replace });
      movedRuns.current.add(runId);
      conversationMoves.add(workspaceRoutePath(move.page));
      movedTo.current.set(conversationId, conversationMoves);
      routeRef.current = move.page;
    }
    if (openProposal === undefined) return;
    // The agent's proposal of a new Connection opens its dialog under the same rule.
    const subjectPage =
      storedSubject === undefined ? undefined : assetPageRoute(storedSubject, workspaceId);
    for (const [index, part] of parts.entries()) {
      const proposal =
        part.toolName === CONNECTION_PROPOSE_TOOL_NAME && part.state === "output_available"
          ? readConnectionProposal(part.output)
          : undefined;
      if (proposal === undefined || signsInFromCard(proposal)) continue;
      const key = `proposal:${part.toolCallId ?? `${runId}:${index}`}`;
      if (handledOpens.current.has(key)) continue;
      handledOpens.current.add(key);
      const follows =
        sentRuns.current.has(runId) &&
        liveRuns.current.has(runId) &&
        placeFollowsOpens({
          here: routeRef.current,
          conversationId,
          subjectPage,
          movedTo: conversationMoves,
          ...(newFrom === undefined ? {} : { startedFrom: newFrom })
        });
      if (!follows) continue;
      openProposal(proposal, {
        conversationId,
        ...(runAgent === undefined ? {} : { agentName: runAgent })
      });
      // A later open of the run takes the person on from the Connections.
      conversationMoves.add(
        workspaceRoutePath(buildRouteOfLocation({ kindPath: CONNECTIONS_BUILD_PATH }))
      );
      movedTo.current.set(conversationId, conversationMoves);
    }
  }, [
    conversationId,
    openPage,
    openProposal,
    parts,
    runAgent,
    runId,
    status,
    storedSubject,
    workspaceId
  ]);

  const goTo = useCallback(
    async (open: AssetOpen) => {
      const target = assetPageRoute(open.subject, workspaceId);
      if (target === undefined || conversationId === undefined) {
        return;
      }
      if (open.awaitsPerson && !sameAsset(storedSubject, open.subject)) {
        try {
          const outcome = await client.conversations.subject.open({
            params: { conversationId },
            body: {
              kind: open.subject.kind,
              name: open.subject.name,
              ...(open.callId === undefined ? {} : { toolCallId: open.callId })
            }
          });
          if (outcome.status !== "done") {
            return;
          }
        } catch (error) {
          onError(error instanceof Error ? error.message : String(error));
          return;
        }
        onSubjectChanged(conversationId);
      }
      showOwnerOf(target, open.owner);
      openPage(target, conversationId);
    },
    [client, conversationId, onError, onSubjectChanged, openPage, storedSubject, workspaceId]
  );

  const { showPage } = dock;
  const goToPage = useCallback(
    (page: WorkspaceRoute) => {
      if (conversationId === undefined) return;
      openPage(page, conversationId);
      // The person asked for the page: where the dock lies over it, the page is in front.
      showPage();
    },
    [conversationId, openPage, showPage]
  );

  // The offer stands for the last run, also one this tab only reads: in a second tab, after a
  // reload, or once the thread was read again after the run.
  const lastParts = lastRunParts({ activeRun, messages, completedRunProjections });
  const pending =
    lastParts === undefined
      ? undefined
      : pendingOpen({ opens: opensInRun(lastParts), storedSubject, workspaceId, here: route });

  return { pending, goTo, pageOf, goToPage, sent, startedFrom };
}

/**
 * A page of Studio reads its asset in Studio's scope: going to one the agent opened sets the
 * scope to the asset's owner first, so the page finds it where it is.
 */
function showOwnerOf(page: WorkspaceRoute, owner: string | undefined): void {
  if (page.kind === "build-asset") showOwnerInStudio(owner);
}

/**
 * A proposal of a Connection that is set up already: its card's Connect signs the person in,
 * in the click, and no dialog opens (CHAT-CONN-2b).
 */
function signsInFromCard(proposal: ConnectionDraft): boolean {
  const card = connectCardOfProposal(proposal, true);
  return card !== undefined && card.state !== "setup" && card.state !== "ask_admin";
}
