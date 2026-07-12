import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import { installErrorHandler } from "./errors";
import { registerAuditRoutes } from "./routes/audit-routes";
import { registerAgentRunRoutes } from "./routes/agent-run-routes";
import { registerBetterAuthRoutes } from "./routes/better-auth-routes";
import { registerConfigRoutes } from "./routes/config-routes";
import { registerConfigAssetRoutes } from "./routes/config-asset-routes";
import { registerConversationFileRoutes } from "./routes/conversation-file-routes";
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

export type { ChatAttachmentService, UploadDraftAttachmentInput } from "./attachments";
export type {
  ConversationRetentionJobOptions,
  ConversationRetentionRunSummary
} from "./retention";
export { ConversationRetentionJob, ConversationRetentionWorkflow } from "./retention";
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
    logger: true
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
  registerSessionTokenRoutes(app, options);
  registerServiceAccessTokenRoutes(app, options);
  registerAgentRunRoutes(app, options);
  registerConfigRoutes(app, options);
  registerConfigAssetRoutes(app, options);
  registerUserAccountRoutes(app, options);
  registerConversationRoutes(app, options);
  registerConversationFileRoutes(app, options);
  registerDraftAttachmentRoutes(app, options);
  registerAuditRoutes(app, options);
  registerSuperadminRoutes(app, options);

  return app;
}
