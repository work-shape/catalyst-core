import { ENDED_AGENT_RUN_STATUSES } from "@work-shape/catalyst-core";
import type { Message } from "@work-shape/catalyst-api-client";
import { readCompatibleMessageRunId } from "../assistant/assistant-message-compat";
import { workspaceRoutePath, type WorkspaceRoute } from "../../shared/routes";
import { routeConversationId } from "../../shared/workspace-route";
import {
  assetPageRoute,
  sameAsset,
  type AssetOpen,
  type SubjectAsset,
  type SubjectRunPart
} from "./subject-run";

// When the agent opens an asset, the person is taken to its page only where they are working
// with the agent, never from a page they went to on their own (navigation-and-layout.md, 4.7b).

/** Where the person is, as the rule of an open asks it. */
export interface OpenPlace {
  /** The route of this tab. */
  here: WorkspaceRoute;
  /** The conversation whose run opened the asset. */
  conversationId: string;
  /** The page of the asset the conversation was about before the open. */
  subjectPage: WorkspaceRoute | undefined;
  /** The pages an earlier open of this conversation took this tab to, by their paths. */
  movedTo: ReadonlySet<string>;
  /** The list page whose "New" started this conversation, by its path. */
  startedFrom?: string;
}

/** The same page, whatever the dock holds: two routes with the same path. */
function samePage(a: WorkspaceRoute | undefined, b: WorkspaceRoute | undefined): boolean {
  return a !== undefined && b !== undefined && workspaceRoutePath(a) === workspaceRoutePath(b);
}

/**
 * Whether the person is where an open of the conversation may take them on: its chat route,
 * the page of its subject, a page an earlier open took them to, or the list page whose "New"
 * started it. A page they went to on their own is none of these.
 */
export function placeFollowsOpens(place: OpenPlace): boolean {
  const path = workspaceRoutePath(place.here);
  return (
    routeConversationId(place.here) === place.conversationId ||
    samePage(place.here, place.subjectPage) ||
    place.movedTo.has(path) ||
    place.startedFrom === path
  );
}

/**
 * Whether an open moves this tab: the tab sent the message the run answers and watches the run
 * live, the person is where opens take them on, and the open made the asset the subject. An open
 * that waits for the person moves nothing until they go to it themselves.
 */
function openMoves(input: {
  sentHere: boolean;
  live: boolean;
  awaitsPerson: boolean;
  place: OpenPlace;
}): boolean {
  return input.sentHere && input.live && !input.awaitsPerson && placeFollowsOpens(input.place);
}

/** What the opens of a run do to this tab: the opens it has handled, and where it goes. */
export interface OpenMovePlan {
  /** The opens handled now, by their call ids: each one is weighed once. */
  handled: string[];
  /** The pages this tab goes to, in order. The first move of a run adds a step to the history. */
  /** `owner`: the workspace that owns the asset, by its id; absent for the instance's. */
  moves: { page: WorkspaceRoute; replace: boolean; owner?: string }[];
}

/**
 * Weighs the opens of a run that this tab has not weighed yet. An open moves the tab where
 * `openMoves` says so; the first move of the run adds a step to the history and each later one
 * takes its place, so Back returns to where the person was before the first.
 */
export function planOpenMoves(input: {
  runId: string;
  opens: readonly AssetOpen[];
  /** What the conversation was about before the run, as stored. */
  storedSubject: SubjectAsset | undefined;
  workspaceId: string | undefined;
  handled: ReadonlySet<string>;
  sentHere: boolean;
  live: boolean;
  here: WorkspaceRoute;
  conversationId: string;
  movedTo: ReadonlySet<string>;
  /** The list page whose "New" started this conversation, by its path. */
  startedFrom?: string;
  /** An open of this run moved the tab already. */
  movedInRun: boolean;
}): OpenMovePlan {
  const plan: OpenMovePlan = { handled: [], moves: [] };
  let here = input.here;
  let movedInRun = input.movedInRun;
  const movedTo = new Set(input.movedTo);
  let subjectBefore = input.storedSubject;
  for (const [index, open] of input.opens.entries()) {
    const key = openKey(input.runId, open, index);
    const before = subjectBefore;
    if (!open.awaitsPerson) {
      subjectBefore = open.subject;
    }
    if (input.handled.has(key)) {
      continue;
    }
    plan.handled.push(key);
    const page = assetPageRoute(open.subject, input.workspaceId);
    const moves =
      page !== undefined &&
      openMoves({
        sentHere: input.sentHere,
        live: input.live,
        awaitsPerson: open.awaitsPerson,
        place: {
          here,
          conversationId: input.conversationId,
          subjectPage: before === undefined ? undefined : assetPageRoute(before, input.workspaceId),
          movedTo,
          ...(input.startedFrom === undefined ? {} : { startedFrom: input.startedFrom })
        }
      });
    // A person already on the asset's page stays where they are, without a step in the history.
    if (!moves || samePage(here, page)) {
      continue;
    }
    plan.moves.push({
      page,
      replace: movedInRun,
      ...(open.owner === undefined ? {} : { owner: open.owner })
    });
    movedInRun = true;
    movedTo.add(workspaceRoutePath(page));
    here = page;
  }
  return plan;
}

/** The key an open is weighed under: its call, or its place in the run. */
function openKey(runId: string, open: AssetOpen, index: number): string {
  return open.callId ?? `${runId}:${index}`;
}

/**
 * The open the dock offers to go to, "Opened <name> · Go to it": the last open of the run,
 * while the person is not on its page, and an open that waits for the person until they took
 * the step.
 */
export function pendingOpen(input: {
  opens: readonly AssetOpen[];
  storedSubject: SubjectAsset | undefined;
  workspaceId: string | undefined;
  here: WorkspaceRoute;
}): AssetOpen | undefined {
  const last = input.opens.at(-1);
  const page = last === undefined ? undefined : assetPageRoute(last.subject, input.workspaceId);
  if (last === undefined || page === undefined) {
    return undefined;
  }
  const pending = last.awaitsPerson
    ? !sameAsset(input.storedSubject, last.subject)
    : !samePage(input.here, page);
  return pending ? last : undefined;
}

/** The run of the open conversation as the thread watches it. */
export interface WatchedRun {
  run: { id: string };
  projection: { status: string; parts: readonly SubjectRunPart[] };
}

const ENDED_RUN_STATES = new Set(ENDED_AGENT_RUN_STATUSES);

/**
 * The parts of the last run of the conversation: the run the thread watches, unless a later
 * run ended where this tab did not watch it, in another tab or before a reload. The thread keeps
 * an ended run only as the projection of its message.
 */
export function lastRunParts(input: {
  activeRun: WatchedRun | undefined;
  messages: readonly Pick<Message, "metadata">[];
  completedRunProjections: Readonly<Record<string, { parts: readonly SubjectRunPart[] }>>;
}): readonly SubjectRunPart[] | undefined {
  const { activeRun, messages, completedRunProjections } = input;
  const lastRunId = messages
    .map((message) => readCompatibleMessageRunId(message))
    .findLast((runId) => runId !== undefined);
  if (
    activeRun !== undefined &&
    (lastRunId === undefined ||
      activeRun.run.id === lastRunId ||
      !ENDED_RUN_STATES.has(activeRun.projection.status))
  ) {
    return activeRun.projection.parts;
  }
  return lastRunId === undefined ? undefined : completedRunProjections[lastRunId]?.parts;
}
