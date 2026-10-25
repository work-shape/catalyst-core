import {
  CONNECTION_OAUTH_ADMIN_CONSENT_STATE,
  type ConnectorOAuthEndpoints
} from "@work-shape/catalyst-core";

// Admin consent (MS-APP-2). Some organisations let only an administrator approve an app that
// reads people's data. The provider then refuses a person's sign-in with an error that the
// Connection's settings name (`oauth.adminConsent.errorCodes`), and the person gets a link to
// send to their IT. An administrator opens it once and approves the app for everyone in the
// organisation; afterwards people sign in as before. Which codes mean "approval missing" is
// data of the catalogue entry, never a provider's code in the platform.

/**
 * The link an administrator approves the app with: the provider's admin-consent address with
 * the client id, the scopes the Connection asks for, its redirect URI and the fixed admin-
 * consent state. It holds the public client id only, never a secret. Nothing without an
 * admin-consent address or a redirect URI.
 */
export function adminConsentUrl(
  endpoints: Pick<ConnectorOAuthEndpoints, "adminConsent" | "clientId" | "scopes"> | undefined,
  redirectUri: string | undefined
): string | undefined {
  if (endpoints?.adminConsent === undefined || redirectUri === undefined) return undefined;
  const url = new URL(endpoints.adminConsent.url);
  url.searchParams.set("client_id", endpoints.clientId);
  if (endpoints.scopes.length > 0) url.searchParams.set("scope", endpoints.scopes.join(" "));
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", CONNECTION_OAUTH_ADMIN_CONSENT_STATE);
  return url.href;
}

/**
 * Whether a refused sign-in says the organisation's approval is missing: one of the codes is
 * the callback's `error`, or a word of its `error_description`. The provider's text is read
 * for the code alone and goes no further.
 */
export function asksAdminConsent(
  endpoints: Pick<ConnectorOAuthEndpoints, "adminConsent"> | undefined,
  query: { error?: string; error_description?: string }
): boolean {
  const codes = endpoints?.adminConsent?.errorCodes;
  if (codes === undefined || query.error === undefined) return false;
  const words = new Set(
    [query.error, query.error_description ?? ""].flatMap((text) => text.split(/[^A-Za-z0-9_]+/u))
  );
  return codes.some((code) => words.has(code));
}
