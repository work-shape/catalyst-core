import type { ReasoningEffortConfig } from "@vivd-catalyst/core";
import type { ModelProviderContinuation } from "../types";
import type { BedrockEffort, BedrockMessagesRequest, BedrockThinkingBlock } from "./bedrock-wire";

/**
 * The reasoning efforts a call may ask for. `none` sends no thinking setting. `low`, `medium` and
 * `high` ask for adaptive thinking with that effort. `xhigh` and `max` are not declared: Claude
 * Sonnet 4.6 refuses `xhigh`, and `max` thinks without a bound inside an output limit that also
 * has to hold the answer.
 */
export const BEDROCK_REASONING_EFFORTS: readonly ReasoningEffortConfig[] = [
  "none",
  "low",
  "medium",
  "high"
];

const WIRE_EFFORTS: ReadonlySet<string> = new Set<BedrockEffort>(["low", "medium", "high"]);

/**
 * What a request says about thinking. No thinking budget is sent: a fixed budget is refused by
 * the Claude models after the 4.6 generation. The model paces its thinking by the effort, and
 * `max_tokens` is the one hard limit on thinking and answer together, so thinking can never use
 * more than the request's output limit.
 */
export function bedrockThinkingSettings(
  effort: ReasoningEffortConfig | undefined
): Pick<BedrockMessagesRequest, "thinking" | "output_config"> {
  return isWireEffort(effort) ? { thinking: { type: "adaptive" }, output_config: { effort } } : {};
}

function isWireEffort(effort: ReasoningEffortConfig | undefined): effort is BedrockEffort {
  return effort !== undefined && WIRE_EFFORTS.has(effort);
}

/** One block of an assistant turn that thought, in the order the model wrote it. */
export type BedrockTurnBlock =
  | BedrockThinkingBlock
  | { type: "text"; text: string }
  /** A tool call, by the id the product knows it by. The request builds the block again. */
  | { type: "tool_use"; id: string };

/**
 * An assistant turn that thought and then called tools. Bedrock checks the thinking blocks of
 * such a turn when the tool results are sent, so the turn goes back with its blocks unchanged
 * and in their order. The product's history holds the turn's text and calls only; this holds
 * the rest until the run that made the calls has ended.
 */
export interface BedrockThinkingTurn {
  toolCallIds: string[];
  blocks: BedrockTurnBlock[];
}

const CONTINUATION_KIND = "bedrock_messages";

/** The thinking turns an earlier answer of this provider entry handed back. */
export function readBedrockThinkingTurns(
  providerId: string,
  continuation: ModelProviderContinuation | undefined
): BedrockThinkingTurn[] {
  if (
    continuation?.providerId !== providerId ||
    !isRecord(continuation.state) ||
    continuation.state.kind !== CONTINUATION_KIND ||
    !Array.isArray(continuation.state.turns)
  ) {
    return [];
  }
  return continuation.state.turns.flatMap((turn): BedrockThinkingTurn[] => {
    if (!isRecord(turn) || !Array.isArray(turn.blocks) || !Array.isArray(turn.toolCallIds)) {
      return [];
    }
    const blocks = turn.blocks.flatMap((block): BedrockTurnBlock[] => {
      const read = isRecord(block) ? toBedrockTurnBlock(block) : undefined;
      return read ? [read] : [];
    });
    // A turn that lost a block is not the turn Bedrock signed: it is sent without thinking.
    return blocks.length === turn.blocks.length
      ? [{ toolCallIds: turn.toolCallIds.filter((id) => typeof id === "string"), blocks }]
      : [];
  });
}

/** The turn of the given tool calls, when an earlier answer recorded one. */
export function findBedrockThinkingTurn(
  turns: readonly BedrockThinkingTurn[],
  toolCallIds: readonly string[]
): BedrockThinkingTurn | undefined {
  return turns.find(
    (turn) =>
      turn.toolCallIds.length === toolCallIds.length &&
      turn.toolCallIds.every((id, index) => id === toolCallIds[index])
  );
}

/**
 * One block of an answer as a later request sends it back, or undefined for a block that is not
 * sent back: an empty text, a thinking block without its signature, a type this adapter does
 * not know.
 */
export function toBedrockTurnBlock(block: {
  type?: unknown;
  thinking?: unknown;
  signature?: unknown;
  data?: unknown;
  text?: unknown;
  id?: unknown;
}): BedrockTurnBlock | undefined {
  if (block.type === "thinking" && typeof block.signature === "string" && block.signature) {
    return {
      type: "thinking",
      thinking: typeof block.thinking === "string" ? block.thinking : "",
      signature: block.signature
    };
  }
  if (block.type === "redacted_thinking" && typeof block.data === "string" && block.data) {
    return { type: "redacted_thinking", data: block.data };
  }
  if (block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
    return { type: "text", text: block.text };
  }
  if (block.type === "tool_use" && typeof block.id === "string") {
    return { type: "tool_use", id: block.id };
  }
  return undefined;
}

/**
 * What an answer hands back for the next request of its run: the thinking turns the request
 * still used, and the answer's own turn when it thought and called a tool. Undefined when there
 * is none. An answer without a tool call ends its turn, and a finished turn is sent without its
 * thinking.
 */
export function toBedrockContinuation(
  providerId: string,
  kept: readonly BedrockThinkingTurn[],
  answer: readonly BedrockTurnBlock[]
): ModelProviderContinuation | undefined {
  const toolCallIds = answer.flatMap((block) => (block.type === "tool_use" ? [block.id] : []));
  const thought = answer.some(
    (block) => block.type === "thinking" || block.type === "redacted_thinking"
  );
  const turns: BedrockThinkingTurn[] =
    thought && toolCallIds.length > 0 ? [...kept, { toolCallIds, blocks: [...answer] }] : [...kept];
  return turns.length > 0 ? { providerId, state: { kind: CONTINUATION_KIND, turns } } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
