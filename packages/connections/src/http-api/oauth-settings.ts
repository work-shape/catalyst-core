import { CONNECTOR_TOKEN_AUTH_METHODS } from "@work-shape/catalyst-core";
import { z } from "zod";

const HTTP_API_URL_MAX_CHARS = 2_048;
const FIXED_HEADER_VALUE_MAX_CHARS = 1_024;
const HEADER_VALUE_PATTERN = /^[\x20-\x7e]*$/u;

/** Whether a host is the machine itself, where plain `http` is a local server under test. */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/u.test(host)
  );
}

/**
 * An address of the authorization server: `https`, or plain `http` on the machine itself for
 * local development and tests, without user name, password or fragment. The browser carries a
 * state and a code to it, the instance a client secret and a refresh token.
 */
const oauthAddressSchema = z
  .string()
  .max(HTTP_API_URL_MAX_CHARS)
  .refine((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    return (
      (url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname))) &&
      url.hostname !== "" &&
      url.username === "" &&
      url.password === "" &&
      url.hash === ""
    );
  }, "must be an https address without user name, password or fragment");

/**
 * The parameters of the authorization request the protocol sets itself, the client secret,
 * which never travels through a browser, and those that would replace or redirect the request
 * the sign-in signs: a request object (`request`, `request_uri`, RFC 9101) and the way the
 * answer comes back (`response_mode`). An extra parameter may name none of them.
 */
const OAUTH_PROTOCOL_PARAMS: ReadonlySet<string> = new Set([
  "response_type",
  "response_mode",
  "client_id",
  "client_secret",
  "redirect_uri",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
  "resource",
  "request",
  "request_uri"
]);
/** How many fixed extra parameters a sign-in sends. */
const OAUTH_EXTRA_PARAMS_MAX = 8;
/** A scope as RFC 6749 3.3 writes one: printable, no space, quote or backslash. */
const SCOPE_PATTERN = /^[\x21\x23-\x5B\x5D-\x7E]{1,256}$/u;

/**
 * The authorization server an `http_api` Connection names itself (CONN-OAUTH-1). Read by the
 * auth schemes `oauth` (a person signs in) and `oauth_client` (the client credentials grant).
 */
const oauthProviderSchema = z
  .object({
    authorizationUrl: oauthAddressSchema.optional(),
    tokenUrl: oauthAddressSchema,
    revocationUrl: oauthAddressSchema.optional(),
    authorizationParams: z
      .record(
        z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/u, {
          message: "must be a parameter name of letters, digits, '_', '.' and '-'"
        }),
        z
          .string()
          .max(FIXED_HEADER_VALUE_MAX_CHARS)
          .regex(HEADER_VALUE_PATTERN, { message: "must be printable text on one line" })
      )
      .optional(),
    tokenAuthMethod: z.enum(CONNECTOR_TOKEN_AUTH_METHODS).optional(),
    issuer: oauthAddressSchema.optional()
  })
  .strict()
  .superRefine((oauth, context) => {
    const params = Object.keys(oauth.authorizationParams ?? {});
    if (params.length > OAUTH_EXTRA_PARAMS_MAX) {
      context.addIssue({
        code: "custom",
        path: ["authorizationParams"],
        message: `A sign-in sends at most ${OAUTH_EXTRA_PARAMS_MAX} extra parameters`
      });
    }
    for (const name of params) {
      if (OAUTH_PROTOCOL_PARAMS.has(name.toLowerCase())) {
        context.addIssue({
          code: "custom",
          path: ["authorizationParams", name],
          message: `The parameter '${name}' is set by the sign-in itself`
        });
      }
    }
  });

export const oauthScopesSchema = z
  .array(z.string().regex(SCOPE_PATTERN, { message: "must be one scope without spaces" }))
  .max(64);

export const oauthSettingsSchema = oauthProviderSchema.safeExtend({
  clientId: z.string().min(1).max(512).regex(HEADER_VALUE_PATTERN, {
    message: "must be printable text on one line"
  }),
  scopes: oauthScopesSchema.optional()
});

export const oauthEntrySchema = oauthProviderSchema.safeExtend({
  authorizationUrl: oauthAddressSchema
});
