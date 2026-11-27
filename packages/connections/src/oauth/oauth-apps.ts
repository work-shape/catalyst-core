import { timingSafeEqual } from "node:crypto";
import {
  AppError,
  CREDENTIAL_REFUSALS,
  SECRET_WRITE_CONFLICT,
  connectionOAuthServerOf,
  type ClientInstanceId,
  type ConnectionsStore,
  type ConnectorOAuthEndpoints,
  type StoredOAuthAppRecord
} from "@work-shape/catalyst-core";
import { SECRET_VALUE_MAX_BYTES, type SecretKeyring } from "../secret-store";

// An instance's OAuth app (OAUTH-APP): the client id and client secret an admin registered at
// one authorization server, entered once. A Connection whose settings name that server and
// that client id, and that holds no client secret of its own, uses it at the code exchange,
// the refresh and the revocation. The secret is sealed with the Secret Store's keys, bound to
// the instance, the server, the client id and the version, and is opened only for one request.
// Nothing here logs, and no error carries a value.

export interface OAuthAppDeps {
  clientInstanceId: ClientInstanceId;
  keyring: SecretKeyring;
  /** The rows. Inside a transaction, the store bound to it. */
  store: ConnectionsStore;
}

/** What anybody may learn of an app: never its secret. */
export interface OAuthAppView {
  service?: string;
  clientId: string;
  version: number;
}

/**
 * The associated data of one app's ciphertext. A row copied to another instance or server, or
 * given another client id or version, does not open.
 */
export function oauthAppAssociatedData(input: {
  clientInstanceId: string;
  server: string;
  clientId: string;
  version: number;
}): string {
  const parts = [
    "oauth_app",
    input.clientInstanceId,
    input.server,
    encodeURIComponent(input.clientId),
    String(input.version)
  ];
  if (parts.some((part) => part === "" || part.includes("|"))) {
    throw new AppError("INTERNAL", "An OAuth app holds a part that cannot be bound");
  }
  return parts.join("|");
}

function openApp(deps: OAuthAppDeps, record: StoredOAuthAppRecord): Buffer | undefined {
  return deps.keyring.open({
    keyId: record.keyId,
    nonce: record.nonce,
    ciphertext: record.ciphertext,
    associatedData: oauthAppAssociatedData({
      clientInstanceId: deps.clientInstanceId,
      server: record.server,
      clientId: record.clientId,
      version: record.version
    })
  });
}

/**
 * The secret of the app a Connection with these endpoints uses, or nothing where the instance
 * has no app for its server or the app has another client id. A managed client (MS-APP-1) uses
 * none. `secret_unreadable` where the configured keys do not open it.
 */
export async function oauthAppSecretFor(
  deps: OAuthAppDeps,
  endpoints: ConnectorOAuthEndpoints
): Promise<string | undefined> {
  if (endpoints.managedClient !== undefined) return undefined;
  const record = await deps.store.getOAuthApp({
    clientInstanceId: deps.clientInstanceId,
    server: connectionOAuthServerOf(endpoints)
  });
  if (record?.clientId !== endpoints.clientId) return undefined;
  const opened = openApp(deps, record);
  if (opened === undefined) {
    throw new AppError(
      "CONFLICT",
      `${CREDENTIAL_REFUSALS.unreadable}: the instance's OAuth app cannot be opened with the configured keys`,
      { reason: CREDENTIAL_REFUSALS.unreadable }
    );
  }
  try {
    return opened.toString("utf8");
  } finally {
    opened.fill(0);
  }
}

/** Whether `value` is the app's secret, compared in constant time. */
export function sameSecret(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Sets or replaces the app of the endpoints' server over the version the writer saw (`null`
 * for none). A write that lost against another answers `secret_write_conflict` and stores
 * nothing.
 */
export async function putOAuthApp(
  deps: OAuthAppDeps,
  input: {
    endpoints: ConnectorOAuthEndpoints;
    service: string | undefined;
    value: string;
    expectedVersion: number | null;
  }
): Promise<OAuthAppView> {
  const server = connectionOAuthServerOf(input.endpoints);
  const plaintext = Buffer.from(input.value, "utf8");
  try {
    if (plaintext.length === 0 || plaintext.length > SECRET_VALUE_MAX_BYTES) {
      throw new AppError(
        "VALIDATION_FAILED",
        `A secret is between 1 and ${SECRET_VALUE_MAX_BYTES} bytes (SECRET_VALUE_MAX_BYTES)`
      );
    }
    const stored = await deps.store.getOAuthApp({
      clientInstanceId: deps.clientInstanceId,
      server
    });
    if ((stored?.version ?? null) !== input.expectedVersion) throw conflict();
    const version = (stored?.version ?? 0) + 1;
    const { clientId } = input.endpoints;
    const sealed = deps.keyring.seal({
      plaintext,
      associatedData: oauthAppAssociatedData({
        clientInstanceId: deps.clientInstanceId,
        server,
        clientId,
        version
      })
    });
    const written = await deps.store.putOAuthApp({
      clientInstanceId: deps.clientInstanceId,
      server,
      ...(input.service === undefined ? {} : { service: input.service }),
      clientId,
      version,
      keyId: sealed.keyId,
      nonce: sealed.nonce,
      ciphertext: sealed.ciphertext
    });
    if (!written) throw conflict();
    return {
      ...(input.service === undefined ? {} : { service: input.service }),
      clientId,
      version
    };
  } finally {
    plaintext.fill(0);
  }
}

/** The app of each server the instance has one for, by server. Public values only. */
export async function oauthAppsByServer(
  deps: Pick<OAuthAppDeps, "clientInstanceId" | "store">
): Promise<Map<string, OAuthAppView>> {
  const records = await deps.store.listOAuthApps({ clientInstanceId: deps.clientInstanceId });
  return new Map(
    records.map((record) => [
      record.server,
      {
        ...(record.service === undefined ? {} : { service: record.service }),
        clientId: record.clientId,
        version: record.version
      }
    ])
  );
}

function conflict(): AppError {
  return new AppError(
    "CONFLICT",
    `${SECRET_WRITE_CONFLICT}: the instance's OAuth app was changed by somebody else since it was read. Nothing was stored; read it again`,
    { reason: SECRET_WRITE_CONFLICT }
  );
}
