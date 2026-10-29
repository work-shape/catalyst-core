import { createContext, useContext, type ReactNode } from "react";
import type { ApiUser } from "@work-shape/catalyst-api-client";

// The chat embedded in a host's page acts with the host's session token. The server reads that
// as the host acting for the person, not the person in their own session, and refuses what is
// the person's alone: their own agents, "Always allow", adding a Data Store by their click,
// their account, personal skills and Connections, the report to the operator. The read of the
// signed-in person says so (`embedded`), and the interface leaves those actions out instead of
// offering what fails when clicked.

/** Whether the caller is an embedding host's session, from the read of the signed-in person. */
export function isEmbeddedSession(user: Pick<ApiUser, "embedded"> | undefined): boolean {
  return user?.embedded === true;
}

const EmbeddedSessionContext = createContext(false);

export function EmbeddedSessionProvider({
  user,
  children
}: {
  user: Pick<ApiUser, "embedded"> | undefined;
  children: ReactNode;
}) {
  return (
    <EmbeddedSessionContext value={isEmbeddedSession(user)}>{children}</EmbeddedSessionContext>
  );
}

/** True below an embedded session; false in the person's own browser session. */
export function useEmbeddedSession(): boolean {
  return useContext(EmbeddedSessionContext);
}
