import { useAuiState } from "@assistant-ui/react";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { Message } from "@work-shape/catalyst-api-client";
import { ListMarker } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import type { TryRuns } from "./agent-try";
import { tryTurnOf, type TryTurn } from "./dock-try";

/**
 * Where a Try conversation says that another revision answers from here on: above each user
 * message whose turn ran another draft revision, or the live agent after a draft, than the turn
 * before it. The first turn has no line; the dock's head says what runs.
 */
export function tryRunLines(
  messages: ReadonlyArray<Pick<Message, "id" | "role" | "metadata">>
): ReadonlyMap<string, TryRuns> {
  const lines = new Map<string, TryRuns>();
  let before: TryTurn | undefined;
  for (const message of messages) {
    if (message.role !== "user") continue;
    const turn = tryTurnOf(message);
    if (turn === undefined) continue;
    if (before !== undefined) {
      if (
        turn.source === "draft" &&
        (before.source !== "draft" || before.revision !== turn.revision)
      ) {
        lines.set(message.id, { source: "draft", revision: turn.revision });
      } else if (turn.source === "live" && before.source === "draft") {
        lines.set(message.id, { source: "live" });
      }
    }
    before = turn;
  }
  return lines;
}

const noLines: ReadonlyMap<string, TryRuns> = new Map();
const TryRunLinesContext = createContext<ReadonlyMap<string, TryRuns>>(noLines);

/** Places the lines of a Try conversation in its thread. */
export function TryRunLinesProvider({
  messages,
  children
}: {
  messages: ReadonlyArray<Pick<Message, "id" | "role" | "metadata">> | undefined;
  children: ReactNode;
}) {
  const lines = useMemo(
    () => (messages === undefined ? noLines : tryRunLines(messages)),
    [messages]
  );
  return <TryRunLinesContext.Provider value={lines}>{children}</TryRunLinesContext.Provider>;
}

/** What a run line says. */
export function TryRunsLine({ runs }: { runs: TryRuns }) {
  const { t } = useTranslation();
  return (
    <ListMarker
      label={
        runs.source === "draft"
          ? t("dock.tryNowDraft", { revision: runs.revision })
          : t("dock.tryNowLive")
      }
      className="-mb-2"
      data-testid="try-run-line"
    />
  );
}

/** The line above the message it is rendered with, where another revision answers from it on. */
export function MessageTryRunLine() {
  const lines = useContext(TryRunLinesContext);
  const messageId = useAuiState((state) => state.message.id);
  const runs = lines.get(messageId);
  return runs === undefined ? null : <TryRunsLine runs={runs} />;
}
