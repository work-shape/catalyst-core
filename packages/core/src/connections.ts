import {
  CONNECTION_EXPOSURES,
  CONNECTION_HEALTH_STATES,
  CONNECTION_NAME_MAX_LENGTH,
  CONNECTION_NAME_PATTERN,
  CONNECTION_NETWORKS,
  CONNECTION_OPERATION_POLICIES,
  CONNECTION_ORIGINS,
  CONNECTION_SECRET_STATES,
  CONNECTOR_TEST_STATUSES,
  OPERATION_EFFECTS,
  type ConnectionExposure,
  type ConnectionHealth
} from "@work-shape/catalyst-asset-schemas";
import type { AssetKindSchema, AssetValidationIssue } from "./asset-kinds";
import type { ConnectionBindingsStore } from "./connection-bindings";
import { AppError } from "./errors";
import { createPlatformId, type ClientInstanceId } from "./ids";
import type { JsonObject, JsonValue } from "./json";
import type { OperationLimits, OperationPaging } from "./workflows";

/**
 * A Connection is an asset of kind `connection`: one configured instance of a Connector type,
 * with its settings, its accepted operations and a reference to its credential. A Connector
 * type is code of the release. No asset write installs or changes connector code.
 */
export const CONNECTION_ASSET_KIND = "connection";

/** The rights of the kind. `use` covers the whole Connection and never one operation. */
export const CONNECTION_ACTIONS = {
  read: "connection.read",
  use: "connection.use",
  write: "connection.write",
  delete: "connection.delete",
  approve: "connection.approve"
} as const;

export { CONNECTION_NAME_MAX_LENGTH, CONNECTION_NAME_PATTERN };
export const CONNECTION_NAME_RULE =
  "Connection name must be lowercase words of letters and digits joined by hyphens or underscores";

/** The id of a Connector type, such as `mcp` or `postgres`. */
export const CONNECTOR_TYPE_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/u;

/** The name of one accepted operation. It ends an operation name, so it holds no dot. */
export const CONNECTION_OPERATION_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/u;
export const CONNECTION_OPERATION_NAME_MAX_LENGTH = 64;

/**
 * How many operations one Connection accepts. Each accepted operation of an agent's Connection
 * is sent to the model as a tool on every turn. A longer list is refused when the Connection
 * is validated, naming this constant.
 */
export const CONNECTION_MAX_ACCEPTED_OPERATIONS = 100;

/**
 * The words that make a name of a request's header or parameter one that can carry a
 * credential, compared without case. A REST API's fixed header holding one is refused in its
 * settings; an agent's draft refuses a parameter holding one as a word. A release constant
 * (manager, 2026-10-14).
 */
export const CONNECTION_CREDENTIAL_WORDS = [
  "auth",
  "key",
  "token",
  "secret",
  "password",
  "session"
] as const;

/** What an operation does to the outside system. A hint of that system never decides it. */
export type ConnectionOperationEffect = (typeof OPERATION_EFFECTS)[number];

export { CONNECTION_EXPOSURES, type ConnectionExposure };

/**
 * The stricter policy an operation may carry. It only tightens: `deny` on any operation,
 * `approval` on a changing one. Loosening is the instance's central setting and never part of
 * a Connection.
 */
export type ConnectionOperationPolicy = (typeof CONNECTION_OPERATION_POLICIES)[number];

/** `release`: written by the release seed and read-only in the product. */
export type ConnectionOrigin = (typeof CONNECTION_ORIGINS)[number];

/**
 * The opaque reference to the Connection's credential in the Secret Store. It is not a
 * credential and grants nothing by itself. Only the credential resolver turns it into a value,
 * inside one authorized call.
 */
export type ConnectionSecretHandle = string;

/**
 * The only shape a handle has: the prefix and a random UUID. A revision that carries anything
 * else where the handle belongs, such as a pasted key, is refused by the schema.
 */
export const CONNECTION_SECRET_HANDLE_PATTERN =
  /^secret_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** A new handle. It is random: nothing of the credential or of the Connection is in it. */
export function createConnectionSecretHandle(): ConnectionSecretHandle {
  const handle: string = createPlatformId("secret");
  if (!CONNECTION_SECRET_HANDLE_PATTERN.test(handle)) {
    throw new AppError("INTERNAL", "This runtime cannot create a secret handle");
  }
  return handle;
}

/**
 * One parameter of a declared operation: the JSON schema its value fits, and what it is for.
 * A path parameter is always required; a query parameter where `required` says so.
 */
export interface DeclaredOperationParameter {
  schema: JsonObject;
  description?: string;
  required?: boolean;
}

/** Why `scope` on an operation declaration is refused before SCOPE-2 (SCOPE-0). */
export const CONNECTION_SCOPE_RESERVED =
  "'scope' is reserved: scoped Connection operations arrive with SCOPE-2. Until then an operation that serves one Mandant takes it as a named parameter and returns it on every item";

/**
 * What a Connection declares of an operation itself, for a Connector type with no catalog
 * and no discovery, such as `http_api`. The declaration is the operation's catalog entry:
 * its description is what an agent reads, and its request is what the type sends. A type
 * that does not declare refuses every one of these fields (`CONNECTION_DECLARATION_FIELDS`).
 */
export interface ConnectionOperationDeclaration {
  /** The name in words, as a person reads it in a list. */
  title?: string;
  description?: string;
  /** The HTTP method. */
  method?: string;
  /** A path relative to the Connection's address, with `{param}` placeholders. */
  path?: string;
  pathParams?: Record<string, DeclaredOperationParameter>;
  query?: Record<string, DeclaredOperationParameter>;
}

/** The members of `ConnectionOperationDeclaration`, which only a declaring type reads. */
export const CONNECTION_DECLARATION_FIELDS = [
  "title",
  "description",
  "method",
  "path",
  "pathParams",
  "query"
] as const satisfies readonly (keyof ConnectionOperationDeclaration)[];

export interface ConnectionOperationConfig extends ConnectionOperationDeclaration {
  name: string;
  effect: ConnectionOperationEffect;
  exposure: ConnectionExposure[];
  enabled: boolean;
  policy?: ConnectionOperationPolicy;
  /** The fingerprint of the accepted descriptor. A discovery that differs stops the operation. */
  schemaFingerprint?: string;
  /**
   * The request header that carries the idempotency key of a changing call to the outside
   * system, such as `Idempotency-Key`. Whoever names it says that the outside system carries
   * out one call per key. A call of the operation that was interrupted is then made again
   * under its key; without it such a call is never made a second time.
   */
  idempotencyKeyHeader?: string;
  /**
   * How the outside system pages this reading operation. A Workflow step that names
   * `paginate` takes it. Reserved: the schema of a definition refuses it with
   * `not_supported_yet` until the slice that brings paging reads it.
   */
  paging?: OperationPaging;
  /** The limits of calls toward the outside system. Reserved and refused like `paging`. */
  limits?: OperationLimits;
}

/** The `service` of a Connection: lowercase letters, digits and hyphens, 1 to 40 characters. */
export const CONNECTION_SERVICE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u;

/** A Connection as its revision holds it. It never holds a secret value. */
export interface ConnectionConfig {
  name: string;
  displayName: string;
  description?: string;
  /**
   * The system behind the Connection, such as `accounting-source`, as a slug (`CONNECTION_SERVICE_PATTERN`).
   * It only picks an icon; a slug no icon is registered for shows the generic one. No right,
   * egress rule or behaviour reads it.
   */
  service?: string;
  connectorType: string;
  /** The user or service principal accountable for the Connection. It bypasses no right. */
  ownerPrincipalId: string;
  /** Settings of the Connector type. A credential in them is refused. */
  settings: JsonObject;
  authScheme: string;
  /** One credential for everyone who may use the Connection. */
  credentialMode: "shared";
  secretHandle?: ConnectionSecretHandle;
  operations: ConnectionOperationConfig[];
  enabled: boolean;
  origin: ConnectionOrigin;
}

/** One operation as a Connector type describes it, from a static catalog or a discovery. */
export interface ConnectorOperationDescriptor {
  name: string;
  description: string;
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
  /** What the type or the outside system proposes. The Connection's accepted list decides. */
  proposedEffect: ConnectionOperationEffect;
}

/** The bounds of one Connector type. A refusal names the bound that was reached. */
export interface ConnectorLimits {
  callTimeoutMs: number;
  resultMaxBytes: number;
  /** Calls of one Connection that run side by side in one process. */
  maxParallelCalls: number;
}

/** The transports a Connection may open. Plain `http` only reaches a private target. */
export const EGRESS_PROTOCOLS = ["https", "http", "postgres"] as const;
export type EgressProtocol = (typeof EGRESS_PROTOCOLS)[number];

/**
 * Where a Connection wants to connect. It is protocol, host and port and never an address
 * with a path: a database target has no URL, and a check on text drifts from the connection.
 */
export interface EgressTarget {
  protocol: EgressProtocol;
  host: string;
  port: number;
}

/** A host name as the egress list compares it: lower case, without brackets or a final dot. */
export function normalizeEgressHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/u, "$1")
    .replace(/\.$/u, "");
}

/**
 * The origin of a target as a Connection's secret is bound to it: `protocol://host:port`. A
 * secret set for one origin is sent to that origin only.
 */
export function egressOriginOf(target: EgressTarget): string {
  return `${target.protocol}://${normalizeEgressHost(target.host)}:${target.port}`;
}

/**
 * The release config setting that lets a target no entry names through, as the sentence a
 * refusal ends with: an entry under `egress.allow`, and for `https` on port 443 also
 * `egress.allowPublicHttps`. Plain `http` needs a `private` entry.
 */
export function egressSettingFor(target: EgressTarget): string {
  if (target.protocol === "https" && target.port === 443) {
    return "An operator adds it under 'egress.allow' in release config, or allows every public HTTPS host on port 443 with 'egress.allowPublicHttps: true'";
  }
  if (target.protocol === "http") {
    return "An operator adds it under 'egress.allow' in release config, with 'network: private' and its 'cidrs'";
  }
  return "An operator adds it under 'egress.allow' in release config";
}

/**
 * A target that passed the egress check, with the address that was checked. The connector
 * connects to `address` and nowhere else, and keeps `host` as the TLS and `Host` name.
 */
export interface EgressGrant extends EgressTarget {
  address: string;
  family: 4 | 6;
  /** Whether the operator's list names the target as a private one. */
  network: (typeof CONNECTION_NETWORKS)[number];
}

/**
 * The one check every outbound connection of a Connection passes before it is opened and
 * before a credential is resolved. It throws `egress_denied` with the host and the port. A
 * target that is on the list and whose name does not resolve is refused as well, with
 * `egress_unresolved`: nothing is contacted, and the refusal says the list is not the cause.
 */
export interface EgressChecker {
  check(target: EgressTarget): Promise<EgressGrant>;
  /**
   * Whether the target passes the rules that need no address: the protocol, the operator's
   * list and the Platform Store by name. A save of a Connection asks this, so a write never
   * waits for DNS; every connection still passes `check` before it is opened.
   */
  admits(target: EgressTarget): boolean;
}

/** The reason and the code of a refused target. */
export const EGRESS_DENIED = "egress_denied";

/**
 * The reason of a target that is on the egress list and could not be resolved to an address.
 * It is refused like any other, and a caller is told `connection_unavailable`: the place to
 * look is the outside system or the resolver, not the list.
 */
export const EGRESS_UNRESOLVED = "egress_unresolved";

/** The one subject a shared credential has. A credential per person names that person. */
export const SHARED_CREDENTIAL_SUBJECT = "shared";

/** Which Connection, and whose credential of it, a secret is bound to. */
export interface SecretBinding {
  connectionAssetId: string;
  subject: string;
}

/** Where a stored secret came from. Only a `bootstrap` secret follows the environment. */
export type SecretSource = "bootstrap" | "runtime";

/** What anybody may learn of a secret: whether there is one, and its version. */
export type SecretState = (typeof CONNECTION_SECRET_STATES)[number];

export interface SecretStatus {
  state: SecretState;
  handle?: ConnectionSecretHandle;
  version?: number;
  source?: SecretSource;
}

/**
 * The Secret Store as the product writes to it. It has write, replace, state and delete, and
 * no read: nothing here returns a secret value, to an instance admin as little as to anyone.
 */
export interface SecretStore {
  /**
   * Stores the value for the binding, encrypted, and answers its handle and version. A value
   * equal to the stored one changes nothing and keeps the version. `handle` is the handle a
   * first write takes, for a caller that named it in a revision already; a stored secret
   * keeps the handle it has. `expectedVersion`, where given, is the version the writer saw,
   * `null` for none: a stored version that is another refuses the write with
   * `secret_write_conflict`, decided on the same read the new version follows.
   *
   * `origin` is the origin (`egressOriginOf`) the secret is set for: a Connection's secret is
   * resolved for that origin only. A stored secret of another origin counts as none, and the
   * write replaces it.
   */
  put(input: {
    binding: SecretBinding;
    value: string;
    source: SecretSource;
    handle?: ConnectionSecretHandle;
    expectedVersion?: number | null;
    origin?: string;
  }): Promise<{ handle: ConnectionSecretHandle; version: number; changed: boolean }>;
  status(binding: SecretBinding): Promise<SecretStatus>;
  delete(binding: SecretBinding): Promise<void>;
}

/**
 * What the connector auth component hands a Connector type for one call: the secret, and the
 * headers the Connection's auth scheme makes of it. Neither is ever part of the settings.
 * Read the members one by one: the object handed out and its `headers` answer a fixed
 * redaction to `JSON.stringify`, to the process logger (they carry `LOG_REDACTION`) and to
 * `util.inspect`, and `secret` and `headers` are not enumerable.
 *
 * A connector sets the headers on its request, for which it copies them (`{ ...headers }`).
 * Such a copy, and `secret` or one header read by itself, is plaintext without any mark:
 * hand it to the request and to nothing else. Never log it, never put it into an error, an
 * Operation Run or an answer.
 */
export interface ConnectionCredential {
  scheme: string;
  secret: string;
  /** Request headers that authenticate, such as `authorization`. Empty for other schemes. */
  headers: Readonly<Record<string, string>>;
}

/** A secret write that lost against another write of the same secret. Nothing was stored. */
export const SECRET_WRITE_CONFLICT = "secret_write_conflict";

/** Why a credential is not handed out. No refusal carries a value. */
export const CREDENTIAL_REFUSALS = {
  notConfigured: "connection_not_configured",
  unreadable: "secret_unreadable",
  /** No sign-in binding is connected for the Connection's current origin. */
  notConnected: "connection_not_connected",
  /** The outside system refused the sign-in; someone has to sign in again. */
  needsReconnect: "connection_needs_reconnect"
} as const;

/**
 * The connector auth component: the only code that turns a handle into a value. It is called
 * inside one call, after the caller was authorized and the target passed the egress check,
 * for the one binding of that call. It throws `connection_not_configured` where no secret is
 * stored, or where `origin` is named and the stored secret was set for another origin, and
 * `secret_unreadable` where the configured keys do not open the stored one.
 */
export interface ConnectionCredentialResolver {
  resolve(input: {
    handle: ConnectionSecretHandle;
    binding: SecretBinding;
    /** The origin the call goes to (`egressOriginOf`). A Connection's call always names it. */
    origin?: string;
  }): Promise<string>;
  /**
   * The access token of the Connection's shared sign-in, for a Connection with auth scheme
   * `oauth`. It reads the binding first and opens its token set only where the binding is
   * connected and was made for `origin`. It throws `connection_not_connected` where there is
   * no such binding or token set, `connection_needs_reconnect` where the outside system
   * refused the sign-in, and `secret_unreadable` where the token set cannot be opened. It
   * never falls back to the Connection's own secret.
   */
  resolveSignIn(input: { connectionAssetId: string; origin: string }): Promise<string>;
}

export { CONNECTION_HEALTH_STATES, type ConnectionHealth };

/** Runtime state of one Connection. It has no revision and holds no secret. */
export interface ConnectionStateRecord {
  connectionAssetId: string;
  clientInstanceId: ClientInstanceId;
  health: ConnectionHealth;
  lastTestedAt?: string;
  lastErrorCode?: string;
  /** What the last discovery read from the outside system. Untrusted data. */
  catalog?: JsonValue;
  /**
   * The OAuth client registered for the Connection by Dynamic Client Registration: issuer,
   * client id, auth method, time, origin and redirect URI. Never a client secret.
   */
  oauthClient?: JsonValue;
  updatedAt: string;
}

/** One stored secret as the database holds it: ciphertext and what is needed to open it. */
export interface StoredSecretRecord {
  handle: ConnectionSecretHandle;
  clientInstanceId: ClientInstanceId;
  connectionAssetId: string;
  subject: string;
  version: number;
  /** The id of the key of `secretStore.keys` that encrypted the row. */
  keyId: string;
  nonce: Uint8Array;
  /** The ciphertext followed by the authentication tag. */
  ciphertext: Uint8Array;
  source: SecretSource;
  /**
   * The origin the secret was set for (`egressOriginOf`), bound into its associated data.
   * Absent for a secret of no origin, such as a data store's password.
   */
  origin?: string;
}

/**
 * The rows behind Connections: stored secrets, runtime state and sign-in bindings. No method
 * returns a value.
 */
export interface ConnectionsStore extends ConnectionBindingsStore {
  /**
   * Takes the lock of the release seed for this instance and holds it until the surrounding
   * transaction ends. A second process that seeds waits here and then reads what the first
   * one wrote.
   */
  lockReleaseSeed(input: { clientInstanceId: ClientInstanceId }): Promise<void>;
  getSecret(input: {
    clientInstanceId: ClientInstanceId;
    handle: ConnectionSecretHandle;
  }): Promise<StoredSecretRecord | undefined>;
  findSecret(input: {
    clientInstanceId: ClientInstanceId;
    binding: SecretBinding;
  }): Promise<StoredSecretRecord | undefined>;
  /**
   * Inserts version 1, or replaces the row of the same Connection and subject with the
   * version that follows the stored one, in one statement. Answers `false` and writes
   * nothing where the stored version is another, where a version above 1 finds no row, or
   * where a `bootstrap` record would replace a `runtime` one: somebody else wrote in between,
   * and a secret set on the instance is never replaced from the environment.
   */
  putSecret(record: StoredSecretRecord): Promise<boolean>;
  deleteSecrets(input: {
    clientInstanceId: ClientInstanceId;
    connectionAssetId: string;
    /** Only this subject's secret. Left out, every secret of the Connection. */
    subject?: string;
    /** Only a secret of this source, so a delete never takes one that was set meanwhile. */
    source?: SecretSource;
  }): Promise<void>;
  getConnectionState(input: {
    clientInstanceId: ClientInstanceId;
    connectionAssetId: string;
  }): Promise<ConnectionStateRecord | undefined>;
  /** The state of every Connection of the instance, in one read. */
  listConnectionStates(input: {
    clientInstanceId: ClientInstanceId;
  }): Promise<ConnectionStateRecord[]>;
  /** Writes the health. Test time, error code and catalog stay unless they are named. */
  putConnectionState(input: {
    clientInstanceId: ClientInstanceId;
    connectionAssetId: string;
    health: ConnectionHealth;
    lastTestedAt?: string;
    lastErrorCode?: string | null;
    catalog?: JsonValue;
  }): Promise<void>;
  /**
   * Writes the registered OAuth client of the Connection, or removes it with `null`. Health,
   * test time, error code and catalog stay; a Connection without a state row gets one of
   * health `needs_configuration`.
   */
  putConnectionOAuthClient(input: {
    clientInstanceId: ClientInstanceId;
    connectionAssetId: string;
    oauthClient: JsonValue | null;
  }): Promise<void>;
  deleteConnectionState(input: {
    clientInstanceId: ClientInstanceId;
    connectionAssetId: string;
  }): Promise<void>;
}

/**
 * What a Connector type is handed for one test, discovery or call. It exists only once the
 * Connection's target passed the egress check, and it is the one way to the credential of
 * the call.
 */
export interface ConnectorContext {
  connection: {
    id: string;
    name: string;
    revision: number;
    settings: JsonObject;
    authScheme: string;
    /** The accepted operations, with the declaration of each where its type declares them. */
    operations: readonly ConnectionOperationConfig[];
  };
  /** The checked target. The connector connects to `target.address`. */
  target: EgressGrant;
  /**
   * Checks a further target of this call, such as a redirect or a returned download address.
   * A connector follows no redirect by itself: it asks here first.
   */
  checkEgress(target: EgressTarget): Promise<EgressGrant>;
  /**
   * The credential of this call, for a checked target. It is refused for any target that is
   * not the origin the Connection was configured for, so a redirect never carries it away.
   * `undefined` for a Connection without authentication.
   */
  credentialFor(target: EgressGrant): ConnectionCredential | undefined;
  /**
   * The idempotency key of a changing call and the request header the operation's entry names
   * for it. A type that sets `carriesIdempotencyKey` sends it with the call, to the origin the
   * Connection was configured for and to no other.
   */
  idempotencyKey?: { header: string; value: string };
  /** Ends when the call is cancelled or its deadline passes. */
  signal: AbortSignal;
}

/** What a test of a Connection comes to. It never carries data of the outside system. */
export type ConnectorTestStatus = (typeof CONNECTOR_TEST_STATUSES)[number];

/** What a server asks for when it refuses a call without a sign-in. Untrusted. */
export interface ConnectorSignInChallenge {
  /** Where the server's protected resource metadata is (RFC 9728). */
  resourceMetadataUrl?: string;
  /** The scopes the server names. */
  scopes?: readonly string[];
}

/**
 * The part of an OAuth sign-in (CS-4b) that only the Connector type knows. A type that has it
 * offers the auth scheme `oauth`; the flow itself is the platform's.
 */
export interface ConnectorSignIn {
  /** The protected resource the sign-in is for, read from settings its schema accepted. */
  resourceUrl(settings: JsonObject): string;
  /** The Connection's OAuth settings: a pre-registered client id and the scopes chosen. */
  oauthSettings(settings: JsonObject): { clientId?: string; scopes?: readonly string[] };
  /**
   * Asks the server at the checked target, sending no credential, which sign-in it wants.
   * Nothing where it names none or cannot be asked.
   */
  challenge(input: {
    target: EgressGrant;
    settings: JsonObject;
    signal: AbortSignal;
  }): Promise<ConnectorSignInChallenge | undefined>;
}

interface ConnectorTypeBase {
  /** The id a Connection names as its `connectorType`. */
  type: string;
  description: string;
  /** Reads the `settings` of a Connection of this type. */
  settingsSchema: AssetKindSchema<JsonObject>;
  authSchemes: readonly string[];
  /** The names of the secret fields a credential of this type has, never their values. */
  secretFields: readonly string[];
  /**
   * Where a Connection of this type connects, read from settings its schema accepted. The
   * platform checks it before the type is handed a context.
   */
  target(settings: JsonObject): EgressTarget;
  /**
   * The request header that carries the secret under the auth scheme `header`. It is a name
   * of the type's typed settings; the value is never a setting.
   */
  credentialHeaderName?(settings: JsonObject): string | undefined;
  /**
   * The type sends `idempotencyKey` of its context with a call. Only an operation of such a
   * type is called again under the key of an interrupted call.
   */
  carriesIdempotencyKey?: true;
  /** The type's part of an OAuth sign-in, where it offers the auth scheme `oauth`. */
  signIn?: ConnectorSignIn;
  /** A bounded check of reachability and authentication. It changes nothing outside. */
  test(context: ConnectorContext): Promise<{ status: ConnectorTestStatus }>;
  execute(operation: string, input: JsonValue, context: ConnectorContext): Promise<JsonValue>;
  limits: ConnectorLimits;
}

/**
 * How a declaring type reads the operations a Connection declares. Both are pure: a save asks
 * `issues`, and only an operation without one is described.
 */
export interface DeclaredOperations {
  /** Why one accepted operation's declaration is refused. Paths are inside the operation. */
  issues(operation: ConnectionOperationConfig): AssetValidationIssue[];
  /** The operation as its catalog entry, for a declaration without an issue. */
  describe(operation: ConnectionOperationConfig): ConnectorOperationDescriptor;
}

/**
 * A Connector type has a catalog the release ships, reads one from the outside system, or
 * has each Connection declare its operations itself.
 */
export type ConnectorTypeDefinition = ConnectorTypeBase &
  (
    | {
        catalog: readonly ConnectorOperationDescriptor[];
        discover?: undefined;
        declared?: undefined;
      }
    | {
        catalog?: undefined;
        discover(context: ConnectorContext): Promise<readonly ConnectorOperationDescriptor[]>;
        declared?: undefined;
      }
    | { catalog?: undefined; discover?: undefined; declared: DeclaredOperations }
  );

/** The Connector types of this build. The assembly fills it; nothing adds a type at run time. */
export interface ConnectorTypeRegistry {
  readonly types: readonly ConnectorTypeDefinition[];
  get(type: string): ConnectorTypeDefinition | undefined;
}

/** Refuses a type id that is malformed or registered twice. */
export function createConnectorTypeRegistry(
  definitions: readonly ConnectorTypeDefinition[]
): ConnectorTypeRegistry {
  const byType = new Map<string, ConnectorTypeDefinition>();
  for (const definition of definitions) {
    if (!CONNECTOR_TYPE_PATTERN.test(definition.type)) {
      throw new AppError(
        "VALIDATION_FAILED",
        `Connector type '${definition.type}' must be lowercase words joined by underscores`
      );
    }
    if (byType.has(definition.type)) {
      throw new AppError(
        "VALIDATION_FAILED",
        `Connector type '${definition.type}' is registered more than once`
      );
    }
    byType.set(definition.type, definition);
  }
  const types = Object.freeze([...byType.values()]);
  return Object.freeze({ types, get: (type: string) => byType.get(type) });
}

/** The reasons a Connection is refused for, as the first word of an issue or a `reason`. */
export const CONNECTION_REFUSALS = {
  connectorTypeUnknown: "connector_type_unknown",
  credentialInSettings: "credential_in_settings",
  /** A Connection is written one at a time. A batch of the asset operations holds none yet. */
  batchUnavailable: "connection_batch_unavailable",
  /** A Connection of release config is changed in release config and nowhere else. */
  readOnlyOrigin: "read_only_origin",
  /** An agent carries a tool of the Connection, so it is not deleted. */
  inUse: "connection_in_use",
  /** The Connection's auth scheme sends no credential, so none is stored for it. */
  takesNoSecret: "connection_takes_no_secret",
  /** The instance names no key of the Secret Store, so no secret can be stored. */
  secretStoreUnavailable: "secret_store_unavailable"
} as const;

/**
 * What the type refuses of the accepted operations: a declaration it does not read, or for a
 * declaring type, a declaration it does not accept.
 */
function declarationIssues(
  type: ConnectorTypeDefinition,
  operations: readonly ConnectionOperationConfig[]
): AssetValidationIssue[] {
  return operations.flatMap((operation, index): AssetValidationIssue[] => {
    const at = (issue: AssetValidationIssue): AssetValidationIssue => ({
      ...issue,
      path: ["operations", index, ...(issue.path ?? [])]
    });
    if (type.declared) {
      return type.declared.issues(operation).map(at);
    }
    return CONNECTION_DECLARATION_FIELDS.filter((field) => operation[field] !== undefined).map(
      (field) =>
        at({
          message: `Connector type '${type.type}' reads its operations from the outside system, so an operation declares no '${field}'`,
          path: [field]
        })
    );
  });
}

/**
 * What the Connector type of a Connection refuses it for: a type this build does not ship,
 * settings the type does not read, an auth scheme it does not offer, a declared operation it
 * does not accept. No issue repeats a value of the settings.
 */
export function findConnectorTypeIssues(
  registry: ConnectorTypeRegistry,
  connection: Pick<ConnectionConfig, "connectorType" | "settings" | "authScheme" | "operations">
): AssetValidationIssue[] {
  const type = registry.get(connection.connectorType);
  if (!type) {
    return [
      {
        message: `${CONNECTION_REFUSALS.connectorTypeUnknown}: this instance has no connector type '${connection.connectorType}'`,
        path: ["connectorType"]
      }
    ];
  }
  const issues: AssetValidationIssue[] = [];
  const settings = type.settingsSchema.safeParse(connection.settings);
  if (!settings.success) {
    for (const issue of settings.error.issues) {
      issues.push({ message: issue.message, path: ["settings", ...(issue.path ?? [])] });
    }
  }
  if (!type.authSchemes.includes(connection.authScheme)) {
    issues.push({
      message: `Connector type '${type.type}' offers the auth schemes: ${type.authSchemes.join(", ")}`,
      path: ["authScheme"]
    });
  }
  return [...issues, ...declarationIssues(type, connection.operations)];
}
