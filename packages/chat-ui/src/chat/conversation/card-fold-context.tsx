import { useAuiState } from "@assistant-ui/react";
import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import { foldedCards, NO_FOLDED_CARDS, type CardFoldPart, type FoldedCard } from "./card-fold";

const FoldedCardsContext = createContext<ReadonlyMap<string, FoldedCard>>(NO_FOLDED_CARDS);

/** The same folds as a map with the same entries: the parts below render again only on a change. */
function sameFolds(a: ReadonlyMap<string, FoldedCard>, b: ReadonlyMap<string, FoldedCard>) {
  if (a.size !== b.size) return false;
  for (const [callId, fold] of a) if (b.get(callId) !== fold) return false;
  return true;
}

/**
 * Reads, over every message of the thread, which cards fold to a line (APPCARD-1), so a part
 * of one message knows about a newer save in another. The thread's messages carry the parts of
 * a run as it streams and of a completed run from its projection.
 */
export function FoldedCardsProvider({ children }: { children: ReactNode }) {
  const messages = useAuiState((state) => state.thread.messages);
  const kept = useRef<ReadonlyMap<string, FoldedCard>>(NO_FOLDED_CARDS);
  const folded = useMemo(() => {
    const parts = messages.flatMap((message): readonly CardFoldPart[] =>
      message.role === "assistant" ? message.parts : []
    );
    const next = foldedCards(parts);
    if (!sameFolds(kept.current, next)) kept.current = next;
    return kept.current;
  }, [messages]);
  return <FoldedCardsContext.Provider value={folded}>{children}</FoldedCardsContext.Provider>;
}

/** What the call's card folds to, or nothing where it stays a card. */
export function useFoldedCard(toolCallId: string | undefined): FoldedCard | undefined {
  const folded = useContext(FoldedCardsContext);
  return toolCallId === undefined ? undefined : folded.get(toolCallId);
}

/** Every fold of the thread, for the grouping of a message's parts. */
export function useFoldedCards(): ReadonlyMap<string, FoldedCard> {
  return useContext(FoldedCardsContext);
}
