import type { AssetKindSchema, AssetValidationIssue } from "./asset-kinds";
import { AppError } from "./errors";
import { createPlatformId } from "./ids";
import type { JsonObject, JsonValue } from "./json";

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

/**
 * The immutable machine name. It is part of every operation name of the Connection
 * (`connection.<name>.<operation>`), so it holds no dot. A Namespace prefix fits in front.
 */
export const CONNECTION_NAME_PATTERN = /^[a-z][a-z0-9]*([_-][a-z0-9]+)*$/u;
export const CONNECTION_NAME_MAX_LENGTH = 64;
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

/** What an operation does to the outside system. A hint of that system never decides it. */
export type ConnectionOperationEffect = "reading" | "changing";

/** Who may call an accepted operation. An operation exposed to nobody is callable by nobody. */
export const CONNECTION_EXPOSURES = ["agent", "bridge", "workflow"] as const;
export type ConnectionExposure = (typeof CONNECTION_EXPOSURES)[number];

/**
 * The stricter policy an operation may carry. It only tightens: `deny` on any operation,
 * `approval` on a changing one. Loosening is the instance's central setting and never part of
 * a Connection.
 */
export type ConnectionOperationPolicy = "deny" | "approval";

/** `release`: written by the release seed and read-only in the product. */
export type ConnectionOrigin = "release" | "runtime";

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

export interface ConnectionOperationConfig {
  name: string;
  effect: ConnectionOperationEffect;
  exposure: ConnectionExposure[];
  enabled: boolean;
  policy?: ConnectionOperationPolicy;
  /** The fingerprint of the accepted descriptor. A discovery that differs stops the operation. */
  schemaFingerprint?: string;
}

/** A Connection as its revision holds it. It never holds a secret value. */
export interface ConnectionConfig {
  name: string;
  displayName: string;
  description?: string;
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

/**
 * What a Connector type is handed for one test, discovery or call. It holds no credential and
 * no way to one: the credential of the call arrives with the credential resolver port.
 */
export interface ConnectorContext {
  connection: {
    id: string;
    name: string;
    revision: number;
    settings: JsonObject;
    authScheme: string;
  };
  /** Ends when the call is cancelled or its deadline passes. */
  signal: AbortSignal;
}

/** What a test of a Connection comes to. It never carries data of the outside system. */
export type ConnectorTestStatus = "ready" | "unauthorized" | "network_denied" | "unavailable";

interface ConnectorTypeBase {
  /** The id a Connection names as its `connectorType`. */
  type: string;
  description: string;
  /** Reads the `settings` of a Connection of this type. */
  settingsSchema: AssetKindSchema<JsonObject>;
  authSchemes: readonly string[];
  /** The names of the secret fields a credential of this type has, never their values. */
  secretFields: readonly string[];
  /** A bounded check of reachability and authentication. It changes nothing outside. */
  test(context: ConnectorContext): Promise<{ status: ConnectorTestStatus }>;
  execute(operation: string, input: JsonValue, context: ConnectorContext): Promise<JsonValue>;
  limits: ConnectorLimits;
}

/** A Connector type has a catalog the release ships or reads one from the outside system. */
export type ConnectorTypeDefinition = ConnectorTypeBase &
  (
    | { catalog: readonly ConnectorOperationDescriptor[]; discover?: undefined }
    | {
        catalog?: undefined;
        discover(context: ConnectorContext): Promise<readonly ConnectorOperationDescriptor[]>;
      }
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
  runtimeAuthoringUnavailable: "connection_runtime_authoring_unavailable"
} as const;

/**
 * What the Connector type of a Connection refuses it for: a type this build does not ship,
 * settings the type does not read, an auth scheme it does not offer. No issue repeats a value
 * of the settings.
 */
export function findConnectorTypeIssues(
  registry: ConnectorTypeRegistry,
  connection: Pick<ConnectionConfig, "connectorType" | "settings" | "authScheme">
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
  return issues;
}
