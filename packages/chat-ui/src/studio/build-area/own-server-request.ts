import { useSyncExternalStore } from "react";
import { forgetWhenSessionEnds } from "../../shared/shell-session";
import type { OwnServerProposal } from "./own-server-model";

// An agent's proposal of a person's own MCP server (PMCP-CHAT), on its one step from the card in
// the conversation to the add screen of Settings > You > Connections. It is kept here, never in
// the address bar, and taken by the page that shows it. A sign-out forgets it.

/** What the add screen starts with, and the conversation it tells once the server is added. */
export interface OwnServerAddRequest {
  title: string;
  url: string;
  /** The catalogue entry an agent named (PMCP-CAT): the add screen starts at its tile. */
  entry?: string;
  from?: { conversationId: string; agentName?: string };
}

/**
 * The request of an agent's proposal from a conversation: the add screen tells that conversation
 * once the server is added, unless others read it, where its tools never run (PMCP-CHAT-2).
 */
export function ownServerAddRequestOf(
  proposal: OwnServerProposal,
  from: OwnServerAddRequest["from"]
): OwnServerAddRequest {
  return {
    title: proposal.title,
    url: proposal.url,
    ...(proposal.entry === undefined ? {} : { entry: proposal.entry }),
    ...(from === undefined || proposal.privateChat === false ? {} : { from })
  };
}

let requested: OwnServerAddRequest | undefined;
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

forgetWhenSessionEnds(() => {
  requested = undefined;
  changed();
});

/** Asks the add screen to open with a proposal. A newer one replaces one not yet shown. */
export function requestOwnServerAdd(request: OwnServerAddRequest): void {
  requested = request;
  changed();
}

/** The page that shows the request takes it: a later visit opens nothing. */
export function takeOwnServerAdd(request: OwnServerAddRequest): void {
  if (requested !== request) return;
  requested = undefined;
  changed();
}

const requestedNow = () => requested;

/** A hook: the proposal waiting for the add screen, until a page takes it. */
export function useRequestedOwnServerAdd(): OwnServerAddRequest | undefined {
  return useSyncExternalStore(subscribe, requestedNow, requestedNow);
}
