import {
  ApiError,
  completedOutput,
  type ApiClient,
  type AppActionPermission,
  type AppBridgeHostMessage,
  type AppBridgePageMessage,
  type AppWorkflowRun
} from "@work-shape/catalyst-api-client";
import { MODEL_USAGE_LIMIT_REACHED_CODE } from "@work-shape/catalyst-core";

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
interface FrameSessionProof {
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

/**
 * One call as the instance is asked for it: what a frame's message says of it, without what
 * only the bridge reads. The test of an action in the draft view makes the same call.
 */
type FrameCall = Pick<
  Extract<AppBridgePageMessage, { type: "action" }>,
  "type" | "name" | "input" | "idempotencyKey"
>;
type CallAnswer = Extract<AppBridgeHostMessage, { type: "action_result" }>;

/** How one call of a frame came out, as the frame is told. */
export type FrameCallAnswer =
  | { ok: true; result: NonNullable<CallAnswer["result"]> }
  | { ok: false; error: NonNullable<CallAnswer["error"]> };

/** How one read of a Workflow Run came out, as the frame is told. */
export type FrameWorkflowRunAnswer =
  { ok: true; run: AppWorkflowRun } | { ok: false; error: NonNullable<CallAnswer["error"]> };

/** A test run a call of an App's draft started (DP-1), as its last read answered it. */
export type FrameTestRun = AppWorkflowRun & { mode: "test" };

/** What the bridge of a frame calls the instance through. */
export interface FrameCalls {
  /** What each action would come to for the viewer, or nothing where it could not be read. */
  can(): Promise<Record<string, AppActionPermission> | undefined>;
  writeStorage(
    mutation: Extract<AppBridgePageMessage, { type: "storage_write" }>["mutation"]
  ): Promise<void>;
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
  /**
   * The interface's own sentence for a refusal it knows by its reason and details, or nothing
   * where it has none: the instance's sentence then stays.
   */
  refusal(details: Record<string, unknown>): string | undefined;
}

/**
 * The code a frame reads for a call that needed a model while a usage limit held. The instance
 * gives it the reason `MODEL_USAGE_LIMIT_REACHED`; the frame reads it as a state, like the
 * `limit_reached` of a Workflow run, and the sentence says which limit and when it resets.
 */
const LIMIT_REACHED = "limit_reached";

/** The refusals the same call again cannot change. A frame offers no retry for them. */
const FINAL_REFUSALS: readonly string[] = [
  "forbidden",
  // Until the limit resets or an admin raises it, the same call is refused the same way.
  LIMIT_REACHED,
  "action_unknown",
  "draft_safe_mode",
  // A Page of a conversation reaches no Data Store; only an App does.
  "data_store_needs_app",
  "input_invalid"
];

/**
 * What a frame reads of a call that was refused or failed: a fixed word, a sentence, for a
 * missing right the right, and the run where one was recorded. A refusal for a right says
 * `forbidden`. Every other error says the reason the instance gave, or its error code in
 * lower case. The sentence is the instance's, but for the missing right to use a Connection
 * and a refusal the interface's table knows, which it words in the person's language.
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
          : (texts?.refusal(details) ?? error.message),
      right: details.action,
      retryable: false,
      ...run
    };
  }
  const reason = typeof details.reason === "string" ? details.reason : undefined;
  const code =
    reason === MODEL_USAGE_LIMIT_REACHED_CODE
      ? LIMIT_REACHED
      : (reason ?? error.code?.toLowerCase() ?? "failed");
  return {
    code,
    // The code stays the instance's; only the sentence is told in the viewer's language.
    message: texts?.refusal(details) ?? error.message,
    ...(FINAL_REFUSALS.includes(code) ? { retryable: false } : {}),
    ...run
  };
}

/**
 * The refusals that say the frame is a preview of a conversation and no App: only an App's
 * manifest binds a Data Store. The surface tells the person where to test with real data.
 */
const PREVIEW_IS_NO_APP_REFUSALS: readonly string[] = ["data_store_needs_app"];

/** What the surface of a frame hears of its calls, beside what the frame is answered. */
export interface FrameCallHooks {
  /** A call was refused because the preview is no App (PREVIEW-1). */
  onPreviewIsNoApp?(): void;
}

/** What the calls of a frame use of the API client: the calls of a page session. */
export interface FrameCallClient {
  apps: {
    sessions: Pick<
      ApiClient["apps"]["sessions"],
      "call_action" | "context" | "get_workflow_run" | "write_storage"
    >;
  };
}

/** The calls of the frame at `address`, made with the session of `client`. */
export function createFrameCalls(
  client: FrameCallClient,
  address: FrameAddress,
  texts?: FrameCallTexts,
  hooks?: FrameCallHooks
): FrameCalls | undefined {
  const proof = frameSessionProof(address);
  if (!proof) {
    return undefined;
  }
  const { pageSessionId, fileSetId, token } = proof;
  return {
    async writeStorage(mutation) {
      completedOutput(
        await client.apps.sessions.write_storage({
          params: { pageSessionId },
          body: { fileSetId, token, mutation }
        })
      );
    },
    can: () =>
      client.apps.sessions.context({ params: { pageSessionId }, body: { fileSetId, token } }).then(
        (answer) => answer.can,
        () => undefined
      ),
    async run(call) {
      // A frame that names no key gets one per message: one message is one call.
      const key = call.idempotencyKey === undefined ? {} : { idempotencyKey: call.idempotencyKey };
      try {
        const result = await client.apps.sessions.call_action({
          params: { pageSessionId, name: call.name },
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
        const failure = frameCallFailure(error, texts);
        if (PREVIEW_IS_NO_APP_REFUSALS.includes(failure.code)) hooks?.onPreviewIsNoApp?.();
        return { ok: false, error: failure };
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
