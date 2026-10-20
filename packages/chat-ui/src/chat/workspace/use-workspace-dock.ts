import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isConversationGone } from "../conversation/conversation-gone";
import { addressDockConversation, dockMotion, type WorkspaceAddress } from "./dock-state";
import {
  isChatWorkspaceRoute,
  type WorkspaceRoute,
  type WorkspaceRouteChangeOptions
} from "../../shared/workspace-route";

/** What the shell keeps of the dock that the address does not say. */
interface DockMemory {
  /** The conversation of a dock the person closed: the "Chat" button brings it back. */
  closed?: string;
  /** The dock is open without a conversation, as for a link to one the person may not read. */
  emptyOpen: boolean;
  /** Where the dock lies over the page: whether it is in front. */
  inFront: boolean;
}

const FRESH_DOCK: DockMemory = { emptyOpen: false, inFront: true };

/** The chat dock of the shell, as the address and the shell's memory say it. */
export interface WorkspaceDock {
  /** The conversation the dock holds: the address's, or the one of a dock the person closed. */
  conversationId: string | undefined;
  /** The dock is shown beside or over the page. */
  open: boolean;
  /** Where the dock lies over the page: whether it is in front of it. */
  inFront: boolean;
  /**
   * Goes to a page with this conversation in the dock. `replace` takes the place of the current
   * entry of the history, as a later open of the same run does.
   */
  openPage(route: WorkspaceRoute, conversationId: string, options?: { replace?: boolean }): void;
  /** Puts a conversation into the open dock of this page; without one, the dock is empty. */
  show(conversationId: string | undefined, options?: { replace?: boolean }): void;
  /** Hides the dock and keeps its conversation for the "Chat" button. */
  close(): void;
  /** Closes the dock and forgets its conversation, as when that conversation is gone. */
  forget(): void;
  /** Brings back the conversation of the dock the person closed. */
  reopen(): void;
  /** Where the dock lies over the page: puts the page in front, or the dock. */
  showPage(): void;
  showChat(): void;
}

/**
 * The dock's state and the one way every change of route goes: `go` names the dock's
 * conversation at the next address, and the movement the change plays where one conversation
 * goes into or out of the dock. `showRoute` is a move of the person's own and carries the dock
 * along.
 */
export function useWorkspaceDock({
  route,
  chat,
  onRouteChange
}: {
  route: WorkspaceRoute;
  chat: string | undefined;
  onRouteChange(route: WorkspaceRoute, options?: WorkspaceRouteChangeOptions): void;
}): {
  dock: WorkspaceDock;
  showRoute(route: WorkspaceRoute, options?: WorkspaceRouteChangeOptions): void;
} {
  const addressChat = addressDockConversation({ route, chat });
  const onChatRoute = isChatWorkspaceRoute(route);
  const addressRef = useRef<WorkspaceAddress>({ route, chat: addressChat });
  useLayoutEffect(() => {
    addressRef.current = { route, chat: addressChat };
  }, [addressChat, route]);
  const [memory, setMemory] = useState<DockMemory>(FRESH_DOCK);
  // The chat route takes its conversation whole; a dock after it starts afresh. A conversation
  // in the address is the dock's, so nothing closed or empty is kept beside it.
  if (onChatRoute && memory !== FRESH_DOCK) {
    setMemory(FRESH_DOCK);
  } else if (addressChat !== undefined && (memory.closed !== undefined || memory.emptyOpen)) {
    setMemory({ ...memory, closed: undefined, emptyOpen: false });
  }

  const go = useCallback(
    (target: WorkspaceRoute, nextChat: string | undefined, options?: { replace?: boolean }) => {
      const to: WorkspaceAddress = { route: target, chat: nextChat };
      const toChat = addressDockConversation(to);
      const motion = dockMotion(addressRef.current, to);
      onRouteChange(target, {
        ...(options?.replace ? { replace: true } : {}),
        ...(toChat === undefined ? {} : { chat: toChat }),
        ...(motion === undefined ? {} : { motion })
      });
    },
    [onRouteChange]
  );

  const showRoute = useCallback(
    (target: WorkspaceRoute, options?: WorkspaceRouteChangeOptions) => {
      // A page the person goes to is the page they want to see, also where the dock lies over it.
      setMemory((current) => (current.inFront ? { ...current, inFront: false } : current));
      go(target, options?.chat ?? addressRef.current.chat, options);
    },
    [go]
  );

  const openPage = useCallback(
    (target: WorkspaceRoute, conversationId: string, options?: { replace?: boolean }) => {
      setMemory((current) => (current.inFront ? current : { ...current, inFront: true }));
      go(target, conversationId, options);
    },
    [go]
  );

  const show = useCallback(
    (conversationId: string | undefined, options?: { replace?: boolean }) => {
      if (conversationId === undefined) {
        setMemory((current) => ({ ...current, emptyOpen: true, inFront: true }));
      }
      go(addressRef.current.route, conversationId, options);
    },
    [go]
  );

  const close = useCallback(() => {
    const closed = addressRef.current.chat;
    setMemory((current) => ({ ...current, closed: closed ?? current.closed, emptyOpen: false }));
    go(addressRef.current.route, undefined, { replace: true });
  }, [go]);

  const forget = useCallback(() => {
    setMemory((current) => ({ ...current, closed: undefined, emptyOpen: false }));
    go(addressRef.current.route, undefined, { replace: true });
  }, [go]);

  const closedConversation = memory.closed;
  const reopen = useCallback(() => {
    setMemory((current) => ({ ...current, inFront: true }));
    if (closedConversation !== undefined) {
      go(addressRef.current.route, closedConversation, { replace: true });
    }
  }, [closedConversation, go]);

  const showPage = useCallback(() => {
    setMemory((current) => ({ ...current, inFront: false }));
  }, []);
  const showChat = useCallback(() => {
    setMemory((current) => ({ ...current, inFront: true }));
  }, []);

  const dock = useMemo<WorkspaceDock>(
    () => ({
      conversationId: addressChat ?? memory.closed,
      open: addressChat !== undefined || memory.emptyOpen,
      inFront: memory.inFront,
      openPage,
      show,
      close,
      forget,
      reopen,
      showPage,
      showChat
    }),
    [addressChat, close, forget, memory, openPage, reopen, show, showChat, showPage]
  );

  return { dock, showRoute };
}

/**
 * A dock whose conversation the person may not read, as from a link someone shared, opens
 * empty instead, without an error: the page shows as it does for anyone. Text typed while the
 * thread loaded stays in the composer of the empty dock.
 */
export function useUnreadableDockConversation({
  dock,
  docked,
  error,
  keepDraft
}: {
  dock: WorkspaceDock;
  /** The conversation on the screen is the dock's. */
  docked: boolean;
  /** How the thread of that conversation failed to load, if it did. */
  error: unknown;
  /** Moves the draft of the unreadable conversation to the new conversation. */
  keepDraft: (conversationId: string) => void;
}) {
  const unreadableId =
    docked && dock.open && isConversationGone(error) ? dock.conversationId : undefined;
  const { show } = dock;
  useEffect(() => {
    if (unreadableId !== undefined) {
      keepDraft(unreadableId);
      show(undefined, { replace: true });
    }
  }, [keepDraft, show, unreadableId]);
}
