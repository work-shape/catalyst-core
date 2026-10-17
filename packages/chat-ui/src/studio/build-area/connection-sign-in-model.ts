import {
  CONNECTION_NAME_PATTERN,
  CONNECTION_OAUTH_CONNECTED,
  CONNECTION_OAUTH_LANDING_PATH,
  EGRESS_DENIED,
  isConnectionOAuthReason,
  type ConnectionOAuthReason
} from "@work-shape/catalyst-core";
import type { ConnectionDetail, ConnectionOAuthStart } from "@work-shape/catalyst-api-client";
import { apiErrorCode } from "../../shared/workspace-utils";
import { readRefusalDetails } from "./build-refusals";

// The shared OAuth sign-in of a Connection (CS-4b4), as the New connection dialog and the
// Connection page run it, without React. The instance starts a sign-in
// (`connections.oauth_start`) and answers the address of the provider's page; the browser opens
// it in a new tab, the provider sends that tab back to the instance's callback, and the callback
// lands it on `/build/connections?signIn=<outcome>`. The tab that started reads the Connection
// until its sign-in is in, and hears the outcome of the landing tab on a channel of the origin.
// Nothing here sees a code, a state or a token: the instance keeps them.

/** Why a sign-in stopped at its step, as the step says it. */
export type SignInFailure =
  | ConnectionOAuthReason
  | typeof EGRESS_DENIED
  /** The instance answers that this person may not sign the Connection in. */
  | "forbidden"
  /** The browser opened no tab. */
  | "tab_blocked"
  | "failed";

/** A failure with what its sentence names: the host it is about. */
export interface SignInError {
  failure: SignInFailure;
  host?: string;
}

/** The value of `signIn` on the landing page. */
export type SignInOutcome = typeof CONNECTION_OAUTH_CONNECTED | SignInFailure;

/** What the landing tab reads of its address: the outcome and the Connection, never more. */
export interface SignInLanding {
  outcome: SignInOutcome;
  connection?: string;
}

/** How often the starting tab reads the Connection while the other tab signs in. */
export const SIGN_IN_READ_MS = 2_000;

/** A sign-in started this long before its session ends is started again before it opens. */
const SIGN_IN_RESTART_MARGIN_MS = 60_000;

/** The channel of the origin on which a landing tab tells the outcome to the tab that waits. */
export const SIGN_IN_CHANNEL = "catalyst:connection-sign-in";

function isSignInFailure(value: unknown): value is SignInFailure {
  return (
    isConnectionOAuthReason(value) ||
    value === EGRESS_DENIED ||
    value === "forbidden" ||
    value === "tab_blocked" ||
    value === "failed"
  );
}

/** An outcome from an address or a message, which nobody vouches for. */
function outcomeOf(value: unknown): SignInOutcome {
  if (value === CONNECTION_OAUTH_CONNECTED) return CONNECTION_OAUTH_CONNECTED;
  return isSignInFailure(value) ? value : "failed";
}

function connectionNameOf(value: unknown): string | undefined {
  return typeof value === "string" && CONNECTION_NAME_PATTERN.test(value) ? value : undefined;
}

/** Why a start or a write of the sign-in was refused, read from the instance's answer. */
export function signInErrorOf(error: unknown): SignInError {
  const details = readRefusalDetails(error);
  const host = hostOf(error);
  if (isSignInFailure(details.reason)) {
    return { failure: details.reason, ...(host === undefined ? {} : { host }) };
  }
  return { failure: apiErrorCode(error) === "FORBIDDEN" ? "forbidden" : "failed" };
}

/** The host a refusal of the egress checker names. */
function hostOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("payload" in error)) return undefined;
  const { payload } = error;
  if (typeof payload !== "object" || payload === null || !("error" in payload)) return undefined;
  const answer = payload.error;
  if (typeof answer !== "object" || answer === null || !("details" in answer)) return undefined;
  const { details } = answer;
  return typeof details === "object" &&
    details !== null &&
    "host" in details &&
    typeof details.host === "string"
    ? details.host
    : undefined;
}

/**
 * The landing of a sign-in, where the address is the landing page with its outcome. Anything
 * else in the address is not read.
 */
export function readSignInLanding(location: {
  pathname: string;
  search: string;
}): SignInLanding | undefined {
  const path = location.pathname.replace(/\/+$/u, "");
  if (path !== CONNECTION_OAUTH_LANDING_PATH) return undefined;
  const query = new URLSearchParams(location.search);
  const outcome = query.get("signIn");
  if (outcome === null) return undefined;
  const connection = connectionNameOf(query.get("connection"));
  return { outcome: outcomeOf(outcome), ...(connection === undefined ? {} : { connection }) };
}

/** A message on the sign-in channel, which nobody vouches for. */
export function readSignInMessage(data: unknown): SignInLanding | undefined {
  if (typeof data !== "object" || data === null || !("outcome" in data)) return undefined;
  const connection = "connection" in data ? connectionNameOf(data.connection) : undefined;
  return { outcome: outcomeOf(data.outcome), ...(connection === undefined ? {} : { connection }) };
}

/** Whether the Connection is signed in with a sign-in other than the one it had before. */
export function signedInSince(
  detail: Pick<ConnectionDetail, "binding">,
  before: Pick<ConnectionDetail, "binding"> | undefined
): boolean {
  const { binding } = detail;
  if (binding?.state !== "connected") return false;
  const earlier = before?.binding;
  return earlier?.state !== "connected" || earlier.connectedAt !== binding.connectedAt;
}

/** Whether a Connection that signs in has no sign-in its calls can use. */
export function needsSignIn(detail: Pick<ConnectionDetail, "binding" | "oauth">): boolean {
  return detail.oauth !== undefined && detail.binding?.state !== "connected";
}

/**
 * The scopes to write before the provider's page opens: the ticked ones, in the order offered,
 * where they differ from those the start asks for. Nothing to write where they are the same.
 */
export function scopesToWrite(
  offered: readonly string[],
  ticked: ReadonlySet<string>,
  asked: readonly string[]
): string[] | undefined {
  const chosen = offered.filter((scope) => ticked.has(scope));
  const same = chosen.length === asked.length && asked.every((scope) => ticked.has(scope));
  return same ? undefined : chosen;
}

/** Whether a started sign-in may still be opened, or is started again first. */
export function startStillOpens(start: Pick<ConnectionOAuthStart, "expiresAt">, now: number) {
  return Date.parse(start.expiresAt) - now > SIGN_IN_RESTART_MARGIN_MS;
}

/** The `settings.oauth` of a definition, as far as it is an object. */
export function oauthSettingsOf(config: Record<string, unknown>): Record<string, unknown> {
  const { settings } = config;
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return {};
  const oauth: unknown = Object.getOwnPropertyDescriptor(settings, "oauth")?.value;
  return typeof oauth === "object" && oauth !== null && !Array.isArray(oauth)
    ? Object.fromEntries(Object.entries(oauth))
    : {};
}

/** The definition with `settings.oauth` changed by `oauth` and the auth scheme `oauth`. */
export function withOAuthSettings(
  config: Record<string, unknown>,
  oauth: { clientId?: string; scopes?: string[] }
): Record<string, unknown> {
  const { settings } = config;
  const current =
    typeof settings === "object" && settings !== null && !Array.isArray(settings)
      ? Object.fromEntries(Object.entries(settings))
      : {};
  return {
    ...config,
    authScheme: "oauth",
    settings: { ...current, oauth: { ...oauthSettingsOf(config), ...oauth } }
  };
}

/** How a wait for the other tab ended. */
export type SignInWaitOutcome =
  | { status: "connected"; detail: ConnectionDetail }
  | { status: "failed"; error: SignInError }
  | { status: "cancelled" };

/** What a wait for the other tab is handed. */
export interface SignInWaitCalls {
  readDetail(): Promise<ConnectionDetail>;
  pause(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
  /** Hears the landing tabs of the origin until the returned function is called. */
  listen(onLanding: (landing: SignInLanding) => void): () => void;
}

/**
 * Waits until the Connection is signed in anew, the other tab lands with a refusal, the session
 * ends, or `signal` cancels. A read that fails is read again at the next turn.
 */
export async function waitForSignIn(
  calls: SignInWaitCalls,
  input: {
    connection: string;
    start: Pick<ConnectionOAuthStart, "expiresAt" | "providerHost">;
    before: Pick<ConnectionDetail, "binding"> | undefined;
    signal: AbortSignal;
  }
): Promise<SignInWaitOutcome> {
  const { signal } = input;
  let landed: SignInLanding | undefined;
  const wake = new AbortController();
  const stop = calls.listen((landing) => {
    if (landing.connection !== undefined && landing.connection !== input.connection) return;
    landed = landing;
    wake.abort();
  });
  try {
    for (;;) {
      if (signal.aborted) return { status: "cancelled" };
      if (landed !== undefined && landed.outcome !== CONNECTION_OAUTH_CONNECTED) {
        return { status: "failed", error: { failure: landed.outcome } };
      }
      const detail = await calls.readDetail().catch(() => undefined);
      if (signal.aborted) return { status: "cancelled" };
      if (detail && signedInSince(detail, input.before)) return { status: "connected", detail };
      if (calls.now() >= Date.parse(input.start.expiresAt)) {
        return { status: "failed", error: { failure: "oauth_session_expired" } };
      }
      await calls.pause(SIGN_IN_READ_MS, AbortSignal.any([signal, wake.signal]));
    }
  } finally {
    stop();
  }
}
