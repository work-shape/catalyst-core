import {
  DECISION_EXPIRED_REASON,
  type DecideWaitingToolCallInput
} from "@work-shape/catalyst-core";
import { ApiError, type AgentRunProjection } from "@work-shape/catalyst-api-client";

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

/**
 * Why an answer was not taken. `already_decided`: the call was decided otherwise first, in
 * another tab, and may have run. `expired`: the server says its time ran out before the
 * answer arrived, so nothing ran. `not_yours`: only the person the run acts for decides, and
 * the server answers anybody else that it knows no such call. `always_allow_refused`: the
 * admin no longer permits "Always allow" for the call (OP-6); nothing was decided.
 */
export type ToolDecisionFailure =
  "failed" | "already_decided" | "expired" | "not_yours" | "always_allow_refused";

/**
 * The failure of an answer the server refused. Only the server's own reason makes a conflict
 * an expiry (EW-2c); without it the call was decided otherwise, and may have run.
 */
export function toolDecisionFailure(error: unknown): ToolDecisionFailure | undefined {
  if (!error) return undefined;
  if (error instanceof ApiError && (error.status === 409 || error.code === "CONFLICT")) {
    return conflictReason(error.payload) === DECISION_EXPIRED_REASON
      ? "expired"
      : "already_decided";
  }
  if (error instanceof ApiError && conflictReason(error.payload) === ALWAYS_ALLOW_REFUSED) {
    return "always_allow_refused";
  }
  // The server answers a call of another person's run as one it does not know.
  if (
    error instanceof ApiError &&
    (error.status === 403 || error.status === 404 || error.code === "FORBIDDEN")
  ) {
    return "not_yours";
  }
  return "failed";
}

/** The server's reason where "Always allow" is not, or no longer, permitted. */
const ALWAYS_ALLOW_REFUSED = "always_allow_not_permitted";

function conflictReason(payload: unknown): unknown {
  const error = isRecord(payload) ? payload.error : undefined;
  const details = isRecord(error) ? error.details : undefined;
  return isRecord(details) ? details.reason : undefined;
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

/** The agent a held save writes, as a person reads it before Allow. */
export interface AgentSaveSummary {
  title: string;
  instructions?: string;
  skills: string[];
  tools: string[];
}

/** The save is held under the API name, or under the tool name a chat agent called it by. */
const ASSET_PUT_OPERATIONS: ReadonlySet<string> = new Set(["assets.put", "platform.assets.put"]);

/**
 * What a held `assets.put` of an agent writes, in words: its name, its instructions, its skills
 * and its tools. The whole definition stays the call's input, under Technical details.
 */
export function agentSaveSummary(
  decision: Pick<ToolDecision, "operationId" | "inputPreview">,
  locale: string
): AgentSaveSummary | undefined {
  const input = decision.inputPreview;
  if (
    !ASSET_PUT_OPERATIONS.has(decision.operationId) ||
    !isRecord(input) ||
    input.kind !== "agent"
  ) {
    return undefined;
  }
  const config = isRecord(input.config) ? input.config : {};
  const texts = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  const instructions =
    typeof config.instructions === "string" && config.instructions.trim() !== ""
      ? config.instructions.trim()
      : undefined;
  return {
    title:
      localizedText(config.displayName, locale) ??
      (typeof input.name === "string" ? input.name : ""),
    ...(instructions === undefined ? {} : { instructions }),
    skills: texts(config.skillNames),
    tools: texts(config.toolNames)
  };
}

/** A name that is one text or one text per language, in the reader's language where it has one. */
function localizedText(value: unknown, locale: string): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!isRecord(value)) return undefined;
  const texts = [value[locale], ...Object.values(value)].filter(
    (text): text is string => typeof text === "string" && text.trim() !== ""
  );
  return texts[0]?.trim();
}

/** The reason a person may give with a decline, as the server takes it. */
export const DECLINE_REASON_MAX_CHARS = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
