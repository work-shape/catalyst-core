import type { ApiClient } from "@work-shape/catalyst-api-client";
import { createContext, useContext, type ReactNode } from "react";
import type { ConnectionDraft, ConnectionDraftOpening } from "./connection-draft";

// What the conversation's cards of an agent's Connection draft or proposal, and its Connect
// card, read and do through the workspace on screen.

/** A Connection the draft's id already names. */
export interface ExistingConnection {
  connectorType: string;
  /** Its own name in words. */
  title: string;
}

/** Reads a draft's target for this API and identity; only writers can open its approval. */
export interface ConnectionDraftHost {
  apiBaseUrl: string;
  authScope: string;
  /** The person's own sign-in of the Connect card (CHAT-CONN-2b) runs with it. */
  client: ApiClient;
  /**
   * The viewer started the conversation on screen. Only they see the Connect card a refused
   * call carries: a sign-in is the person's own.
   */
  ownsConversation: boolean;
  /**
   * Sends `text` as the person's message to the conversation on screen, queued behind a run that
   * goes (CHAT-CONN-1): the Connect card's word that the service is connected.
   */
  tell?(text: string, agentName?: string): Promise<void>;
  open?(draft: ConnectionDraft): Promise<ConnectionDraftOpening>;
  /**
   * The Connection of an id as the instance holds it, or nothing where there is none: the card
   * names an existing Connection by its own title, never by the agent's.
   */
  connectionOf(name: string): Promise<ExistingConnection | undefined>;
}

const ConnectionDraftHostContext = createContext<ConnectionDraftHost | undefined>(undefined);

/** The workspace's host of the cards of drafts and proposals, where there is one. */
export function useConnectionDraftHost(): ConnectionDraftHost | undefined {
  return useContext(ConnectionDraftHostContext);
}

export function ConnectionDraftHostProvider({
  value,
  children
}: {
  value: ConnectionDraftHost | undefined;
  children: ReactNode;
}) {
  return (
    <ConnectionDraftHostContext.Provider value={value}>
      {children}
    </ConnectionDraftHostContext.Provider>
  );
}
