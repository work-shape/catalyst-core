import type { ClientInstanceId, ConversationId } from "./ids";
import type { JsonObject, JsonValue } from "./json";
import type { ISODateString } from "./time";

// One call of a code tool (TOOL-2b, platform-access.md, section 3a): the row the operation
// writes for the command worker, which runs the tool's handler in the sandbox and writes how it
// ended back on the same row. The row holds the agent's input only while the call runs: the
// worker clears it with the outcome, and the operation removes the row once it has read it.
//
// The row is also the request channel of a handler that calls a Connection (TOOL-2c). The
// worker writes the handler's one open request on it; the operation, which waits for the call
// with its caller's identity, carries the request out as the Connection's operation and writes
// the answer beside it; the worker hands the answer back to the handler. A handler makes one
// request at a time, so a row holds at most one, numbered by `seq`. Both are cleared with the
// outcome.

/** How many Connection calls one handler makes at most. A further one is refused. */
export const TOOL_CODE_REQUESTS_MAX = 50;
/** How large one request of a handler is at most, as one line of JSON in UTF-8. */
export const TOOL_CODE_REQUEST_MAX_BYTES = 256 * 1024;
/** How large the answer to one request is at most, as JSON in UTF-8. */
export const TOOL_CODE_REQUEST_ANSWER_MAX_BYTES = 1024 * 1024;

/** One request of a handler: a call of a Connection operation its tool declares. */
export interface ToolCodeCallRequest {
  /** The number of the request within its call, from 1. */
  seq: number;
  connection: string;
  operation: string;
  input: JsonValue;
}

/** What a request is answered, as the handler reads it. */
export type ToolCodeCallRequestAnswer =
  | { ok: true; output: JsonValue; simulated?: true }
  | { ok: false; error: { code: string; message: string } };

/** The answer to the request numbered `seq`. */
export type ToolCodeCallAnswer = ToolCodeCallRequestAnswer & { seq: number };

/** How the handler of one call ended, before the operation has checked its answer. */
export type ToolCodeCallOutcome =
  /** The JSON the handler answered with, at most the bound of an answer. */
  | { kind: "answered"; value: JsonValue }
  | {
      kind: "failed";
      /** A reason code and a plain sentence, with nothing the handler wrote. */
      error: { code: string; message: string };
      /**
       * The end of what the handler wrote to its error stream, for the model alone: the
       * operation hands it on in the tool's answer, which its run does not keep.
       */
      stderrTail?: string;
    };

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
  /** The handler's open request, or its last one. */
  request?: ToolCodeCallRequest;
  /** The answer to a request: to the open one where its `seq` is the request's. */
  answer?: ToolCodeCallAnswer;
  createdAt: ISODateString;
  /** When a worker last started the handler's container. Missing while the call is queued. */
  startedAt?: ISODateString;
  finishedAt?: ISODateString;
}

/**
 * How long a call's row is kept when the operation that wrote it never read it, such as one of
 * a process that stopped. The worker's sweep removes older rows.
 */
export const TOOL_CODE_CALL_KEEP_MS = 60 * 60 * 1000;

export interface ToolCodeCallsStore {
  createToolCodeCall(
    call: Omit<ToolCodeCall, "outcome" | "finishedAt" | "startedAt" | "request" | "answer">
  ): Promise<void>;
  getToolCodeCall(input: {
    clientInstanceId: ClientInstanceId;
    id: string;
  }): Promise<ToolCodeCall | undefined>;
  /**
   * Notes that a worker starts the handler's container now. `false` where the row is gone or
   * already has its outcome, so nobody waits for the call, or where an earlier attempt's
   * handler made a request, which is never made twice: the handler is not started.
   */
  startToolCodeCall(input: {
    clientInstanceId: ClientInstanceId;
    id: string;
    startedAt: ISODateString;
  }): Promise<boolean>;
  /**
   * Writes the handler's next request in place of the last, for the attempt that started at
   * `startedAt`. `false` where the row is gone or has its outcome, so nobody waits for the call
   * any more, or where another attempt started since.
   */
  requestToolCodeCall(input: {
    clientInstanceId: ClientInstanceId;
    id: string;
    request: ToolCodeCallRequest;
    startedAt: ISODateString;
  }): Promise<boolean>;
  /**
   * Writes the answer to the open request, the one of the answer's `seq`. `false` where the row
   * is gone, has its outcome or holds another request.
   */
  answerToolCodeCall(input: {
    clientInstanceId: ClientInstanceId;
    id: string;
    answer: ToolCodeCallAnswer;
  }): Promise<boolean>;
  /**
   * Writes how the handler ended and clears the input, the request and the answer, once.
   * `false` where the row is gone or already has its outcome: the operation gave up on it, and
   * nothing is kept.
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
