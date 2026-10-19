import type { AgentPreview } from "@work-shape/catalyst-core";
import type { Message, StartConversationRunResponse } from "@work-shape/catalyst-api-client";

/**
 * The Try tab of the dock on an agent's page (section 4.7c): the person's own Try conversation
 * with the agent under construction, beside the Build conversation the address names.
 */
export interface DockTry {
  /** The address of the page Try was opened on: Try stays on that page. */
  page: string;
  /** The agent under construction, by its name. */
  agent: string;
  /** Undefined while the instance opens the conversation, or after it was deleted. */
  conversationId: string | undefined;
}

/** Which of the dock's two conversations is shown on an agent's page. */
export type DockTab = "build" | "try";

/** Try belongs to the agent's page it was opened on: on any other page the dock is Build. */
export function tryOnPage(trying: DockTry | undefined, page: string): DockTry | undefined {
  return trying !== undefined && trying.page === page ? trying : undefined;
}

/** What answered one turn of a Try conversation, as its user message records it. */
export type TryTurn = Pick<AgentPreview, "revision" | "source">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The revision a user message of a Try conversation records: `agentRuntime.preview`. */
export function tryTurnOf(message: Pick<Message, "metadata">): TryTurn | undefined {
  const runtime: unknown = message.metadata?.agentRuntime;
  if (!isRecord(runtime)) return undefined;
  const preview = runtime.preview;
  if (!isRecord(preview)) return undefined;
  const { revision, source } = preview;
  if (typeof revision !== "number" || (source !== "draft" && source !== "live")) return undefined;
  return { revision, source };
}

/**
 * The run the instance accepted is a Try turn, as its own user message records it. What the
 * dock shows by the time the answer arrives does not decide it: the person may have gone back
 * to Build, to another page, or the page may have been loaded again meanwhile.
 */
export function isTryRun(response: { userMessage: Pick<Message, "metadata"> }): boolean {
  return tryTurnOf(response.userMessage) !== undefined;
}

/**
 * What the shell does with a run the instance accepted. Its thread is kept for the
 * conversation in every case. A Try run is hidden from Recent and every list (section 4.7c): it
 * is not put into the rail, no title is awaited for it, and its conversation never goes into
 * the address.
 */
export function acceptStartedRun(
  response: StartConversationRunResponse,
  effects: {
    /** Keeps the run's thread; `listed` also puts the conversation into the rail. */
    cache(listed: boolean): void;
    /** Shows the conversation the run created, in the dock or on its chat route. */
    show(): void;
    /** Reads the rail again and awaits the conversation's title. */
    list(): void;
  }
): void {
  const tried = isTryRun(response);
  effects.cache(!tried);
  if (tried) return;
  effects.show();
  effects.list();
}

/**
 * The instance deletes every Try conversation of the agent when its draft is published or
 * discarded: the draft the page read was there and is gone now. A draft that was never read,
 * or none from the start, deleted nothing.
 */
export function tryConversationGone(
  draftBefore: number | null | undefined,
  draftNow: number | null | undefined
): boolean {
  return typeof draftBefore === "number" && draftNow === null;
}

/**
 * Whether the open thread is a Try conversation, which no list shows (section 4.7c). The dock
 * holds the conversation the instance opened as Try, and every turn of one records the revision
 * that answered it: either says so, whichever tab or address shows the thread now.
 */
function isTryThread(
  thread: { conversation: { id: string }; messages: ReadonlyArray<Pick<Message, "metadata">> },
  dock: { tab: DockTab; conversationId: string | undefined }
): boolean {
  return (
    (dock.tab === "try" && dock.conversationId === thread.conversation.id) ||
    thread.messages.some((message) => tryTurnOf(message) !== undefined)
  );
}

/**
 * The thread the rail may show as the open conversation's row: the one on screen, unless it is
 * Try's.
 */
export function listedOpenThread<
  Thread extends {
    conversation: { id: string };
    messages: ReadonlyArray<Pick<Message, "metadata">>;
  }
>(
  thread: Thread | undefined,
  selectedConversationId: string | undefined,
  dock: { tab: DockTab; conversationId: string | undefined }
): Thread | undefined {
  return thread !== undefined &&
    thread.conversation.id === selectedConversationId &&
    !isTryThread(thread, dock)
    ? thread
    : undefined;
}
