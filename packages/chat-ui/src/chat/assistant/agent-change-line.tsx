import { useAuiState } from "@assistant-ui/react";
import { createContext, useContext, type ReactNode } from "react";
import type { Message } from "@work-shape/catalyst-api-client";
import { ListMarker } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";

/** The agent one run of a conversation used, by the message that started the run. */
export interface RunAgent {
  inputMessageId: string;
  agentName: string;
}

/**
 * Where a conversation says that another agent answers from here on (T30): above each message
 * that started a run with another agent than the run before it. The first run has no line; the
 * header says which agent the conversation is held with. Read from the runs, so every reader
 * of the conversation sees the same lines, after a reload too.
 */
export function agentChangeLines(
  messages: ReadonlyArray<Pick<Message, "id">>,
  runAgents: ReadonlyArray<RunAgent>
): ReadonlyMap<string, string> {
  const agentByInput = new Map<string, string>();
  for (const run of runAgents) {
    // A message that started several runs counts with the last of them.
    agentByInput.set(run.inputMessageId, run.agentName);
  }
  const lines = new Map<string, string>();
  let before: string | undefined;
  for (const message of messages) {
    const agentName = agentByInput.get(message.id);
    if (agentName === undefined) continue;
    if (before !== undefined && agentName !== before) {
      lines.set(message.id, agentName);
    }
    before = agentName;
  }
  return lines;
}

const noLines: ReadonlyMap<string, string> = new Map();
const AgentChangeLinesContext = createContext<ReadonlyMap<string, string>>(noLines);

/** Places the agent change lines of the open thread, each named as its reader knows the agent. */
export function AgentChangeLinesProvider({
  lines,
  children
}: {
  /** The agent's label by the message its line stands above. */
  lines: ReadonlyMap<string, string>;
  children: ReactNode;
}) {
  return (
    <AgentChangeLinesContext.Provider value={lines}>{children}</AgentChangeLinesContext.Provider>
  );
}

/** The line above the message it is rendered with, where another agent answers from it on. */
export function MessageAgentChangeLine() {
  const { t } = useTranslation();
  const lines = useContext(AgentChangeLinesContext);
  const messageId = useAuiState((state) => state.message.id);
  const agent = lines.get(messageId);
  return agent === undefined ? null : (
    <ListMarker
      label={t("agentChangeLine", { agent })}
      className="-mb-2"
      data-testid="agent-change-line"
    />
  );
}
