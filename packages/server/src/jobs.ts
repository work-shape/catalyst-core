import { createScheduledPromptHandler } from "./conversations/scheduled-start-job";
import { createNoticeMailJobs } from "./notices/notice-mail";
import { createFeedbackJobs } from "./feedback/feedback-jobs";
import {
  asCollaborationWorkspaceId,
  asConversationId,
  asUserId,
  createAgentRunUpkeepJobs,
  createAuthorizer,
  NO_BEFORE_ACTION_CHECK,
  defineJobHandler,
  defineSchedule,
  type JobSchedule,
  type RegisteredJobHandler
} from "@work-shape/catalyst-core";
import { completeAccountDeletion, recordAccountDeletionStalled } from "./deletion/account-deletion";
import { createConnectionDiscoveryJobs } from "./connections/connection-jobs";
import { createFollowUpDispatchHandler } from "./conversations/follow-up-service";
import { ConversationWorkflow } from "./conversations/conversation-service";
import {
  adoptLegacyJobsJob,
  adoptLegacyJobsSchedule,
  backfillUsageAttributionJob,
  backfillUsageAttributionSchedule,
  checkInfrastructureJob,
  checkInfrastructureSchedule,
  cleanUpExecutionWorkspacesJob,
  deleteAccountJob,
  deleteWorkspaceJob,
  expireConversationsJob,
  expireConversationsSchedule,
  generateConversationTitleJob,
  pruneAuditEventsJob,
  pruneAuditEventsSchedule,
  pruneJobsJob,
  pruneJobsSchedule,
  reconcileUsageJob,
  reconcileUsageSchedule,
  recoverAbandonedModelCallsJob,
  recoverAbandonedModelCallsSchedule,
  retiredRecoverAgentRunsJob,
  sweepConnectionSetupSessionsJob,
  sweepConnectionSetupSessionsSchedule
} from "./jobs/job-kinds";
import { createOperationCalls } from "./operations/operation-calls";
import { HELD_CALL_APPROVAL_KINDS } from "./approvals/operation-call-approval-handler";
import {
  createOperationRunJobs,
  removeEndedOperationCallInput
} from "./operations/operation-run-jobs";
import { ConversationRetentionWorkflow } from "./deletion/retention";
import { deletionActor } from "./deletion/subject-deletion";
import type { ChatServerOptions, ConversationRetentionOptions } from "./types";
import { createUsageAttributionBackfill, createUsageReconciliation } from "./jobs/usage-backfill";
import { ExecutionWorkspaceCleanupWorkflow } from "./deletion/workspace-cleanup";
import {
  completeWorkspaceDeletion,
  recordWorkspaceDeletionStalled
} from "./deletion/workspace-deletion";

/** The job kinds the API process serves, with their schedules. */
export interface ChatServerJobs {
  handlers: RegisteredJobHandler[];
  schedules: JobSchedule[];
}

/** What a test sets to drive a handler with its own clock and limits. */
export interface ChatServerJobOptions {
  retention?: ConversationRetentionOptions;
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
  const usageAttributionBackfill = createUsageAttributionBackfill(options, now);
  const usageReconciliation = createUsageReconciliation(options, now);

  const handlers: RegisteredJobHandler[] = [
    createScheduledPromptHandler(options, now),
    createFollowUpDispatchHandler(options),
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
    // A deletion that still waits throws, and the executor tries again after the backoff.
    defineJobHandler({
      kind: deleteAccountJob,
      slots: DELETION_SLOTS,
      async run(job, control) {
        await completeAccountDeletion(
          options,
          {
            userId: asUserId(job.payload.userId),
            requestedBy: job.payload.requestedBy,
            actor: await deletionActor(options, asUserId(job.payload.actorUserId)),
            correlationId: job.correlationId
          },
          (fn) => control.transaction(fn)
        );
      },
      onExhausted: (job, stores) =>
        recordAccountDeletionStalled(stores, options, {
          userId: asUserId(job.payload.userId),
          requestedBy: job.payload.requestedBy,
          correlationId: job.correlationId
        })
    }),
    defineJobHandler({
      kind: deleteWorkspaceJob,
      slots: DELETION_SLOTS,
      async run(job, control) {
        await completeWorkspaceDeletion(
          options,
          {
            collaborationWorkspaceId: asCollaborationWorkspaceId(
              job.payload.collaborationWorkspaceId
            ),
            actor: await deletionActor(options, asUserId(job.payload.actorUserId)),
            correlationId: job.correlationId
          },
          (fn) => control.transaction(fn)
        );
      },
      onExhausted: (job, stores) =>
        recordWorkspaceDeletionStalled(stores, options, {
          collaborationWorkspaceId: asCollaborationWorkspaceId(
            job.payload.collaborationWorkspaceId
          ),
          correlationId: job.correlationId
        })
    }),
    defineJobHandler({
      kind: expireConversationsJob,
      slots: 1,
      run: (_job, control) => retention.run(control.logger)
    }),
    defineJobHandler({
      kind: retiredRecoverAgentRunsJob,
      slots: 1,
      // No schedule names the kind, so no next tick follows the one this ends.
      run: () => Promise.resolve()
    }),
    defineJobHandler({
      kind: pruneAuditEventsJob,
      slots: 1,
      async run(job, control) {
        // The runs no conversation caused are kept as long as the audit events of their calls.
        // A run a conversation caused goes with that conversation. Decided Inbox requests
        // are deleted in the same transaction as their runs.
        // Repair a tick cut off after ending a run, before pending requests can block pruning.
        await removeEndedOperationCallInput(
          operationRunJobOptions,
          options.stores.approvals,
          control.logger,
          control.signal,
          // Live pending calls cannot consume the bounded repair scan.
          true
        );
        for (let batch = 0; batch < OPERATION_RUN_PRUNE_BATCHES_PER_TICK; batch++) {
          if (control.signal.aborted) break;
          const deleted = await options.stores.operationRuns.deleteOrphanedRequests({
            clientInstanceId: options.clientInstanceId,
            kinds: HELD_CALL_APPROVAL_KINDS,
            limit: OPERATION_RUN_PRUNE_BATCH_SIZE
          });
          if (deleted < OPERATION_RUN_PRUNE_BATCH_SIZE) break;
        }
        let operationRunsDeletedCount = 0;
        for (let batch = 0; batch < OPERATION_RUN_PRUNE_BATCHES_PER_TICK; batch++) {
          const deleted = await options.stores.operationRuns.deleteWithoutConversationOlderThan({
            clientInstanceId: options.clientInstanceId,
            days: options.config.retention.auditDays,
            limit: OPERATION_RUN_PRUNE_BATCH_SIZE
          });
          operationRunsDeletedCount += deleted;
          if (deleted < OPERATION_RUN_PRUNE_BATCH_SIZE || control.signal.aborted) break;
        }
        // The deletion and its record commit together, or neither does.
        await control.transaction(async (stores) => {
          const { deletedCount, createdBefore } = await stores.audit.deleteAuditEventsOlderThan({
            clientInstanceId: options.clientInstanceId,
            days: options.config.retention.auditDays
          });
          // What the capabilities keep, such as the guardrails' hits, is kept as long as the
          // audit events.
          const capabilityCounts: Record<string, number> = {};
          for (const retain of options.retention ?? []) {
            Object.assign(
              capabilityCounts,
              await retain({ days: options.config.retention.auditDays, stores })
            );
          }
          await stores.audit.appendAuditEvent({
            clientInstanceId: options.clientInstanceId,
            type: "audit.pruned",
            status: "success",
            correlationId: job.correlationId,
            // A capability's count never stands in for one of the platform's own.
            metadata: {
              ...capabilityCounts,
              deletedCount,
              createdBefore,
              auditDays: options.config.retention.auditDays,
              operationRunsDeletedCount
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
    }),
    defineJobHandler({
      kind: adoptLegacyJobsJob,
      slots: 1,
      async run(_job, control) {
        // An enqueue under a live dedupe key inserts nothing, so a tick may run twice.
        const previews = await options.stores.files.adoptArtifactPreviewJobs({
          clientInstanceId: options.clientInstanceId,
          limit: LEGACY_ADOPTION_BATCH_SIZE
        });
        const attachments =
          (await options.attachments?.adoptLegacyAttachments?.({
            limit: LEGACY_ADOPTION_BATCH_SIZE
          })) ?? 0;
        if (previews + attachments > 0)
          control.logger.info({ previews, attachments }, "Adopted rows without a job");
      }
    }),
    defineJobHandler({
      kind: backfillUsageAttributionJob,
      slots: 1,
      run: (_job, control) => usageAttributionBackfill.run(control)
    }),
    defineJobHandler({
      kind: recoverAbandonedModelCallsJob,
      slots: 1,
      async run(_job, control) {
        // Each release is one statement that changes a call only while it is still pending,
        // so a tick that was taken over releases nothing twice.
        const released = await options.usageGovernance.releaseAbandonedModelCalls({
          clientInstanceId: options.clientInstanceId,
          signal: control.signal
        });
        if (released > 0)
          control.logger.warn({ released }, "Released model calls that never ended");
      }
    }),
    defineJobHandler({
      kind: reconcileUsageJob,
      slots: 1,
      run: (_job, control) => usageReconciliation.run(control)
    }),
    defineJobHandler({
      kind: sweepConnectionSetupSessionsJob,
      slots: 1,
      async run(_job, control) {
        const swept = await control.transaction((stores) =>
          stores.connections.sweepExpiredConnectionSetupSessions({
            clientInstanceId: options.clientInstanceId
          })
        );
        if (swept > 0) control.logger.info({ swept }, "Removed expired Connection setup sessions");
      }
    })
  ];
  const schedules: JobSchedule[] = [
    expireConversationsSchedule,
    pruneAuditEventsSchedule,
    pruneJobsSchedule,
    adoptLegacyJobsSchedule,
    backfillUsageAttributionSchedule,
    recoverAbandonedModelCallsSchedule,
    reconcileUsageSchedule,
    sweepConnectionSetupSessionsSchedule
  ];

  // A run executes in an Agent Run worker. Its upkeep is served here as well, so a run whose
  // worker was killed is failed after its lease time, and a run no worker takes is failed
  // after its queue limit, while no worker is up.
  const agentRunUpkeep = createAgentRunUpkeepJobs({
    clientInstanceId: options.clientInstanceId,
    stores: options.stores
  });
  handlers.push(...agentRunUpkeep.handlers);
  schedules.push(...agentRunUpkeep.schedules);

  // The jobs read the registry the API's routes registered their operations in. A caller
  // that built no call path of its own has no operation with a time of its own to read.
  const operationCalls =
    options.operationCalls ??
    createOperationCalls({
      ...options,
      authorizer: options.authorizer ?? createAuthorizer(options.stores.access),
      // Its registry is read, and it executes no approved call: no before-event is asked.
      checks: NO_BEFORE_ACTION_CHECK
    });
  const operationRunJobOptions = {
    clientInstanceId: options.clientInstanceId,
    runs: options.stores.operationRuns,
    registry: operationCalls.registry,
    approvals: options.approvalRequests?.store,
    // Approved calls are executed where the call path of the instance exists, with its tools.
    calls: options.operationCalls
      ? { deps: () => operationCalls.deps, users: options.stores.users }
      : undefined,
    now
  };
  const operationRuns = createOperationRunJobs(operationRunJobOptions);
  handlers.push(...operationRuns.handlers);
  schedules.push(...operationRuns.schedules);

  const noticeMail = createNoticeMailJobs(options, now);
  handlers.push(...noticeMail.handlers);
  schedules.push(...noticeMail.schedules);

  const feedbackJobs = createFeedbackJobs(options, now);
  handlers.push(...feedbackJobs.handlers);
  schedules.push(...feedbackJobs.schedules);

  const connectionJobs = createConnectionDiscoveryJobs(options);
  handlers.push(...connectionJobs.handlers);
  schedules.push(...connectionJobs.schedules);

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

  const { infrastructure } = options;
  if (infrastructure) {
    handlers.push(
      defineJobHandler({
        kind: checkInfrastructureJob,
        slots: 1,
        // A provider that fails is a result, not a failed job: the run itself does not throw.
        run: () => infrastructure.runChecks()
      })
    );
    schedules.push(checkInfrastructureSchedule);
  }

  return { handlers, schedules };
}

const DEFAULT_WORKSPACE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
// Runs or settled orphan requests one statement deletes, and statements per daily tick:
// at most 100,000 of each inside the lease. A larger backlog goes the next day.
const OPERATION_RUN_PRUNE_BATCH_SIZE = 5000;
const OPERATION_RUN_PRUNE_BATCHES_PER_TICK = 20;
// Deletions of accounts or of workspaces this process runs at once, per kind.
const DELETION_SLOTS = 2;
// Rows one tick of the adopt schedule gives a job, per kind. It keeps a tick inside its lease
// after an upgrade with a long backlog; the next tick, a minute later, takes the rest.
const LEGACY_ADOPTION_BATCH_SIZE = 500;
