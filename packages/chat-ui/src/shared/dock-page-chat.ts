import { createContext, useContext, useEffect, useLayoutEffect, useRef } from "react";

/**
 * What the page on screen asks of the chat: the page of an asset starts a conversation about
 * that asset, the page of a new asset one that builds it. The page head's "Chat" and the dock's
 * "New chat" call it; a page without one gets the dock's last conversation or an empty one.
 */
export interface DockPageChat {
  /**
   * Starts the page's conversation in the dock. `fresh` asks for a new conversation even where
   * the dock's conversation is already about the asset. A refusal is the page's to say. It
   * resolves `false` where the page started its conversation already and has none to find
   * again: "Chat" then brings back the dock's last one.
   */
  start(options: { fresh: boolean }): Promise<boolean | void>;
}

type OfferDockPageChat = (chat: DockPageChat | undefined) => void;

const DockPageChatContext = createContext<OfferDockPageChat | undefined>(undefined);

/** The shell hears here what the page on screen offers. */
export const DockPageChatProvider = DockPageChatContext.Provider;

/**
 * Offers the page's conversation to the shell while the page stands; nothing while `start` is
 * absent, such as for a reader who may not change the asset.
 */
export function useOfferDockPageChat(
  start: ((options: { fresh: boolean }) => Promise<boolean | void>) | undefined
): void {
  const offer = useContext(DockPageChatContext);
  const latest = useRef(start);
  useLayoutEffect(() => {
    latest.current = start;
  });
  const offered = start !== undefined;
  useEffect(() => {
    if (offer === undefined || !offered) return;
    offer({ start: (options) => latest.current?.(options) ?? Promise.resolve() });
    return () => offer(undefined);
  }, [offer, offered]);
}

/**
 * Where the page on screen builds: the owner Studio is set to. A conversation that builds is
 * started there, and the empty dock names it. Missing outside Studio: the open workspace.
 */
export type DockCreationScope =
  | { owner: "workspace"; workspaceId: string; workspaceName: string }
  | { owner: "instance"; mayCreate: boolean };

type OfferDockCreationScope = (scope: DockCreationScope | undefined) => void;

const DockCreationScopeContext = createContext<OfferDockCreationScope | undefined>(undefined);

/** The shell hears here where the page on screen builds. */
export const DockCreationScopeProvider = DockCreationScopeContext.Provider;

/** Tells the shell where the page builds while it stands; nothing once it goes. */
export function useOfferDockCreationScope(scope: DockCreationScope | undefined): void {
  const offer = useContext(DockCreationScopeContext);
  const key = scope === undefined ? "" : JSON.stringify(scope);
  const latest = useRef(scope);
  useLayoutEffect(() => {
    latest.current = scope;
  });
  useEffect(() => {
    if (offer === undefined || key === "") return;
    offer(latest.current);
    return () => offer(undefined);
  }, [offer, key]);
}
