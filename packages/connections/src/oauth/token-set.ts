import { z } from "zod";
import type { OAuthTokenSet } from "./port";

// The token set of a binding as the Secret Store holds it: one JSON secret per binding, under
// subject `oauth:<binding subject>`. Beside the tokens it names where they came from, so a
// refresh and a revocation reach the same authorization server, for the same resource and as
// the same client, without the setup session that is long gone. Nothing of it leaves the
// process but the access token in a request header and the refresh token to the issuer.

const storedTokenSetSchema = z.object({
  accessToken: z.string().min(1),
  /** Missing in a token set an earlier release stored: a bearer token all the same. */
  tokenType: z.string().optional(),
  expiresAt: z.string().optional(),
  refreshToken: z.string().min(1).optional(),
  scope: z.string().optional(),
  /** The issuer the tokens were obtained from, as the setup session named it. */
  issuer: z.string().optional(),
  /** The RFC 8707 `resource` the tokens were obtained for. */
  resource: z.string().optional(),
  /** The OAuth client that obtained them. */
  clientId: z.string().optional()
});

export type StoredTokenSet = z.infer<typeof storedTokenSetSchema>;

/** The token set of a secret's text, or nothing where it is none. Its text is never repeated. */
export function readTokenSet(text: string): StoredTokenSet | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const read = storedTokenSetSchema.safeParse(value);
  return read.success ? read.data : undefined;
}

/** When an access token that lives `expiresIn` seconds from `issuedAt` expires, if it does. */
function accessExpiryOf(issuedAt: number, expiresIn: number | undefined): string | undefined {
  return expiresIn !== undefined && Number.isFinite(expiresIn) && expiresIn > 0
    ? new Date(issuedAt + expiresIn * 1000).toISOString()
    : undefined;
}

/**
 * The text of the token set a token endpoint answered, with where it came from. A refresh
 * that answers no new refresh token keeps the one it used (RFC 6749 6).
 */
export function writeTokenSet(input: {
  tokens: OAuthTokenSet;
  issuedAt: number;
  origin: { issuer: string; resource: string; clientId: string };
  previousRefreshToken?: string;
  previousScope?: string;
}): { text: string; accessExpiresAt: string | undefined; scope: string | undefined } {
  const { tokens, origin } = input;
  const accessExpiresAt = accessExpiryOf(input.issuedAt, tokens.expiresIn);
  const refreshToken = tokens.refreshToken ?? input.previousRefreshToken;
  const scope = tokens.scope ?? input.previousScope;
  const stored: StoredTokenSet = {
    accessToken: tokens.accessToken,
    tokenType: tokens.tokenType,
    ...(accessExpiresAt === undefined ? {} : { expiresAt: accessExpiresAt }),
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(scope === undefined ? {} : { scope }),
    issuer: origin.issuer,
    resource: origin.resource,
    clientId: origin.clientId
  };
  return { text: JSON.stringify(stored), accessExpiresAt, scope };
}
