import { createHash } from "node:crypto";
import {
  connectionCallError,
  connectionCallReasonOf,
  type ConnectorContext,
  type ConnectorOAuthEndpoints
} from "@work-shape/catalyst-core";
import { z } from "zod";
import type { OAuthFetch } from "./fetch";

// Tokens of the client credentials grant (RFC 6749 4.4). Such a token is never written down:
// it lives in the memory of the process that asked for it until shortly before it expires.
// Calls that need one at the same time wait for one request, and a new client secret or a new
// revision of the Connection never reuses a token obtained with the one before.

/** How long before its expiry a token is asked for anew. */
const EXPIRY_MARGIN_MS = 60_000;
/** How long a token is kept whose answer names no expiry. */
const UNNAMED_EXPIRY_SECONDS = 300;

interface Entry {
  /** What the token was obtained with: revision, origin and a hash of the secret. */
  fingerprint: string;
  promise: Promise<string>;
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** The hash of a client secret, which a cache compares instead of keeping the secret. */
export function secretFingerprint(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * One cache of tokens per key. `get` answers the token obtained for the same fingerprint, or
 * asks `issue` once for every caller that waits. `refused` names a token the outside system
 * refused: it is dropped, and a new one asked for. Expiry removes the token from memory.
 */
export function createTokenCache() {
  const entries = new Map<string, Entry>();
  const forget = (key: string, entry: Entry) => {
    if (entries.get(key) === entry) entries.delete(key);
    clearTimeout(entry.timer);
  };
  return {
    invalidate(key: string) {
      const entry = entries.get(key);
      if (entry) forget(key, entry);
    },
    async get(input: {
      key: string;
      fingerprint: string;
      issue: () => Promise<{ token: string; expiresIn: number }>;
      refused?: string;
    }): Promise<string> {
      const { key, fingerprint } = input;
      let entry = entries.get(key);
      if (entry && (entry.fingerprint !== fingerprint || entry.expiresAt <= Date.now())) {
        forget(key, entry);
        entry = undefined;
      }
      if (entry && input.refused !== undefined) {
        const held = entry;
        const token = await held.promise.catch(() => undefined);
        if (token === input.refused) forget(key, held);
        entry = entries.get(key);
      }
      if (!entry) {
        const next: Entry = { fingerprint, expiresAt: Infinity, promise: Promise.resolve("") };
        next.promise = input
          .issue()
          .then(({ token, expiresIn }) => {
            next.expiresAt = Date.now() + Math.max(0, expiresIn * 1000 - EXPIRY_MARGIN_MS);
            next.timer = setTimeout(
              () => forget(key, next),
              Math.max(0, next.expiresAt - Date.now())
            );
            next.timer.unref();
            return token;
          })
          .catch((error: unknown) => {
            forget(key, next);
            throw error;
          });
        entries.set(key, next);
        entry = next;
      }
      return entry.promise;
    }
  };
}

/** One token lifecycle per connector: concurrent callers join issuance; rotated credentials
 * and revisions never reuse a token. Expiry removes the in-memory token and credential. */
export function createClientCredentialsTokens() {
  const cache = createTokenCache();
  return {
    invalidate(context: ConnectorContext) {
      cache.invalidate(context.connection.id);
    },
    get(context: ConnectorContext, issue: () => Promise<{ token: string; expiresIn: number }>) {
      const secret = context.credentialFor(context.target)?.secret ?? "";
      return cache.get({
        key: context.connection.id,
        fingerprint: `${context.connection.revision}|${secretFingerprint(secret)}`,
        issue
      });
    }
  };
}

/** A token endpoint's answer to the client credentials grant, as far as it is read. */
const tokenAnswerSchema = z.object({
  access_token: z.string().min(1).max(16_384),
  token_type: z.string().max(64).optional(),
  expires_in: z.number().positive().finite().optional()
});

/** The `Authorization` value of HTTP Basic for a client, each part form-encoded (RFC 6749 2.3.1). */
function basic(clientId: string, clientSecret: string): string {
  const encode = (value: string) => encodeURIComponent(value).replace(/%20/gu, "+");
  return `Basic ${Buffer.from(`${encode(clientId)}:${encode(clientSecret)}`, "utf8").toString("base64")}`;
}

/**
 * Asks the token endpoint for a token by the client credentials grant. A refused client, or a
 * refusal of the grant, answers `upstream_unauthorized`; an answer that is not a bearer token
 * `upstream_error`; anything else the outside system's outage. Nothing of the answer but the
 * token and its lifetime is read, and nothing of it is repeated in an error.
 */
export async function requestClientCredentialsToken(input: {
  endpoints: ConnectorOAuthEndpoints;
  clientSecret: string;
  fetch: OAuthFetch;
}): Promise<{ token: string; expiresIn: number }> {
  const { endpoints, clientSecret } = input;
  const body = new URLSearchParams({ grant_type: "client_credentials" });
  if (endpoints.scopes.length > 0) body.set("scope", endpoints.scopes.join(" "));
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json"
  });
  if (endpoints.tokenAuthMethod === "client_secret_basic") {
    headers.set("authorization", basic(endpoints.clientId, clientSecret));
  } else {
    body.set("client_id", endpoints.clientId);
    body.set("client_secret", clientSecret);
  }
  let response: Response;
  try {
    response = await input.fetch(endpoints.tokenUrl, { method: "POST", headers, body });
  } catch (error) {
    if (connectionCallReasonOf(error) !== undefined) throw error;
    throw connectionCallError("connection_unavailable");
  } finally {
    body.delete("client_secret");
  }
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw connectionCallError("upstream_unauthorized");
  }
  if (response.status < 200 || response.status > 299) {
    await response.body?.cancel();
    throw connectionCallError(response.status >= 500 ? "connection_unavailable" : "upstream_error");
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    if (connectionCallReasonOf(error) !== undefined) throw error;
    throw connectionCallError("upstream_error");
  }
  const answer = tokenAnswerSchema.safeParse(parsed);
  if (
    !answer.success ||
    (answer.data.token_type !== undefined && answer.data.token_type.toLowerCase() !== "bearer")
  ) {
    throw connectionCallError("upstream_error", "the token endpoint answered no bearer token");
  }
  return {
    token: answer.data.access_token,
    expiresIn: answer.data.expires_in ?? UNNAMED_EXPIRY_SECONDS
  };
}
