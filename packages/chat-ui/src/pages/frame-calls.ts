import {
  ApiError,
  type ApiClient,
  type AppActionPermission,
  type AppBridgeHostMessage,
  type AppBridgePageMessage
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
type CallAnswer = Extract<AppBridgeHostMessage, { type: "action_result" }>;

/** How one call of a frame came out, as the frame is told. */
export type FrameCallAnswer =
  | { ok: true; result: NonNullable<CallAnswer["result"]> }
  | { ok: false; error: NonNullable<CallAnswer["error"]> };

/** What the bridge of a frame calls the instance through. */
export interface FrameCalls {
  /** What each action would come to for the viewer, or nothing where it could not be read. */
  can(): Promise<Record<string, AppActionPermission> | undefined>;
  run(message: CallMessage): Promise<FrameCallAnswer>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What a frame reads of a call that was refused or failed: a fixed word, the sentence of the
 * instance and, for a missing right, the right. A refusal for a right says `forbidden`. Every
 * other error says the reason the instance gave, or its error code in lower case.
 */
export function frameCallFailure(error: unknown): NonNullable<CallAnswer["error"]> {
  if (!(error instanceof ApiError)) {
    return { code: "failed", message: "The call could not be made." };
  }
  const envelope = isRecord(error.payload) ? error.payload.error : undefined;
  const details = isRecord(envelope) && isRecord(envelope.details) ? envelope.details : {};
  if (error.code === "FORBIDDEN" && typeof details.action === "string") {
    return { code: "forbidden", message: error.message, right: details.action };
  }
  const reason = typeof details.reason === "string" ? details.reason : undefined;
  return {
    code: reason ?? error.code?.toLowerCase() ?? "failed",
    message: error.message
  };
}

/** What the calls of a frame use of the API client: the three calls of a page session. */
export interface FrameCallClient {
  apps: Pick<ApiClient["apps"], "sessions">;
}

/** The calls of the frame at `address`, made with the session of `client`. */
export function createFrameCalls(
  client: FrameCallClient,
  address: FrameAddress
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
    async run(message) {
      // A frame that names no key gets one per message: one message is one call.
      const key =
        message.idempotencyKey === undefined ? {} : { idempotencyKey: message.idempotencyKey };
      try {
        const result =
          message.type === "action"
            ? await client.apps.sessions.call_action({
                params: { pageSessionId, name: message.name },
                body: { fileSetId, token, input: message.input },
                ...key
              })
            : await client.apps.sessions.call_connection({
                params: {
                  pageSessionId,
                  connection: message.connection,
                  operation: message.operation
                },
                body: { fileSetId, token, input: message.input },
                ...key
              });
        return {
          ok: true,
          result: {
            runId: result.runId,
            status: result.status,
            ...("result" in result ? { result: result.result } : {})
          }
        };
      } catch (error) {
        return { ok: false, error: frameCallFailure(error) };
      }
    }
  };
}
