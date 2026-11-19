import type { ClientInstanceId, ConversationId } from "./ids";
import type { JsonObject, JsonValue } from "./json";
import type { ISODateString } from "./time";

// One call of a code tool (TOOL-2b, platform-access.md, section 3a): the row the operation
// writes for the command worker, which runs the tool's handler in the sandbox and writes how it
// ended back on the same row. The row holds the agent's input only while the call runs: the
// worker clears it with the outcome, and the operation removes the row once it has read it.

/** How the handler of one call ended, before the operation has checked its answer. */
export type ToolCodeCallOutcome =
  /** The JSON the handler answered with, at most the bound of an answer. */
  | { kind: "answered"; value: JsonValue }
  | { kind: "failed"; error: { code: string; message: string } };

export interface ToolCodeCall {
  id: string;
  clientInstanceId: ClientInstanceId;
  /** The conversation of the agent that called the tool; the row goes with it. */
  conversationId: ConversationId;
  /** The tool's name and the revision whose files are run. */
  tool: string;
  revisionId: string;
  /** Empty once the call has its outcome. */
  input: JsonObject;
  timeoutSeconds: number;
  outcome?: ToolCodeCallOutcome;
  createdAt: ISODateString;
  finishedAt?: ISODateString;
}

/**
 * How long a call's row is kept when the operation that wrote it never read it, such as one of
 * a process that stopped. The worker's sweep removes older rows.
 */
export const TOOL_CODE_CALL_KEEP_MS = 60 * 60 * 1000;

export interface ToolCodeCallsStore {
  createToolCodeCall(call: Omit<ToolCodeCall, "outcome" | "finishedAt">): Promise<void>;
  getToolCodeCall(input: {
    clientInstanceId: ClientInstanceId;
    id: string;
  }): Promise<ToolCodeCall | undefined>;
  /**
   * Writes how the handler ended and clears the input, once. `false` where the row is gone or
   * already has its outcome: the operation gave up on it, and nothing is kept.
   */
  finishToolCodeCall(input: {
    clientInstanceId: ClientInstanceId;
    id: string;
    outcome: ToolCodeCallOutcome;
    finishedAt: ISODateString;
  }): Promise<boolean>;
  removeToolCodeCall(input: { clientInstanceId: ClientInstanceId; id: string }): Promise<void>;
  /** Removes the rows created before `before`. Answers how many. */
  pruneToolCodeCalls(input: {
    clientInstanceId: ClientInstanceId;
    before: ISODateString;
  }): Promise<number>;
}
