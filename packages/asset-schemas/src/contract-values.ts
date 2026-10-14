/**
 * The values the HTTP contract of an instance is written with: scopes, actions, error codes
 * and the limits a request is checked against. They hold no behaviour. The private packages
 * of the platform read them from here, so that the contract and what enforces it cannot
 * drift apart.
 */

export const AUTH_SCOPE_WILDCARD = "*" as const;

export const CHAT_SESSION_AUTH_SCOPES = [
  "me:read",
  "me:delete",
  "config:read",
  "conversation:read",
  "conversation:write",
  "run:start",
  "run:observe",
  "run:cancel",
  "run:command"
] as const;

export const FIRST_PARTY_AUTH_SCOPES = [
  AUTH_SCOPE_WILDCARD,
  ...CHAT_SESSION_AUTH_SCOPES,
  "collaboration_workspace:read",
  "collaboration_workspace:manage",
  "me:write",
  "governance:read",
  "governance:write",
  "user_admin:read",
  "user_admin:write",
  "api_access:read",
  "api_access:write",
  "config_assets:read",
  "config_assets:write",
  // Moving the published pointer of an asset. A credential that writes drafts with
  // `config_assets:write` publishes none of them without this one.
  "config_assets:publish",
  "config_assets:release",
  // The rows of a Data Store: reading them, and adding or loading them. The definition of a
  // store and its migrations stay under `config_assets:*`. A scope caps what a key may be
  // used for; whether its holder may do it is decided by the grants.
  "data_store_rows:read",
  "data_store_rows:write"
] as const;

export type ChatSessionAuthScope = (typeof CHAT_SESSION_AUTH_SCOPES)[number];
export type FirstPartyAuthScope = (typeof FIRST_PARTY_AUTH_SCOPES)[number];
export type OperationScope = Exclude<FirstPartyAuthScope, "*">;

export const ACTIONS = [
  "agent.read",
  "agent.write",
  "agent.delete",
  "skill.read",
  "skill.write",
  "skill.delete",
  "skill.approve",
  "connection.read",
  "connection.use",
  "connection.write",
  "connection.delete",
  "connection.approve",
  "app.read",
  "app.write",
  "app.publish",
  "app.approve",
  "app.delete",
  "app.use",
  "workflow.read",
  "workflow.write",
  "workflow.publish",
  "workflow.approve",
  "workflow.delete",
  "workflow.use",
  "workflow.read_run_data",
  "data_store.read",
  "data_store.write",
  "data_store.publish",
  "data_store.delete",
  "data_store.insert",
  "data_store.execute",
  "knowledge_base.read",
  "knowledge_base.write",
  "knowledge_base.publish",
  "knowledge_base.delete",
  "knowledge_base.use",
  "guardrail.read",
  "guardrail.write",
  "guardrail.publish",
  "guardrail.delete",
  "operations.approve",
  "users.manage",
  "usage.view",
  "audit.view",
  "api_access.manage",
  "agent_models.manage",
  "assets.release"
] as const;

export type PlatformAction = (typeof ACTIONS)[number];

/** A Namespace prefix: lowercase words joined by single hyphens, ending in one hyphen. */
export const NAMESPACE_PREFIX_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*-$/u;
export const NAMESPACE_PREFIX_MIN_LENGTH = 2;
export const NAMESPACE_PREFIX_MAX_LENGTH = 32;

export type AppErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "REVISION_CONFLICT"
  | "PRECONDITION_REQUIRED"
  | "TIMEOUT"
  | "VALIDATION_FAILED"
  | "RATE_LIMITED"
  | "POLICY_DENIED"
  | "GUARDRAIL_BLOCKED"
  | "DECLINED"
  | "IDEMPOTENCY_KEY_REUSED"
  | "OPERATION_IN_PROGRESS"
  | "OPERATION_EXPIRED"
  | "OUTPUT_NOT_RETAINED"
  | "INTERNAL";

/** The HTTP status every error code answers with. */
export const APP_ERROR_STATUS_CODES: Record<AppErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  REVISION_CONFLICT: 412,
  PRECONDITION_REQUIRED: 428,
  TIMEOUT: 504,
  VALIDATION_FAILED: 422,
  RATE_LIMITED: 429,
  POLICY_DENIED: 403,
  GUARDRAIL_BLOCKED: 403,
  DECLINED: 403,
  IDEMPOTENCY_KEY_REUSED: 409,
  OPERATION_IN_PROGRESS: 409,
  OPERATION_EXPIRED: 409,
  OUTPUT_NOT_RETAINED: 409,
  INTERNAL: 500
};

export type OperationEffect = "reading" | "changing";

/**
 * The longest `Idempotency-Key` a caller may send, in characters. It protects the index the
 * key is looked up in. A longer key is refused with VALIDATION_FAILED naming this limit.
 */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

/** What an instance takes from outside its own processes. A closed list. */
export const PROVIDER_PORTS = ["models", "mail", "objectStorage", "sandbox", "secrets"] as const;
export type ProviderPort = (typeof PROVIDER_PORTS)[number];

/**
 * Where a provider processes the data an instance sends it. Product-owned and closed: a vendor's
 * own region name is a separate field of its adapter, such as `bucketRegion`.
 */
export const PROVIDER_REGIONS = ["eu", "global"] as const;
export type ProviderRegion = (typeof PROVIDER_REGIONS)[number];

/**
 * Why a check failed. Product-owned and closed: it is all of a failure that reaches a log, the
 * API or a page, so a provider's own error text, which can repeat a key or an address, cannot.
 */
export const PROVIDER_CHECK_ERROR_CLASSES = [
  "unreachable",
  "timeout",
  "access_denied",
  "not_found",
  // The bucket an object store is configured with does not exist. The check creates none.
  "bucket_missing",
  "rejected",
  "failed"
] as const;
export type ProviderCheckErrorClass = (typeof PROVIDER_CHECK_ERROR_CLASSES)[number];

/**
 * The immutable machine name. It is part of every operation name of the Connection
 * (`connection.<name>.<operation>`), so it holds no dot. A Namespace prefix fits in front.
 */
export const CONNECTION_NAME_PATTERN = /^[a-z][a-z0-9]*([_-][a-z0-9]+)*$/u;
export const CONNECTION_NAME_MAX_LENGTH = 64;

/**
 * The immutable machine name of a Guardrail. An approval request keeps it as the id of the
 * check that answered, and its hits are kept under it.
 */
export const GUARDRAIL_NAME_PATTERN = /^[a-z][a-z0-9]*([_-][a-z0-9]+)*$/u;
export const GUARDRAIL_NAME_MAX_LENGTH = 64;

/**
 * Who may call an accepted operation. An operation exposed to nobody is callable by nobody.
 * `outside` admits the CLI and the platform MCP server, a caller with an API credential whose
 * results leave the instance; no operation has it unless an admin turns it on.
 */
export const CONNECTION_EXPOSURES = ["agent", "bridge", "workflow", "outside"] as const;
export type ConnectionExposure = (typeof CONNECTION_EXPOSURES)[number];

/** The health of a Connection as its page and its list show it. */
export const CONNECTION_HEALTH_STATES = [
  "unknown",
  "ok",
  "failed",
  "needs_configuration",
  "secret_unreadable"
] as const;
export type ConnectionHealth = (typeof CONNECTION_HEALTH_STATES)[number];
