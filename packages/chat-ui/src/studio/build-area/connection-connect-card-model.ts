import type { ToolConnectionSignInRequest } from "@work-shape/catalyst-core";
import { recordOf, textOf } from "./connection-approval-model";
import { isConnectionProposal, type ConnectionDraft } from "./connection-draft";

// The Connect card in the conversation (CHAT-CONN-2b): one service, "<Service> verbinden", and
// what the viewer can do about it. It stands for an agent's proposal of a catalogue entry or an
// OAuth Connection, and appears by itself in place of a call of a personal Connection that was
// refused because the person has not signed in (CS-9a). Pure: the card holds the sign-in.

/** What the card offers. */
export type ConnectCardState =
  /** Ready: the person connects their own account. */
  | "connect"
  /** The provider refused the person's sign-in: "Neu anmelden". */
  | "reconnect"
  | "connected"
  /** Not set up, and the viewer may set it up: "Einrichten". */
  | "setup"
  /** Not set up, and the viewer may not: ask the administration. */
  | "ask_admin";

export interface ConnectCard {
  /** The Connection to sign in to, by its id, and the service in words. */
  name: string;
  title: string;
  state: ConnectCardState;
  /** Connect signs the person's own account in; a shared Connection is connected for everyone. */
  personal: boolean;
}

/** The person's own sign-in as `connections.mine` answers it. */
export type OwnSignInState = "connected" | "needs_reconnect" | "not_connected";

/**
 * The card of a proposal: one that names a catalogue entry or signs in with OAuth. Any other
 * proposal, and a draft of tools, keeps the card that opens the dialog.
 */
export function connectCardOfProposal(
  draft: ConnectionDraft,
  hostMayWrite: boolean
): ConnectCard | undefined {
  const { authScheme, credentialMode, name, title } = draft.connection;
  const oauth = authScheme === "oauth" || authScheme === "oauth_client";
  if (!isConnectionProposal(draft) || (draft.entry === undefined && !oauth)) return undefined;
  const personal = credentialMode === "user";
  if (draft.state !== "ready") {
    return {
      name,
      title,
      personal,
      state: (draft.mayWrite ?? hostMayWrite) ? "setup" : "ask_admin"
    };
  }
  if (!personal) return { name, title, personal, state: "connected" };
  return {
    name,
    title,
    personal,
    state:
      draft.bindingState === "connected"
        ? "connected"
        : draft.bindingState === "needs_reconnect"
          ? "reconnect"
          : "connect"
  };
}

/**
 * The card a refused call carries in place of its error: the person has no sign-in on the
 * personal Connection, or the provider refused it. Nothing for any other result.
 */
export function connectCardOfRefusal(result: unknown): ConnectCard | undefined {
  const request = readSignInRequest(recordOf(result)?.connect);
  if (!request) return undefined;
  return {
    name: request.connection.name,
    title: request.connection.title,
    personal: true,
    state: request.state === "needs_reconnect" ? "reconnect" : "connect"
  };
}

function readSignInRequest(value: unknown): ToolConnectionSignInRequest | undefined {
  const request = recordOf(value);
  const connection = recordOf(request?.connection);
  const name = textOf(connection?.name);
  if (name === undefined) return undefined;
  if (request?.state !== "not_connected" && request?.state !== "needs_reconnect") return undefined;
  return {
    connection: { name, title: textOf(connection?.title) ?? name },
    state: request.state
  };
}

/**
 * The card as the person's own sign-in stands now, once it is read: a card from earlier in the
 * conversation says Connected after the person connected, and Sign in again where the provider
 * refused the sign-in since. A card that is not about the person's own sign-in stays as it is.
 */
export function withOwnSignIn(card: ConnectCard, own: OwnSignInState | undefined): ConnectCard {
  if (!card.personal || own === undefined) return card;
  if (card.state !== "connect" && card.state !== "reconnect" && card.state !== "connected") {
    return card;
  }
  return {
    ...card,
    state: own === "connected" ? "connected" : own === "needs_reconnect" ? "reconnect" : "connect"
  };
}
