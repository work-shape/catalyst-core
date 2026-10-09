import {
  asConversationId,
  asUserId,
  defineJobHandler,
  defineSchedule,
  type JobSchedule,
  type RegisteredJobHandler
} from "@vivd-catalyst/core";
import { ConversationWorkflow } from "./conversation-workflow";
import {
  cleanUpExecutionWorkspacesJob,
  expireConversationsJob,
  expireConversationsSchedule,
  generateConversationTitleJob,
  pruneAuditEventsJob,
  pruneAuditEventsSchedule,
  pruneJobsJob,
  pruneJobsSchedule,
  recoverAgentRunsJob,
  recoverAgentRunsSchedule
} from "./job-kinds";
import { ConversationRetentionWorkflow } from "./retention";
import { RunRecoveryWatchdog } from "./run-recovery";
import type { ChatServerOptions, ConversationRetentionOptions, RunRecoveryOptions } from "./types";
import { ExecutionWorkspaceCleanupWorkflow } from "./workspace-cleanup";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The job kinds the API process serves, with their schedules. */
export interface ChatServerJobs {
  handlers: RegisteredJobHandler[];
  schedules: JobSchedule[];
}

/** What a test sets to drive a handler with its own clock and limits. */
export interface ChatServerJobOptions {
  retention?: ConversationRetentionOptions;
  runRecovery?: RunRecoveryOptions;
  now?: () => Date;
}

export function createChatServerJobs(
  options: ChatServerOptions,
  jobOptions: ChatServerJobOptions = {}
): ChatServerJobs {
  const now = jobOptions.now ?? (() => new Date());
  const conversations = new ConversationWorkflow(options);
  const retention = new ConversationRetentionWorkflow(options, {
    now,
    ...jobOptions.retention
  });
  const runRecovery = new RunRecoveryWatchdog(options, options.logger, jobOptions.runRecovery);
  // The runs a process-bound runtime lost are the ones from before this process started.
  const processStartedAt = now();
  let recoveredRunsLostWithProcess = false;

  const handlers: RegisteredJobHandler[] = [
    defineJobHandler({
      kind: generateConversationTitleJob,
      slots: 4,
      run: (job, control) =>
        conversations.generateTitleForConversation(
          {
            conversationId: asConversationId(job.payload.conversationId),
            userId: asUserId(job.payload.userId),
            correlationId: job.correlationId
          },
          control
        )
    }),
    defineJobHandler({
      kind: expireConversationsJob,
      slots: 1,
      run: (_job, control) => retention.run(control.logger)
    }),
    defineJobHandler({
      kind: recoverAgentRunsJob,
      slots: 1,
      async run() {
        if (!recoveredRunsLostWithProcess) {
          await runRecovery.recoverRunsLostWithProcess(processStartedAt);
          recoveredRunsLostWithProcess = true;
        }
        await runRecovery.sweep(now());
      }
    }),
    defineJobHandler({
      kind: pruneAuditEventsJob,
      slots: 1,
      async run(job, control) {
        const createdBefore = new Date(
          now().getTime() - options.config.retention.auditDays * DAY_MS
        ).toISOString();
        // The deletion and its record commit together, or neither does.
        await control.transaction(async (stores) => {
          const deletedCount = await stores.audit.deleteAuditEventsBefore({
            clientInstanceId: options.clientInstanceId,
            createdBefore
          });
          await stores.audit.appendAuditEvent({
            clientInstanceId: options.clientInstanceId,
            type: "audit.pruned",
            status: "success",
            correlationId: job.correlationId,
            metadata: {
              deletedCount,
              createdBefore,
              auditDays: options.config.retention.auditDays
            }
          });
        });
      }
    }),
    defineJobHandler({
      kind: pruneJobsJob,
      slots: 1,
      async run(_job, control) {
        const pruned = await control.transaction((stores) =>
          stores.jobs.pruneEndedJobs({ clientInstanceId: options.clientInstanceId })
        );
        if (pruned.completedCount + pruned.failedCount > 0)
          control.logger.info(pruned, "Pruned ended jobs");
      }
    })
  ];
  const schedules: JobSchedule[] = [
    expireConversationsSchedule,
    recoverAgentRunsSchedule,
    pruneAuditEventsSchedule,
    pruneJobsSchedule
  ];

  const cleanup = options.executionWorkspaceCleanup;
  if (cleanup) {
    const workspaceCleanup = new ExecutionWorkspaceCleanupWorkflow(options, {
      now,
      ...cleanup.jobOptions
    });
    handlers.push(
      defineJobHandler({
        kind: cleanUpExecutionWorkspacesJob,
        slots: 1,
        async run() {
          await workspaceCleanup.cleanupDeletedConversationWorkspaces();
        }
      })
    );
    schedules.push(
      defineSchedule({
        kind: cleanUpExecutionWorkspacesJob,
        every: cleanup.jobOptions?.checkIntervalMs ?? DEFAULT_WORKSPACE_CLEANUP_INTERVAL_MS
      })
    );
  }

  return { handlers, schedules };
}

const DEFAULT_WORKSPACE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
