import {
  ApiError,
  type ApiClient,
  type AppActionPermission,
  type AppBridgeHostMessage,
  type AppBridgePageMessage,
  type AppWorkflowRun
} from "@vivd-catalyst/api-client";

// The calls a frame asks the interface to make. The frame holds no credential and can reach
// nothing but the interface, so each call is made here, with the session of the person who
// looks at the frame. The instance is told which frame asks by the page session of the
// address the frame was loaded from, and checks that this address was given to this person.

/** The address a frame is shown from, as `pages.preview` or `apps.preview` answered it. */
export interface FrameAddress {
  url: string;
  fileSetId: string;
  pageSessionId: string;
}

/** What names the frame to the instance, read from its address. */
export interface FrameSessionProof {
  pageSessionId: string;
  fileSetId: string;
  token: string;
}

/**
 * The proof of a frame's address: the address ends `<file set>/<token>/`. An address of
 * another shape has none, and its frame makes no call.
 */
export function frameSessionProof(address: FrameAddress): FrameSessionProof | undefined {
  const segments = address.url.split(/[?#]/u, 1)[0]?.split("/").filter(Boolean) ?? [];
  const at = segments.lastIndexOf(address.fileSetId);
  const token = at < 0 ? undefined : segments[at + 1];
  return token === undefined
    ? undefined
    : { pageSessionId: address.pageSessionId, fileSetId: address.fileSetId, token };
}

type CallMessage = Extract<AppBridgePageMessage, { type: "action" | "connection_call" }>;
/**
 * One call as the instance is asked for it: what a frame's message says of it, without what
 * only the bridge reads. The test of an action in the draft view makes the same call.
 */
type FrameCall =
  | Pick<Extract<CallMessage, { type: "action" }>, "type" | "name" | "input" | "idempotencyKey">
  | Pick<
      Extract<CallMessage, { type: "connection_call" }>,
      "type" | "connection" | "operation" | "input" | "idempotencyKey"
    >;
type CallAnswer = Extract<AppBridgeHostMessage, { type: "action_result" }>;

/** How one call of a frame came out, as the frame is told. */
export type FrameCallAnswer =
  | { ok: true; result: NonNullable<CallAnswer["result"]> }
  | { ok: false; error: NonNullable<CallAnswer["error"]> };

/** How one read of a Workflow Run came out, as the frame is told. */
export type FrameWorkflowRunAnswer =
  { ok: true; run: AppWorkflowRun } | { ok: false; error: NonNullable<CallAnswer["error"]> };

/** What the bridge of a frame calls the instance through. */
export interface FrameCalls {
  /** What each action would come to for the viewer, or nothing where it could not be read. */
  can(): Promise<Record<string, AppActionPermission> | undefined>;
  run(call: FrameCall): Promise<FrameCallAnswer>;
  /** Reads a Workflow Run that a `workflow` action of the frame started. */
  workflowRun(runId: string): Promise<FrameWorkflowRunAnswer>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The sentences the interface words itself for a frame, in the language of the person who
 * looks at it. An App shows them as they are, so no App words a refusal of the platform.
 */
export interface FrameCallTexts {
  /**
   * The person lacks the right to use a Connection. With its label where they may read it,
   * and whether the frame is a Page of a conversation or an App, which the sentence names.
   */
  connectionUseDenied(connectionLabel: string | undefined, frame: "page" | "app"): string;
}

/** The refusals the same call again cannot change. A frame offers no retry for them. */
const FINAL_REFUSALS: readonly string[] = [
  "forbidden",
  "action_unknown",
  "connection_not_declared",
  "draft_safe_mode",
  // A Page of a conversation reaches no Data Store; only an App does.
  "data_store_needs_app",
  "input_invalid"
];

/**
 * What a frame reads of a call that was refused or failed: a fixed word, a sentence, for a
 * missing right the right, and the run where one was recorded. A refusal for a right says
 * `forbidden`. Every other error says the reason the instance gave, or its error code in
 * lower case. The sentence is the instance's, but for the missing right to use a Connection,
 * which the interface words in the person's language.
 */
export function frameCallFailure(
  error: unknown,
  texts?: FrameCallTexts
): NonNullable<CallAnswer["error"]> {
  if (!(error instanceof ApiError)) {
    return { code: "failed", message: "The call could not be made." };
  }
  const envelope = isRecord(error.payload) ? error.payload.error : undefined;
  const details = isRecord(envelope) && isRecord(envelope.details) ? envelope.details : {};
  const run = typeof details.operationRunId === "string" ? { runId: details.operationRunId } : {};
  if (error.code === "FORBIDDEN" && typeof details.action === "string") {
    const label = typeof details.connectionLabel === "string" ? details.connectionLabel : undefined;
    return {
      code: "forbidden",
      message:
        texts && details.connectionUseDenied === true
          ? texts.connectionUseDenied(label, details.frame === "page" ? "page" : "app")
          : error.message,
      right: details.action,
      retryable: false,
      ...run
    };
  }
  const reason = typeof details.reason === "string" ? details.reason : undefined;
  const code = reason ?? error.code?.toLowerCase() ?? "failed";
  return {
    code,
    message: error.message,
    ...(FINAL_REFUSALS.includes(code) ? { retryable: false } : {}),
    ...run
  };
}

/** What the calls of a frame use of the API client: the calls of a page session. */
export interface FrameCallClient {
  apps: Pick<ApiClient["apps"], "sessions">;
}

/** The calls of the frame at `address`, made with the session of `client`. */
export function createFrameCalls(
  client: FrameCallClient,
  address: FrameAddress,
  texts?: FrameCallTexts
): FrameCalls | undefined {
  const proof = frameSessionProof(address);
  if (!proof) {
    return undefined;
  }
  const { pageSessionId, fileSetId, token } = proof;
  return {
    can: () =>
      client.apps.sessions.context({ params: { pageSessionId }, body: { fileSetId, token } }).then(
        (answer) => answer.can,
        () => undefined
      ),
    async run(call) {
      // A frame that names no key gets one per message: one message is one call.
      const key = call.idempotencyKey === undefined ? {} : { idempotencyKey: call.idempotencyKey };
      try {
        const result =
          call.type === "action"
            ? await client.apps.sessions.call_action({
                params: { pageSessionId, name: call.name },
                body: { fileSetId, token, input: call.input },
                ...key
              })
            : await client.apps.sessions.call_connection({
                params: {
                  pageSessionId,
                  connection: call.connection,
                  operation: call.operation
                },
                body: { fileSetId, token, input: call.input },
                ...key
              });
        return {
          ok: true,
          result:
            result.status === "dry_run"
              ? { status: result.status, message: result.message, result: result.result }
              : {
                  runId: result.runId,
                  status: result.status,
                  ...("result" in result ? { result: result.result } : {})
                }
        };
      } catch (error) {
        return { ok: false, error: frameCallFailure(error, texts) };
      }
    },
    async workflowRun(runId) {
      try {
        const run = await client.apps.sessions.get_workflow_run({
          params: { pageSessionId, runId },
          body: { fileSetId, token }
        });
        return { ok: true, run };
      } catch (error) {
        return { ok: false, error: frameCallFailure(error, texts) };
      }
    }
  };
}
