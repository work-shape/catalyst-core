import type { HttpRuntime, Logger } from "@vivd-catalyst/core";
import { registerApprovalRequestRoutes } from "./routes/approval-request-routes";
import { createAuthorizer, normalizeAllowedOrigins } from "@vivd-catalyst/core";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import { installErrorHandler } from "./errors";
import { rememberFramework } from "./http/framework";
import { createInProcessRateLimiter } from "./http/rate-limit";
import { createRoute, type ChatServerExtensions } from "./http/route";

export type {
  ChatServerExtensions,
  ModuleRoutes,
  ResourceOperationBinding,
  ResourceOperationTarget,
  RouteRegistration
} from "./http/route";
export {
  createWorkflowLiveCheck,
  requireWorkflowRunAs,
  type WorkflowRunAsOptions
} from "./workflow-run-as";
import { createHttpRuntime } from "./http/runtime";
import { registerAuditRoutes } from "./routes/audit-routes";
import { registerOperationRunRoutes } from "./routes/operation-run-routes";
import { registerJobRoutes } from "./routes/job-routes";
import { registerInfrastructureRoutes } from "./routes/infrastructure-routes";
import { registerApiAccessAdministrationRoutes } from "./routes/api-access-administration-routes";
import { registerAccessRoutes } from "./routes/access-routes";
import { registerAgentRunRoutes } from "./routes/agent-run-routes";
import { registerApiReferenceRoutes } from "./routes/api-reference-routes";
import { registerBetterAuthRoutes } from "./routes/better-auth-routes";
import { registerDevMailRoutes } from "./routes/dev-mail-routes";
import { registerConfigRoutes } from "./routes/config-routes";
import { registerPlatformRoutes } from "./routes/platform-routes";
import { registerViewRuntimeRoutes } from "./routes/view-runtime-routes";
import { registerViewShellRoutes } from "./routes/view-shell-routes";
import {
  createFrameworkErrorHandler,
  installAppContentBoundary,
  registerPageRoutes
} from "./routes/page-routes";
import { registerCollaborationWorkspaceRoutes } from "./routes/collaboration-workspace-routes";
import { registerAppRoutes } from "./routes/app-routes";
import { registerAssetRoutes } from "./routes/asset-routes";
import { registerConnectionRoutes } from "./routes/connection-routes";
import { registerConversationFileRoutes } from "./routes/conversation-file-routes";
import { registerConversationResourceRoutes } from "./routes/conversation-resource-routes";
import { registerConversationRoutes } from "./routes/conversation-routes";
import { registerDraftAttachmentRoutes } from "./routes/draft-attachment-routes";
import { registerSessionTokenRoutes } from "./routes/session-token-routes";
import { registerServiceAccessTokenRoutes } from "./routes/service-access-token-routes";
import { registerSuperadminRoutes } from "./routes/superadmin-routes";
import { registerUserAccountRoutes } from "./routes/user-account-routes";
import { createOperationCalls } from "./operations/operation-calls";
import type { ChatServerOptions, ResolvedChatServerOptions } from "./types";

export type {
  ChatAttachmentService,
  UploadDraftAttachmentInput,
  UploadDraftAttachmentResult
} from "./attachments";
export type { ConversationCleanupRetrySummary } from "./conversation-cleanup";
export type { ConversationRetentionRunSummary, OrphanedFileCleanupSummary } from "./retention";
export { ConversationRetentionWorkflow } from "./retention";
export { createChatServerJobs } from "./jobs";
export { createOperationCalls };
export {
  APP_ACTION_LIST_MAX_APPS,
  APP_ACTION_TOOL_DESCRIPTION_MAX_CHARS,
  APP_ACTION_TOOL_MAX_APPS,
  combineDataToolSources,
  createAppActionOperationSource,
  createAppActionToolSource
} from "./apps/action-source";
export { createAuditingEventEmitter } from "./operations/event-emitter";
export type { OperationCallsOptions } from "./operations/operation-calls";
export {
  HELD_OPERATION_CALLS_PER_ACTOR,
  HELD_OPERATION_CALLS_PER_INSTANCE,
  HELD_OPERATION_INPUT_MAX_BYTES
} from "./operation-call-approval-handler";
export type { ChatServerJobOptions, ChatServerJobs } from "./jobs";
export {
  DELETION_MAX_ATTEMPTS,
  INFRASTRUCTURE_CHECK_INTERVAL_MS,
  checkInfrastructureJob,
  checkSandboxJob,
  checkSandboxSchedule,
  cleanUpExecutionWorkspacesJob,
  deleteAccountJob,
  deleteWorkspaceJob,
  expireConversationsJob,
  generateConversationTitleJob,
  pruneAuditEventsJob,
  pruneJobsJob
} from "./job-kinds";
export {
  INFRASTRUCTURE_CHECK_NOW_MIN_INTERVAL_MS,
  InfrastructureWorkflow,
  logProviderCheckChange
} from "./infrastructure-workflow";
export type { InfrastructureEntry } from "./infrastructure-workflow";
export {
  ExecutionWorkspaceCleanupWorkflow,
  cleanupExecutionWorkspaceForConversation
} from "./workspace-cleanup";
export type { ExecutionWorkspaceCleanupRunSummary } from "./workspace-cleanup";
export type {
  ChatServerOptions,
  OperationCalls,
  ConversationRetentionOptions,
  ExecutionWorkspaceCleanupJobOptions
} from "./types";
export { appKitFilesOf, loadAppKitFiles } from "./app-kit-runtime";
export { loadViewRuntimeFiles } from "./view-runtime";
import { holdsAppContentToken } from "./app-content";
export {
  APP_CONTENT_TOKEN_TTL_SECONDS,
  APP_CONTENT_VIEWER_CHECK_MAX_ENTRIES,
  APP_CONTENT_VIEWER_CHECK_SECONDS,
  createAppContentViewerChecks,
  deriveAppContentKey
} from "./app-content";
export { storePageFileSet } from "./page-file-sets";
export {
  APP_BUILD_WAIT_MS,
  createPageBuildClient,
  createPageBundleJobs,
  PAGE_BUILD_BUSY_MESSAGE,
  PAGE_BUILD_NO_WORKER_MESSAGE,
  PAGE_BUILD_POLL_INTERVAL_MS,
  PAGE_BUILD_WAIT_MS,
  PAGE_BUNDLE_DEFAULT_SLOTS,
  PAGE_BUNDLE_HEARTBEAT_MS,
  PAGE_BUNDLE_LEASE_MS,
  pageBundleJob,
  type PageBuildClientOptions,
  type PageBundleJobsOptions
} from "./page-jobs";
export {
  createSandboxPageBuild,
  PAGE_BUILD_STALE_MS,
  PAGE_BUILD_SWEEP_INTERVAL_MS,
  removeStalePageBuilds,
  type PageBuildRunner,
  type SandboxPageBuildInput,
  type SandboxPageBuildOptions
} from "./page-build-sandbox";
export {
  ASSET_REPO_COMMAND_TIMEOUT_MS,
  createSandboxAssetRepo,
  type AssetRepoCommitInput,
  type AssetRepoCommitOutcome,
  type AssetRepoCommitRunner,
  type SandboxAssetRepoOptions
} from "./asset-repo-sandbox";
export {
  ASSET_REPO_COMMIT_WAIT_MS,
  ASSET_REPO_SAVE_MAX_AGE_MS,
  ASSET_REPO_SWEEP_INTERVAL_MS,
  assetRepoCommitJob,
  assetRepoSweepJob,
  assetRepoSweepSchedule,
  createAssetRepoCommitClient,
  createAssetRepoJobs,
  type AssetRepoCommitClient,
  type AssetRepoCommitClientOptions,
  type AssetRepoJobsOptions
} from "./asset-repo-jobs";
export type { PageFileInput, StorePageFileSetInput } from "./page-file-sets";
export { createInProcessRateLimiter } from "./http/rate-limit";
export { createHttpRuntime } from "./http/runtime";
export type { InProcessHttpServer } from "./http/runtime";

export async function createChatServer(
  input: ChatServerOptions,
  extensions: ChatServerExtensions = {}
): Promise<HttpRuntime> {
  const allowedOrigins = normalizeAllowedOrigins(input.allowedOrigins);
  const authorizer = input.authorizer ?? createAuthorizer(input.stores.access);
  const operationCalls = input.operationCalls ?? createOperationCalls({ ...input, authorizer });
  const options: ResolvedChatServerOptions = {
    ...input,
    allowedOrigins,
    rateLimiter: input.rateLimiter ?? createInProcessRateLimiter(),
    authorizer,
    operationCalls,
    // The kind a waiting call is decided on is one of the instance's approval kinds.
    approvalRequests: input.approvalRequests && {
      ...input.approvalRequests,
      handlers: operationCalls.approvalRequestHandlers
    }
  };
  const app = Fastify({
    loggerInstance: adaptLogger(options.logger),
    // Assumes the API is reachable only through a reverse proxy on a private network (the
    // Compose network). X-Forwarded-For is honoured only when the direct peer is a loopback or
    // private address, so a public peer cannot choose its own request.ip.
    trustProxy: ["loopback", "uniquelocal"],
    // The address of a Page file holds the token that authorizes the request, and the
    // framework's request lines hold the address. So these requests are not logged.
    disableRequestLogging: holdsAppContentToken,
    // An address the framework cannot read is answered without repeating it.
    frameworkErrors: createFrameworkErrorHandler(allowedOrigins)
  });
  // Before every other hook, so that an answer one of them gives carries the header set too.
  installAppContentBoundary(app, allowedOrigins);

  await app.register(cors, {
    origin: allowedOrigins,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
    allowedHeaders: [
      "authorization",
      "content-type",
      "idempotency-key",
      "x-correlation-id",
      "x-server-credential"
    ],
    // A browser on another origin reads these of an operation's answer.
    exposedHeaders: ["operation-run-id", "idempotent-replayed", "location"]
  });
  await app.register(multipart, {
    limits: {
      fileSize: options.attachments?.maxFileBytes
    }
  });

  installErrorHandler(app);
  registerBetterAuthRoutes(app, options);
  const route = createRoute(app, options);
  registerDevMailRoutes(route, options);
  registerSessionTokenRoutes(route, options);
  registerServiceAccessTokenRoutes(route, options);
  registerAgentRunRoutes(route, options, app.log);
  registerConfigRoutes(route, options);
  registerPlatformRoutes(route, options);
  registerViewRuntimeRoutes(route);
  registerViewShellRoutes(route, options);
  registerPageRoutes(route, options);
  registerCollaborationWorkspaceRoutes(route, options);
  registerAssetRoutes(route, options);
  registerAppRoutes(route, options);
  registerConnectionRoutes(route, options);
  registerApprovalRequestRoutes(route, options);
  registerUserAccountRoutes(route, options);
  registerConversationRoutes(route, options);
  registerConversationResourceRoutes(route, options);
  registerConversationFileRoutes(route, options);
  registerDraftAttachmentRoutes(route, options);
  registerAuditRoutes(route, options);
  registerOperationRunRoutes(route, options);
  registerJobRoutes(route, options);
  registerInfrastructureRoutes(route, options);
  registerApiAccessAdministrationRoutes(route, options);
  registerSuperadminRoutes(route, options);
  registerAccessRoutes(route, options);
  for (const register of extensions.routes ?? []) register(route);
  registerApiReferenceRoutes(route, options);

  const runtime = createHttpRuntime(app);
  rememberFramework(runtime, { app, route });
  return runtime;
}

export { ApprovalCheckRunner } from "./approval-check-runner";
export type { ApprovalCheckRunnerOptions } from "./approval-check-runner";

export { ApprovalRequestWorkflow } from "./approval-request-workflow";
export type {
  ApprovalRequestWorkflowOptions,
  ApprovalRequestView
} from "./approval-request-workflow";

export * from "./skill-change-approval-handler";
export { applyValidatedConfigAssetMutations } from "./config-asset-writer";
export type { ConfigAssetWriterOptions } from "./config-asset-writer";
export { createAgentAssetKind } from "./asset-kinds/agent";
export type { AgentAssetKindOptions } from "./asset-kinds/agent";
export { createSkillAssetKind } from "./asset-kinds/skill";
export {
  APP_ACTIONS,
  APP_ASSET_KIND,
  APP_NAME_MAX_LENGTH,
  APP_NAME_PATTERN,
  APP_TITLE_MAX_CHARS,
  appConfigOf,
  createAppAssetKind
} from "./apps/app-kind";
export { ASSET_PUT_BODY_LIMIT_BYTES } from "./asset-files";
export { createConnectionAssetKind } from "./asset-kinds/connection";
export type { ConnectionAssetKindOptions } from "./asset-kinds/connection";
export type {
  ConnectionDiscoveryOutcome,
  ConnectionManagementPort
} from "./connection-management-port";
export { enqueueConnectionDiscovery } from "./connection-jobs";
export type { WorkflowListEntry, WorkflowRunsPort } from "./workflow-runs-port";
export { createWorkflowRoutes } from "./routes/workflow-routes";
export type { ConfigAssetValidationRefs, WorkflowAssetKind } from "./asset-kinds/shared";

function adaptLogger(logger: Logger): FastifyInstance["log"] {
  return {
    level: "debug",
    debug: (input: unknown, message?: string) => logger.debug(input, message),
    info: (input: unknown, message?: string) => logger.info(input, message),
    warn: (input: unknown, message?: string) => logger.warn(input, message),
    error: (input: unknown, message?: string) => logger.error(input, message),
    fatal: (input: unknown, message?: string) => logger.error(input, message),
    trace: (input: unknown, message?: string) => logger.debug(input, message),
    silent: () => {},
    child: (bindings: Record<string, unknown>) => adaptLogger(logger.child(bindings))
  };
}
