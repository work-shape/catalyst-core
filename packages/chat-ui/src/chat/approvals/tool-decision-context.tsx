import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { AgentRunProjection } from "@work-shape/catalyst-api-client";
import { readToolDecisions, type ToolDecision } from "./tool-decision-model";

const NO_DECISIONS: ReadonlyMap<string, ToolDecision> = new Map();

const ToolDecisionsContext = createContext<ReadonlyMap<string, ToolDecision>>(NO_DECISIONS);

/**
 * Gives the tool calls of the thread the decisions their run waits for. The run's projection
 * holds each from `tool_decision_requested` to `tool_decision_recorded`, and every tab applies
 * the same observations to it, so a decision taken in one tab closes the card in the others.
 */
export function ToolDecisionsProvider({
  parts,
  children
}: {
  /** The parts of the active run's projection. */
  parts: AgentRunProjection["parts"] | undefined;
  children: ReactNode;
}) {
  const decisions = useMemo(() => (parts ? readToolDecisions(parts) : NO_DECISIONS), [parts]);
  return (
    <ToolDecisionsContext.Provider value={decisions}>{children}</ToolDecisionsContext.Provider>
  );
}

/** The decision the run waits for on this tool call. */
export function useToolDecision(toolCallId: string): ToolDecision | undefined {
  return useContext(ToolDecisionsContext).get(toolCallId);
}

/**
 * What the run waits for, where it waits: `confirm` when one of its calls waits for the person
 * in this chat, else `approval` when one waits for somebody else's approval.
 */
export function useRunWaitsFor(): ToolDecision["mode"] | undefined {
  const modes = [...useContext(ToolDecisionsContext).values()].map((decision) => decision.mode);
  return modes.includes("confirm") ? "confirm" : modes[0];
}

/** Whether one of these tool calls waits for a decision. */
export function useWaitsForDecision(toolCallIds: readonly string[]): boolean {
  const decisions = useContext(ToolDecisionsContext);
  return toolCallIds.some((toolCallId) => decisions.has(toolCallId));
}
