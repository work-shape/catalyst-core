import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import { z } from "zod";
import { AppError } from "@vivd-catalyst/core";
import {
  ModelProviderError,
  modelProviderErrorKindForStatus,
  toModelTransportFailure
} from "../model-provider-error";

/**
 * Where a service account trades its signed assertion for an access token. Google has one such
 * endpoint and no regional one. The request carries the assertion and nothing of a call.
 */
const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
// How long an assertion is valid. Google accepts at most one hour.
const ASSERTION_LIFETIME_SECONDS = 3_600;
// A token is replaced this long before it ends, so no call starts on one that ends under way.
const TOKEN_RENEWAL_MARGIN_MS = 5 * 60 * 1000;
// Protects every call that waits for a token from a token endpoint that does not answer. The
// exchange takes well under a second; past this it fails as a lost connection, which is retried.
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;

const serviceAccountKeySchema = z.object({
  client_email: z.string().min(1),
  private_key: z.string().min(1),
  private_key_id: z.string().min(1).optional()
});

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive()
});

/** Hands out the access token of one service account and renews it before it ends. */
export interface GoogleAccessTokenSource {
  accessToken(signal?: AbortSignal): Promise<string>;
}

/**
 * Reads the JSON key of a service account. `secretName` is the name the config gives the
 * secret; a message names it and never what the secret holds.
 */
export function createGoogleAccessTokenSource(
  serviceAccountKeyJson: string,
  secretName: string
): GoogleAccessTokenSource {
  const unusable = (): AppError =>
    new AppError(
      "VALIDATION_FAILED",
      `Secret '${secretName}' is not the JSON key of a Google service account`
    );
  let key: z.infer<typeof serviceAccountKeySchema>;
  let privateKey: KeyObject;
  try {
    key = serviceAccountKeySchema.parse(JSON.parse(serviceAccountKeyJson));
    privateKey = createPrivateKey(key.private_key);
  } catch {
    throw unusable();
  }

  let current: { token: string; renewAtMs: number } | undefined;
  let pending: Promise<string> | undefined;

  const assertion = (): string => {
    const issuedAt = Math.floor(Date.now() / 1000);
    const encode = (value: object): string =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({
      alg: "RS256",
      typ: "JWT",
      ...(key.private_key_id ? { kid: key.private_key_id } : {})
    })}.${encode({
      iss: key.client_email,
      scope: GOOGLE_CLOUD_PLATFORM_SCOPE,
      aud: GOOGLE_OAUTH_TOKEN_URL,
      iat: issuedAt,
      exp: issuedAt + ASSERTION_LIFETIME_SECONDS
    })}`;
    return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url")}`;
  };

  const renew = async (): Promise<string> => {
    let response: Response;
    try {
      response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: assertion()
        }).toString(),
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS)
      });
    } catch {
      throw toModelTransportFailure(new Error("The token request failed"));
    }
    // The answer names the account on a refusal and holds the token on success: neither is kept
    // beyond the token itself, and nothing of it reaches an error.
    const payload: unknown = await response.json().catch(() => undefined);
    const parsed = tokenResponseSchema.safeParse(payload);
    if (!response.ok || !parsed.success) {
      throw new ModelProviderError({
        kind: response.ok ? "invalid_response" : modelProviderErrorKindForStatus(response.status),
        message: "Model provider authentication failed",
        status: response.status,
        details: { status: response.status, stage: "authentication" }
      });
    }
    current = {
      token: parsed.data.access_token,
      renewAtMs: Date.now() + parsed.data.expires_in * 1000 - TOKEN_RENEWAL_MARGIN_MS
    };
    return current.token;
  };

  return {
    async accessToken(signal) {
      if (current && Date.now() < current.renewAtMs) {
        return current.token;
      }
      // Calls that arrive together wait for one renewal. It belongs to none of them: a call
      // that is stopped stops waiting, and the others still get their token.
      pending ??= renew().finally(() => {
        pending = undefined;
      });
      return signal ? untilStopped(pending, signal) : pending;
    }
  };
}

/** Settles as `pending` does, or rejects with the signal's reason when it aborts first. */
function untilStopped<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(stopReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(stopReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function stopReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error
    ? reason
    : new DOMException("The model call was stopped", "AbortError");
}
