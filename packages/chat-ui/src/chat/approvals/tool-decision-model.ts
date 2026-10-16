import type { DecideWaitingToolCallInput } from "@work-shape/catalyst-core";
import type { AgentRunProjection } from "@work-shape/catalyst-api-client";

type ProjectionDecision = NonNullable<
  Extract<AgentRunProjection["parts"][number], { type: "tool_call" }>["decision"]
>;

/**
 * An agent's call that waits for a decision, as the run's projection holds it from
 * `tool_decision_requested` until `tool_decision_recorded`. `confirm` waits for the person the
 * run acts for; `approval` waits for somebody who holds the approve right.
 */
export interface ToolDecision extends ProjectionDecision {
  toolCallId: string;
}

/** What the person answered: the call runs, or it does not. */
export type ToolDecisionOutcome = DecideWaitingToolCallInput["decision"]["mode"];

/** One row of a call's input: a text as it is written, any other value as indented JSON. */
export interface ToolDecisionInputRow {
  key: string;
  value: string;
  truncated: boolean;
  /** How many characters the whole value has, where it was cut. */
  length?: number;
}

/** The calls of a run that wait for a decision, by tool call. */
export function readToolDecisions(
  parts: AgentRunProjection["parts"]
): ReadonlyMap<string, ToolDecision> {
  const decisions = new Map<string, ToolDecision>();
  for (const part of parts) {
    if (part.type === "tool_call" && part.state === "waiting_for_decision" && part.decision) {
      decisions.set(part.toolCallId, { ...part.decision, toolCallId: part.toolCallId });
    }
  }
  return decisions;
}

/** The longest value a row shows. The call runs with the whole value. */
const ROW_VALUE_MAX_CHARS = 4_000;

/**
 * The rows of a call's input, as the Inbox shows a held call: a field that holds an object is
 * one row for each of its own fields, named `field.inner`, so a long text inside it is a row of
 * its own. An input that is not an object is one row named `input`.
 */
export function toolDecisionInputRows(input: unknown): ToolDecisionInputRow[] {
  if (input === undefined) return [];
  const fields: [string, unknown][] = isRecord(input)
    ? Object.entries(input).flatMap(([key, value]): [string, unknown][] =>
        isRecord(value) && Object.keys(value).length > 0
          ? Object.entries(value).map(([inner, innerValue]): [string, unknown] => [
              `${key}.${inner}`,
              innerValue
            ])
          : [[key, value]]
      )
    : [["input", input]];
  return fields
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      return text.length > ROW_VALUE_MAX_CHARS
        ? { key, value: text.slice(0, ROW_VALUE_MAX_CHARS), truncated: true, length: text.length }
        : { key, value: text, truncated: false };
    });
}

/** The reason a person may give with a decline, as the server takes it. */
export const DECLINE_REASON_MAX_CHARS = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
