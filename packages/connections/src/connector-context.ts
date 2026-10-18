import {
  AppError,
  CREDENTIAL_REFUSALS,
  EGRESS_DENIED,
  LOG_REDACTION,
  SHARED_CREDENTIAL_SUBJECT,
  connectionCallError,
  egressOriginOf,
  type ConnectionConfig,
  type ConnectionCredential,
  type ConnectionCredentialResolver,
  type ConnectorContext,
  type ConnectorTypeDefinition,
  type EgressChecker,
  type EgressGrant,
  type JsonObject,
  type JsonValue
} from "@work-shape/catalyst-core";
import { isSameEgressOrigin } from "./egress";

// The connector auth component. It is the one place a Connector type gets a context from,
// and so the one place a credential is resolved: after the caller was authorized, after the
// Connection's target passed the egress check, for the one binding of the call.

/** The auth scheme of a Connection that sends no credential. */
export const AUTH_SCHEME_NONE = "none";

/**
 * The auth scheme of a Connection whose credential is the access token of a sign-in at its
 * outside system. The token comes from the Connection's binding, never from its own secret.
 */
export const AUTH_SCHEME_OAUTH = "oauth";

/** A resolver for a process without Secret Store keys: it has no credential to hand out. */
export const NO_CREDENTIALS: ConnectionCredentialResolver = {
  resolve: () => Promise.reject(connectionCallError(CREDENTIAL_REFUSALS.notConfigured)),
  resolveSignIn: () => Promise.reject(connectionCallError(CREDENTIAL_REFUSALS.notConfigured))
};

/** A header name as HTTP writes one. A name a type hands over is checked against it. */
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/u;

/** What a credential answers to anything that would write it out. */
export const CREDENTIAL_REDACTION = "[credential]";
const INSPECT: unique symbol = Symbol.for("nodejs.util.inspect.custom");

/**
 * The headers of a credential. Each stays enumerable, because a connector sets each of them
 * on its request. Written out as a whole, by `JSON.stringify`, `console.log` or the process
 * logger, which reads the mark, they answer the fixed redaction. The hooks and the mark are
 * not enumerable: a copy of the entries is the plain headers a request takes, and plaintext.
 */
function sealHeaders(headers: Record<string, string>): Readonly<Record<string, string>> {
  const answer = { value: () => CREDENTIAL_REDACTION, enumerable: false };
  return Object.freeze(
    Object.defineProperties(
      { ...headers },
      {
        toJSON: answer,
        [INSPECT]: answer,
        [LOG_REDACTION]: { value: CREDENTIAL_REDACTION, enumerable: false }
      }
    )
  );
}

/**
 * The credential of one call. Its members read as `ConnectionCredential` says. The secret
 * and the headers are not enumerable, so a spread, `Object.entries` or a serializer that
 * walks the object finds the scheme and nothing else, and `JSON.stringify`, a logger and
 * `util.inspect` are answered the fixed redaction.
 */
class SealedCredential implements ConnectionCredential {
  readonly scheme: string;
  declare readonly secret: string;
  declare readonly headers: Readonly<Record<string, string>>;
  declare readonly [LOG_REDACTION]: string;

  constructor(scheme: string, secret: string, headers: Record<string, string>) {
    this.scheme = scheme;
    Object.defineProperty(this, "secret", { value: secret, enumerable: false });
    Object.defineProperty(this, "headers", { value: sealHeaders(headers), enumerable: false });
    Object.defineProperty(this, LOG_REDACTION, {
      value: CREDENTIAL_REDACTION,
      enumerable: false
    });
    Object.freeze(this);
  }

  toJSON(): string {
    return CREDENTIAL_REDACTION;
  }

  [INSPECT](): string {
    return CREDENTIAL_REDACTION;
  }
}

function sealCredential(
  scheme: string,
  secret: string,
  headers: Record<string, string>
): ConnectionCredential {
  return new SealedCredential(scheme, secret, headers);
}

/**
 * What an auth scheme makes of the secret. `bearer`, an `oauth` access token and `header`
 * become one request header; every other scheme, such as a database password, is handed the
 * secret itself. No scheme puts a credential into an address or a query: those end up in logs
 * of the other side.
 */
function credentialOf(
  type: ConnectorTypeDefinition,
  scheme: string,
  settings: JsonObject,
  secret: string
): ConnectionCredential {
  if (scheme === "bearer" || scheme === AUTH_SCHEME_OAUTH) {
    return sealCredential(scheme, secret, { authorization: `Bearer ${secret}` });
  }
  if (scheme === "header") {
    const name = type.credentialHeaderName?.(settings);
    if (name === undefined || !HEADER_NAME_PATTERN.test(name)) {
      throw new AppError(
        "CONFLICT",
        `${CREDENTIAL_REFUSALS.notConfigured}: the Connection names no header for its credential`,
        { reason: CREDENTIAL_REFUSALS.notConfigured }
      );
    }
    return sealCredential(scheme, secret, { [name.toLowerCase()]: secret });
  }
  return sealCredential(scheme, secret, {});
}

/**
 * The origin a Connection's secret is set for and sent to: that of its target, read from the
 * settings as a call reads them. Nothing where the settings do not fit the type.
 */
export function connectionOriginOf(
  type: ConnectorTypeDefinition,
  config: Pick<ConnectionConfig, "settings">
): string | undefined {
  const settings = type.settingsSchema.safeParse(config.settings);
  if (!settings.success) return undefined;
  try {
    return egressOriginOf(type.target(settings.data));
  } catch {
    return undefined;
  }
}

/** The handle of the Connection's own secret, which a scheme that sends one needs. */
function storedSecretHandle(config: ConnectionConfig): string {
  if (config.secretHandle === undefined) {
    throw new AppError(
      "CONFLICT",
      `${CREDENTIAL_REFUSALS.notConfigured}: the Connection has no stored secret`,
      { reason: CREDENTIAL_REFUSALS.notConfigured }
    );
  }
  return config.secretHandle;
}

export interface OpenConnectorContextInput {
  type: ConnectorTypeDefinition;
  /** The Connection of the call: its asset id, its revision and the config of that revision. */
  connection: { id: string; revision: number; config: ConnectionConfig };
  egress: EgressChecker;
  credentials: ConnectionCredentialResolver;
  signal: AbortSignal;
  /** The key of a changing call and the header that carries it, where the call has both. */
  idempotencyKey?: { header: string; value: string };
  /**
   * The access token of a sign-in the outside system just refused with a 401: the sign-in is
   * refreshed before a token is handed out again. Only for auth scheme `oauth`.
   */
  refused?: string;
  /** Read afresh for this attempt, never cached on the shared Connection. */
  resolvePersonContext?: (header: string, origin: string) => Promise<string>;
}

/**
 * Opens the context of one test, discovery or call. The caller has authorized the call
 * already. The order is fixed: the settings are read by the type's schema, the target is
 * checked, and only then the credential is resolved. A refusal at any step throws, so the
 * type's `test`, `discover` and `execute` never run and nothing outside is contacted.
 */
export async function openConnectorContext(
  input: OpenConnectorContextInput
): Promise<ConnectorContext> {
  const { type, connection, egress, credentials, signal } = input;
  const { config } = connection;
  const settings = type.settingsSchema.safeParse(config.settings);
  if (!settings.success || !type.authSchemes.includes(config.authScheme)) {
    throw new AppError(
      "CONFLICT",
      `${CREDENTIAL_REFUSALS.notConfigured}: the Connection's settings do not fit its connector type`,
      { reason: CREDENTIAL_REFUSALS.notConfigured }
    );
  }
  const target = await egress.check(type.target(settings.data));
  // A call that ended while its target was checked resolves no credential.
  if (signal.aborted) throw connectionCallError("upstream_timeout");

  let credential: ConnectionCredential | undefined;
  if (config.authScheme !== AUTH_SCHEME_NONE) {
    // Only a secret set, or a sign-in made, for the origin the call goes to is handed out.
    const secret =
      config.authScheme === AUTH_SCHEME_OAUTH
        ? await credentials.resolveSignIn({
            connectionAssetId: connection.id,
            origin: egressOriginOf(target),
            ...(input.refused === undefined ? {} : { refused: input.refused }),
            signal
          })
        : await credentials.resolve({
            handle: storedSecretHandle(config),
            binding: { connectionAssetId: connection.id, subject: SHARED_CREDENTIAL_SUBJECT },
            origin: egressOriginOf(target)
          });
    // A call that ended while its credential was read is handed none: the secret stays where
    // it was resolved and no type sees it.
    if (signal.aborted) throw connectionCallError("upstream_timeout");
    credential = credentialOf(type, config.authScheme, settings.data, secret);
  }

  const header = type.personContextHeaderName?.(settings.data);
  const personContext =
    header === undefined
      ? undefined
      : {
          header,
          value: await (input.resolvePersonContext?.(header, egressOriginOf(target)) ??
            Promise.reject(connectionCallError("person_context_unmapped")))
        };
  if (signal.aborted) throw connectionCallError("upstream_timeout");
  return {
    ...(personContext === undefined ? {} : { personContext }),
    connection: {
      id: connection.id,
      name: config.name,
      revision: connection.revision,
      settings: settings.data,
      authScheme: config.authScheme,
      operations: config.operations
    },
    target,
    checkEgress: (further) => egress.check(further),
    credentialFor(checked: EgressGrant) {
      if (!isSameEgressOrigin(checked, target) || checked.address !== target.address) {
        throw new AppError(
          "FORBIDDEN",
          `${EGRESS_DENIED}: a credential is sent to the origin it was configured for only`,
          { reason: EGRESS_DENIED, host: checked.host, port: checked.port }
        );
      }
      return credential;
    },
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    signal
  };
}

/** A value as text may hold it: as it is, escaped as JSON once or twice, and encoded. */
function formsOf(value: string): string[] {
  const escaped = JSON.stringify(value).slice(1, -1);
  const bytes = Buffer.from(value, "utf8");
  const base64 = bytes.toString("base64");
  return [
    value,
    escaped,
    JSON.stringify(escaped).slice(1, -1),
    base64,
    base64.replace(/=+$/u, ""),
    bytes.toString("base64url"),
    bytes.toString("hex"),
    encodeURIComponent(value)
  ].filter((form) => form !== "");
}

/**
 * Whether data of the server holds the credential this call carried: the secret, or a header
 * made of it, as it is, escaped as JSON, as base64 in both alphabets, as hex or as part of an
 * address. Data that does is discarded whole. `undefined` credential: nothing to find.
 */
export function holdsCredential(
  data: JsonValue,
  credential: ConnectionCredential | undefined
): boolean {
  if (credential === undefined) return false;
  const written = JSON.stringify(data);
  const lowered = written.toLowerCase();
  for (const value of new Set([credential.secret, ...Object.values(credential.headers)])) {
    for (const form of formsOf(value)) {
      if (written.includes(form) || lowered.includes(form.toLowerCase())) return true;
    }
  }
  return false;
}
