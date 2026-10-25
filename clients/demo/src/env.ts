import { createEnvironmentSecrets } from "@work-shape/catalyst-client-assembly";
import { accountingRestOptionsSchema } from "../sample-mcp/accounting/rest-options.js";

/** The environment of the sample MCP server. The key is taken from the secret resolver. */
export function readSampleMcpEnvironment() {
  return {
    secrets: createEnvironmentSecrets(process.env),
    anchor: process.env.SAMPLE_DATA_ANCHOR,
    accountingLastMonth: process.env.SAMPLE_ACCOUNTING_LAST_MONTH,
    accountingRest: accountingRestOptionsSchema.parse({
      latencyMs: process.env.SAMPLE_ACCOUNTING_REST_LATENCY_MS,
      rateLimitAfter: process.env.SAMPLE_ACCOUNTING_REST_RATE_LIMIT_AFTER,
      rateWindowMs: process.env.SAMPLE_ACCOUNTING_REST_RATE_WINDOW_MS,
      unavailable: process.env.SAMPLE_ACCOUNTING_REST_UNAVAILABLE,
      // Compose passes an unset switch as an empty value, which means off.
      unavailableClientId: process.env.SAMPLE_ACCOUNTING_REST_UNAVAILABLE_CLIENT_ID || undefined,
      scaleDivisor: process.env.SAMPLE_ACCOUNTING_SCALE_DIVISOR
    }),
    port: process.env.PORT,
    host: process.env.HOST,
    // The OAuth sign-in in front of `/dcr/mcp` and `/registered/mcp`, on where the issuer base
    // is set (sample-mcp/oauth.ts). The client id and redirect URI are those of the mode
    // `registered`, as a provider would issue them; neither is a secret.
    oauthIssuerBase: process.env.SAMPLE_OAUTH_ISSUER_BASE,
    oauthBrowserBase: process.env.SAMPLE_OAUTH_BROWSER_BASE,
    oauthClientId: process.env.SAMPLE_OAUTH_CLIENT_ID,
    oauthRedirectUri: process.env.SAMPLE_OAUTH_REDIRECT_URI,
    // The REST provider under `/oauth-rest` (CONN-OAUTH-1), served where its client id and
    // redirect URI are set. Its client secret is read from the secret resolver.
    oauthRestClientId: process.env.SAMPLE_OAUTH_REST_CLIENT_ID,
    oauthRestRedirectUri: process.env.SAMPLE_OAUTH_REST_REDIRECT_URI,
    // `required`: the REST provider refuses sign-ins until an administrator approved its client.
    oauthRestAdminConsent: process.env.SAMPLE_OAUTH_REST_ADMIN_CONSENT === "required"
  };
}

/** The environment of a command of the demo that runs on the host, such as `pnpm demo:seed`. */
export function hostEnvironment(): Readonly<Record<string, string | undefined>> {
  return process.env;
}
