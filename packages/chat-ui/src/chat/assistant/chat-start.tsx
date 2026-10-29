import { createContext, useContext, type ReactNode } from "react";

/**
 * What a place that starts chats puts on the start page around the one composer, such as a
 * project: the composer stays the start page's own, in its own place. Each part replaces the
 * start page's own; one that is absent leaves it as it is.
 */
export interface ChatStart {
  /** Stands above the composer in place of the welcome message. */
  heading?: ReactNode;
  /** Stands under the composer in place of the starters. */
  below?: ReactNode;
  /** A chip in the composer's frame that says where the new chat goes. */
  composerChip?: ReactNode;
  /** The composer field's accessible name, which names where the new chat goes. */
  composerLabel?: string;
  /** The agents the place may start a chat with, by name; the others are not offered. */
  agentNames?: ReadonlySet<string>;
}

const ChatStartContext = createContext<ChatStart | undefined>(undefined);

export const ChatStartProvider = ChatStartContext.Provider;

/** The parts of the start page the place around it gives, or nothing on the plain start page. */
export function useChatStart(): ChatStart | undefined {
  return useContext(ChatStartContext);
}
