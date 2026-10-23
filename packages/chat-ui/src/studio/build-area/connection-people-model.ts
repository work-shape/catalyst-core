import type { ConnectionPeople, PersonalConnections } from "@work-shape/catalyst-api-client";
import type { SignInRead } from "./connection-sign-in-model";

// Personal connections (CS-9a-UI), without React: how a person's own sign-in reads, what the
// person and an administrator may do with it, and whether a Connection is personal at all. The
// instance decides every call; these only choose what is offered.

/** A personal sign-in as the instance answers it, the caller's own or one person's. */
type PersonalSignIn =
  PersonalConnections["connections"][number] | ConnectionPeople["people"][number];

/** How a sign-in reads: a revoked one is as good as none, and is connected again the same way. */
export type PersonalView = "connected" | "needs_reconnect" | "not_connected";

export function personalViewOf(signIn: Pick<PersonalSignIn, "state">): PersonalView {
  return signIn.state === "connected" || signIn.state === "needs_reconnect"
    ? signIn.state
    : "not_connected";
}

/** What a person is offered on their own row under You > Connections. */
export interface OwnActions {
  /** Connect, or sign in again where the provider refused the sign-in. */
  connect?: "connect" | "reconnect";
  disconnect: boolean;
}

export function ownActions(signIn: Pick<PersonalSignIn, "state">): OwnActions {
  switch (personalViewOf(signIn)) {
    case "connected":
      return { disconnect: true };
    case "needs_reconnect":
      return { connect: "reconnect", disconnect: true };
    case "not_connected":
      return { connect: "connect", disconnect: false };
  }
}

/**
 * Whether an administrator is offered Revoke on a person's row: only a holder of
 * `connection.write`, and only while there is a sign-in to end.
 */
export function mayRevoke(signIn: Pick<PersonalSignIn, "state">, mayWrite: boolean): boolean {
  return mayWrite && personalViewOf(signIn) !== "not_connected";
}

/** Whether a Connection's definition has each person connect their own account. */
export function isPersonalConfig(config: Record<string, unknown>): boolean {
  return config.credentialMode === "user";
}

/** Whether a Connection's page shows who connected: a personal one, to who may change it. */
export function showsPeople(config: Record<string, unknown>, mayWrite: boolean): boolean {
  return mayWrite && isPersonalConfig(config);
}

/**
 * The caller's own sign-in on one Connection, as a sign-in step waits on it. Nothing where the
 * caller has none, or may not use the Connection.
 */
export function ownSignInOf(answer: PersonalConnections, name: string): SignInRead {
  const own = answer.connections.find((connection) => connection.name === name);
  return own === undefined || own.state === "not_connected"
    ? {}
    : {
        binding: {
          state: own.state,
          ...(own.connectedAt === undefined ? {} : { connectedAt: own.connectedAt })
        }
      };
}
