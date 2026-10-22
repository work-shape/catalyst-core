import { forgetWhenSessionEnds } from "../../shared/shell-session";

/**
 * The conversation the dock held last, kept in this browser: the page head's "Chat" brings it
 * back after a reload, as it does after a close. Only its id is kept, never what was said.
 */
const DOCK_LAST_STORAGE_KEY = "vivd-catalyst:dock-last";

/** What this tab kept, for a browser that refuses storage. */
let lastInTab: string | undefined;

/** The conversation the dock held last in this browser, or nothing. */
export function readLastDockConversation(): string | undefined {
  if (lastInTab !== undefined) return lastInTab || undefined;
  try {
    return window.localStorage.getItem(DOCK_LAST_STORAGE_KEY) || undefined;
  } catch {
    return undefined;
  }
}

/** Keeps the conversation the dock holds, or forgets it with `undefined`. */
export function storeLastDockConversation(conversationId: string | undefined): void {
  lastInTab = conversationId ?? "";
  try {
    if (conversationId === undefined) {
      window.localStorage.removeItem(DOCK_LAST_STORAGE_KEY);
    } else {
      window.localStorage.setItem(DOCK_LAST_STORAGE_KEY, conversationId);
    }
  } catch {
    // A browser that refuses storage keeps it for this tab alone.
  }
}

// The conversation is the person's: the next person signed in starts without it.
forgetWhenSessionEnds(() => storeLastDockConversation(undefined));
