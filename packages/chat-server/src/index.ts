import type { HttpRuntime, Logger } from "@vivd-catalyst/core";
import { registerApprovalRequestRoutes } from "./routes/approval-request-routes";
import { createAuthorizer, normalizeAllowedOrigins } from "@vivd-catalyst/core";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import { installErrorHandler } from "./errors";
import { rememberFramework } from "./http/framework";
import { createInProcessRateLimiter } from "./http/rate-limit";
import { createRoute } from "./http/route";
import { createHttpRuntime } from "./http/runtime";
import { registerAuditRoutes } from "./routes/audit-routes";
import { registerOperationRunRoutes } from "./routes/operation-run-routes";
import { registerJobRoutes } from "./routes/job-routes";
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
import { registerCollaborationWorkspaceRoutes } from "./routes/collaboration-workspace-routes";
import { registerConfigAssetRoutes } from "./routes/config-asset-routes";
import { registerConversationFileRoutes } from "./routes/conversation-file-routes";
import { registerConversationResourceRoutes } from "./routes/conversation-resource-routes";
import { registerConversationRoutes } from "./routes/conversation-routes";
import { registerDraftAttachmentRoutes } from "./routes/draft-attachment-routes";
import { registerSessionTokenRoutes } from "./routes/session-token-routes";
import { registerServiceAccessTokenRoutes } from "./routes/service-access-token-routes";
import { registerSuperadminRoutes } from "./routes/superadmin-routes";
import { registerUserAccountRoutes } from "./routes/user-account-routes";
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
export type { ChatServerJobOptions, ChatServerJobs } from "./jobs";
export {
  DELETION_MAX_ATTEMPTS,
  cleanUpExecutionWorkspacesJob,
  deleteAccountJob,
  deleteWorkspaceJob,
  expireConversationsJob,
  generateConversationTitleJob,
  pruneAuditEventsJob,
  pruneJobsJob
} from "./job-kinds";
export {
  ExecutionWorkspaceCleanupWorkflow,
  cleanupExecutionWorkspaceForConversation
} from "./workspace-cleanup";
export type { ExecutionWorkspaceCleanupRunSummary } from "./workspace-cleanup";
export type {
  ChatServerOptions,
  ConversationRetentionOptions,
  ExecutionWorkspaceCleanupJobOptions
} from "./types";
export { loadViewRuntimeFiles } from "./view-runtime";
export { createInProcessRateLimiter } from "./http/rate-limit";
export { createHttpRuntime } from "./http/runtime";
export type { InProcessHttpServer } from "./http/runtime";

export async function createChatServer(input: ChatServerOptions): Promise<HttpRuntime> {
  const allowedOrigins = normalizeAllowedOrigins(input.allowedOrigins);
  const options: ResolvedChatServerOptions = {
    ...input,
    allowedOrigins,
    rateLimiter: input.rateLimiter ?? createInProcessRateLimiter(),
    authorizer: input.authorizer ?? createAuthorizer(input.stores.access)
  };
  const app = Fastify({
    loggerInstance: adaptLogger(options.logger),
    // Assumes the API is reachable only through a reverse proxy on a private network (the
    // Compose network). X-Forwarded-For is honoured only when the direct peer is a loopback or
    // private address, so a public peer cannot choose its own request.ip.
    trustProxy: ["loopback", "uniquelocal"]
  });

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
  registerCollaborationWorkspaceRoutes(route, options);
  registerConfigAssetRoutes(route, options);
  registerApprovalRequestRoutes(route, options);
  registerUserAccountRoutes(route, options);
  registerConversationRoutes(route, options);
  registerConversationResourceRoutes(route, options);
  registerConversationFileRoutes(route, options);
  registerDraftAttachmentRoutes(route, options);
  registerAuditRoutes(route, options);
  registerOperationRunRoutes(route, options);
  registerJobRoutes(route, options);
  registerApiAccessAdministrationRoutes(route, options);
  registerSuperadminRoutes(route, options);
  registerAccessRoutes(route, options);
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
export type {
  ConfigAssetBundle,
  ConfigAssetValidationRefs,
  WorkflowAssetKind
} from "./asset-kinds/shared";

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
