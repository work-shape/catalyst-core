import { notifyManager, type QueryClient } from "@tanstack/react-query";
import { workspaceQueryKeys } from "./api/workspace-query-keys";
import { apiErrorStatus } from "./workspace-utils";

/**
 * The session a shell shows: the cache of what it read for the person signed in, and that
 * person. When the person changes, by a sign-out or by another sign-in in this browser, the
 * shell starts a new session: a new cache, and the whole workspace mounted again, so nothing
 * the person before typed, uploaded or read stays on the screen (ACCEPT-FIX-1 F3).
 */
export interface ShellSession {
  readonly queryClient: QueryClient;
  /** The person signed in, as the cache knows it; absent before a sign-in. */
  readonly personId: string | undefined;
  /** Counts the sessions of this shell. The workspace is mounted again for each. */
  readonly generation: number;
  /** The cache of the session before, still to be cleared before the new workspace mounts. */
  readonly ended?: QueryClient;
}

/**
 * The person signed in, as the cache holds the answer of `/me`. A `/me` refused with 401 (a
 * sign-out in another tab, an expired session) names nobody, though the cache keeps the answer
 * before; any other failure, such as no network or a 5xx, keeps the person.
 */
export function personIdIn(queryClient: QueryClient, apiBaseUrl: string): string | undefined {
  const state = queryClient.getQueryState(workspaceQueryKeys.me(apiBaseUrl));
  if (apiErrorStatus(state?.error) === 401) return undefined;
  const data: unknown = state?.data;
  return typeof data === "object" && data !== null && "id" in data && typeof data.id === "string"
    ? data.id
    : undefined;
}

/**
 * Tells `listener` of a change of the cache the shell reads, as React Query's own hooks are
 * told: after the change, not inside it. React Query creates a query while a component renders,
 * so a listener told at once would update the shell inside that render, which React refuses
 * ("Cannot update a component while rendering a different component").
 */
export function subscribeToShellCache(queryClient: QueryClient, listener: () => void): () => void {
  return queryClient.getQueryCache().subscribe(notifyManager.batchCalls(listener));
}

/**
 * The session for the person the cache now names. A first sign-in keeps the session. Any
 * other change ends it: a new cache from `startCache`, which holds the answer of `/me` for the
 * person after, so the new session knows whom it shows.
 */
export function shellSessionFor(
  session: ShellSession,
  personId: string | undefined,
  apiBaseUrl: string,
  startCache: () => QueryClient
): ShellSession {
  if (personId === session.personId) return session;
  if (session.personId === undefined) {
    return { queryClient: session.queryClient, personId, generation: session.generation };
  }
  const queryClient = startCache();
  if (personId !== undefined) {
    const meKey = workspaceQueryKeys.me(apiBaseUrl);
    queryClient.setQueryData(meKey, session.queryClient.getQueryState(meKey)?.data);
  }
  return {
    queryClient,
    personId,
    generation: session.generation + 1,
    ended: session.queryClient
  };
}

const forgets = new Set<() => void>();
const endedCaches = new WeakSet<QueryClient>();
let ends = 0;

/**
 * Has a store that lives outside React forget what it holds for the person signed in, when
 * the session ends. State inside the workspace needs nothing: it is mounted again.
 */
export function forgetWhenSessionEnds(forget: () => void): void {
  forgets.add(forget);
}

/**
 * A mark of the session now, for work that waits on the server and then writes to a store
 * outside React: it writes only while `sessionStillOn(mark)`, so an answer for the person
 * before never lands in the session of the person after.
 */
export function sessionMark(): number {
  return ends;
}

export function sessionStillOn(mark: number): boolean {
  return mark === ends;
}

/**
 * Ends a session: clears its cache and every store outside React, once per cache. Ending the
 * same cache again does nothing, so it never clears what the session after holds.
 */
export function endShellSession(ended: QueryClient): void {
  if (endedCaches.has(ended)) return;
  endedCaches.add(ended);
  ends += 1;
  ended.clear();
  for (const forget of forgets) forget();
}

/**
 * Whether the shell shows the workspace of `session`. Not while the session before is still
 * to end: the new workspace would start from what the stores still hold of the person before.
 */
export function showsWorkspace(session: ShellSession): boolean {
  return session.ended === undefined;
}

/**
 * Ends the session before `session`, as the shell does before its new workspace mounts, and
 * gives the session to show. A session with nothing to end stays as it is.
 */
export function finishSessionChange(session: ShellSession): ShellSession {
  if (session.ended === undefined) return session;
  endShellSession(session.ended);
  return {
    queryClient: session.queryClient,
    personId: session.personId,
    generation: session.generation
  };
}
