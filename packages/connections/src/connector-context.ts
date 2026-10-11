import {
  AppError,
  CREDENTIAL_REFUSALS,
  EGRESS_DENIED,
  LOG_REDACTION,
  SHARED_CREDENTIAL_SUBJECT,
  type ConnectionConfig,
  type ConnectionCredential,
  type ConnectionCredentialResolver,
  type ConnectorContext,
  type ConnectorTypeDefinition,
  type EgressChecker,
  type EgressGrant,
  type JsonObject
} from "@vivd-catalyst/core";
import { isSameEgressOrigin } from "./egress";

// The connector auth component. It is the one place a Connector type gets a context from,
// and so the one place a credential is resolved: after the caller was authorized, after the
// Connection's target passed the egress check, for the one binding of the call.

/** The auth scheme of a Connection that sends no credential. */
export const AUTH_SCHEME_NONE = "none";

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
 * What an auth scheme makes of the secret. `bearer` and `header` become one request header;
 * every other scheme, such as a database password, is handed the secret itself. No scheme
 * puts a credential into an address or a query: those end up in logs of the other side.
 */
function credentialOf(
  type: ConnectorTypeDefinition,
  scheme: string,
  settings: JsonObject,
  secret: string
): ConnectionCredential {
  if (scheme === "bearer") {
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

export interface OpenConnectorContextInput {
  type: ConnectorTypeDefinition;
  /** The Connection of the call: its asset id, its revision and the config of that revision. */
  connection: { id: string; revision: number; config: ConnectionConfig };
  egress: EgressChecker;
  credentials: ConnectionCredentialResolver;
  signal: AbortSignal;
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

  let credential: ConnectionCredential | undefined;
  if (config.authScheme !== AUTH_SCHEME_NONE) {
    if (config.secretHandle === undefined) {
      throw new AppError(
        "CONFLICT",
        `${CREDENTIAL_REFUSALS.notConfigured}: the Connection has no stored secret`,
        { reason: CREDENTIAL_REFUSALS.notConfigured }
      );
    }
    const secret = await credentials.resolve({
      handle: config.secretHandle,
      binding: { connectionAssetId: connection.id, subject: SHARED_CREDENTIAL_SUBJECT }
    });
    credential = credentialOf(type, config.authScheme, settings.data, secret);
  }

  return {
    connection: {
      id: connection.id,
      name: config.name,
      revision: connection.revision,
      settings: settings.data,
      authScheme: config.authScheme
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
    signal
  };
}
