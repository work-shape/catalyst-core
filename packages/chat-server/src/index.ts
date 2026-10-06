import { registerApprovalRequestRoutes } from "./routes/approval-request-routes";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import { installErrorHandler } from "./errors";
import { registerAuditRoutes } from "./routes/audit-routes";
import { registerApiAccessAdministrationRoutes } from "./routes/api-access-administration-routes";
import { registerAgentRunRoutes } from "./routes/agent-run-routes";
import { registerBetterAuthRoutes } from "./routes/better-auth-routes";
import { registerDevMailRoutes } from "./routes/dev-mail-routes";
import { registerConfigRoutes } from "./routes/config-routes";
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
import { createConversationRetentionJob } from "./retention";
import { RunRecoveryWatchdog } from "./run-recovery";
import type { ChatServerOptions } from "./types";
import { createExecutionWorkspaceCleanupJob } from "./workspace-cleanup";

export type {
  ChatAttachmentService,
  UploadDraftAttachmentInput,
  UploadDraftAttachmentResult
} from "./attachments";
export type {
  ConversationRetentionJobOptions,
  ConversationRetentionRunSummary,
  OrphanedFileCleanupSummary
} from "./retention";
export {
  ConversationRetentionJob,
  ConversationRetentionWorkflow,
  createConversationRetentionJob
} from "./retention";
export { RUN_RECOVERY_ERROR, RunRecoveryWatchdog, recoverStaleRun } from "./run-recovery";
export type { RunRecoveryOptions, RunRecoverySweepSummary } from "./run-recovery";
export {
  ExecutionWorkspaceCleanupJob,
  ExecutionWorkspaceCleanupWorkflow,
  cleanupExecutionWorkspaceForConversation
} from "./workspace-cleanup";
export type {
  ExecutionWorkspaceCleanupJobOptions,
  ExecutionWorkspaceCleanupRunSummary
} from "./workspace-cleanup";
export type { ChatServerOptions } from "./types";

export async function createChatServer(options: ChatServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
    // Assumes the API is reachable only through a reverse proxy on a private network (the
    // Compose network). X-Forwarded-For is honoured only when the direct peer is a loopback or
    // private address, so a public peer cannot choose its own request.ip.
    trustProxy: ["loopback", "uniquelocal"]
  });

  await app.register(cors, {
    origin: options.corsOrigin ?? true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
    allowedHeaders: ["authorization", "content-type", "x-correlation-id", "x-server-credential"]
  });
  await app.register(multipart, {
    limits: {
      fileSize: options.attachments?.maxFileBytes
    }
  });

  installErrorHandler(app);
  const retentionJob = createConversationRetentionJob(options, {
    logger: app.log,
    jobOptions: options.retentionExpiration
  });
  const executionWorkspaceCleanupJob = createExecutionWorkspaceCleanupJob(options, {
    logger: app.log
  });
  const runRecoveryWatchdog = new RunRecoveryWatchdog(options, app.log, options.runRecovery);
  app.addHook("onReady", async () => {
    retentionJob.start();
    executionWorkspaceCleanupJob?.start();
    runRecoveryWatchdog.start();
  });
  app.addHook("onClose", async () => {
    runRecoveryWatchdog.stop();
    await executionWorkspaceCleanupJob?.stop();
    await retentionJob.stop();
  });

  app.get("/health", async () => ({
    status: "ok",
    clientInstanceId: options.clientInstanceId,
    time: new Date().toISOString()
  }));

  registerBetterAuthRoutes(app, options);
  registerDevMailRoutes(app, options);
  registerSessionTokenRoutes(app, options);
  registerServiceAccessTokenRoutes(app, options);
  registerAgentRunRoutes(app, options);
  registerConfigRoutes(app, options);
  registerCollaborationWorkspaceRoutes(app, options);
  registerConfigAssetRoutes(app, options);
  registerApprovalRequestRoutes(app, options);
  registerUserAccountRoutes(app, options);
  registerConversationRoutes(app, options);
  registerConversationResourceRoutes(app, options);
  registerConversationFileRoutes(app, options);
  registerDraftAttachmentRoutes(app, options);
  registerAuditRoutes(app, options);
  registerApiAccessAdministrationRoutes(app, options);
  registerSuperadminRoutes(app, options);

  return app;
}

export { ApprovalCheckRunner } from "./approval-check-runner";
export type { ApprovalCheckRunnerOptions } from "./approval-check-runner";

export { ApprovalRequestWorkflow } from "./approval-request-workflow";
export type {
  ApprovalRequestWorkflowOptions,
  ApprovalRequestView
} from "./approval-request-workflow";

export * from "./skill-change-approval-handler";
