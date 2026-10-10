export { PostgresExecutorError, type PostgresExecutorErrorKind } from "./executor/errors";
export {
  createPostgresExecutor,
  type CreatePostgresExecutorInput,
  type PostgresDescribeInput,
  type PostgresExecutor,
  type PostgresQueryInput,
  type PostgresQueryResult,
  type PostgresTarget
} from "./executor/executor";
export type {
  PostgresDescribeResult,
  PostgresRelationDescription,
  PostgresRelationSummary
} from "./executor/describe";
export {
  POSTGRES_DEADLINE_GRACE_MS,
  POSTGRES_PARAMETERS_MAX_COUNT,
  POSTGRES_POOL_ACQUIRE_WAIT_MS,
  POSTGRES_POOL_IDLE_CLOSE_SECONDS,
  POSTGRES_POOL_MAX_CONNECTIONS,
  POSTGRES_PRIVILEGE_OBJECTS_MAX_LISTED,
  POSTGRES_QUERY_TEXT_MAX_CHARS,
  POSTGRES_READ_MARGIN_BYTES,
  POSTGRES_RESULT_MAX_BYTES,
  POSTGRES_RESULT_MAX_ROWS,
  POSTGRES_STATEMENT_TIMEOUT_MS,
  type PostgresLimits
} from "./executor/limits";
export type {
  PostgresParameter,
  PostgresParameterType,
  PostgresScalar
} from "./executor/parameters";
export type {
  PostgresPrivileges,
  PostgresWritableObject,
  PostgresWritePrivilege
} from "./executor/privileges";
export {
  planPostgresSocket,
  type PinnedPostgresAddress,
  type PinPostgresAddress,
  type PostgresLocation,
  type PostgresSocketPlan
} from "./executor/socket";
