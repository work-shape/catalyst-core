import {
  AppError,
  asUserId,
  createPlatformId,
  createUserMessageMetadata,
  createUserPrincipal,
  defineJobHandler,
  defineJobKind,
  lastDueWithin,
  nextDueAfter,
  parseCron,
  type AuthenticatedUser,
  type PlatformStores,
  type ScheduledStart,
  type ScheduledStartRun
} from "@work-shape/catalyst-core";
import { z } from "zod";
import type { ChatServerOptions } from "../types";
import { getWorkspaceAssetSnapshot } from "../workspaces/agent-availability";

/** One saved start's due time. The subject lock and run row make a retried tick idempotent. */
export const scheduledPromptJob = defineJobKind({
  kind: "scheduled_prompt.fire",
  payloadSchema: z.strictObject({
    scheduledStartId: z.string().min(1),
    dueAt: z.iso.datetime({ offset: true }),
    manual: z.boolean(),
    ownerUserId: z.string().min(1)
  }),
  maxAttempts: 3,
  backoff: { baseMs: 1000, maxMs: 10_000 },
  leaseMs: 60_000,
  concurrency: { perKey: 1 },
  manualRetry: false
});

export function schedulePromptJob(
  tx: Pick<PlatformStores, "jobs">,
  start: ScheduledStart,
  dueAt: string,
  manual = false
) {
  return tx.jobs.enqueue(
    scheduledPromptJob,
    { scheduledStartId: start.id, dueAt, manual, ownerUserId: start.ownerUserId },
    {
      clientInstanceId: start.clientInstanceId,
      subject: start.id,
      runAfter: new Date(dueAt),
      dedupeKey: `${scheduledPromptJob.kind}:${start.id}:${manual ? "manual:" : ""}${dueAt}`,
      concurrencyKey: start.id
    }
  );
}

/** A queued Agent Run and the next tick exist at the same commit as this attempt's history. */
export function createScheduledPromptHandler(options: ChatServerOptions, now: () => Date) {
  return defineJobHandler({
    kind: scheduledPromptJob,
    slots: 4,
    async run(job, control) {
      const previous = await options.stores.scheduledStarts.get({
        clientInstanceId: options.clientInstanceId,
        id: job.payload.scheduledStartId
      });
      if (!previous) return;
      const workspaceBefore = await options.stores.workspaces.getWorkspace(
        options.clientInstanceId,
        previous.collaborationWorkspaceId
      );
      const assets = workspaceBefore
        ? await getWorkspaceAssetSnapshot(options, workspaceBefore)
        : undefined;
      await control.transaction(async (tx) => {
        const start = await tx.scheduledStarts.get({
          clientInstanceId: options.clientInstanceId,
          id: job.payload.scheduledStartId,
          forUpdate: true
        });
        if (
          !start ||
          start.ownerUserId !== job.payload.ownerUserId ||
          (!job.payload.manual &&
            (start.state !== "active" || start.nextRunAt !== job.payload.dueAt))
        )
          return;
        const moment = new Date(Math.max(now().getTime(), Date.parse(job.payload.dueAt)));
        // A late tick catches up once, for the latest due time it missed.
        const cron = job.payload.manual ? undefined : parseCron(start.cron);
        const scheduledFor = (
          (cron && lastDueWithin([cron], new Date(job.payload.dueAt), moment, start.timeZone)) ??
          new Date(job.payload.dueAt)
        ).toISOString();
        const existing = await tx.scheduledStarts.getRun({
          clientInstanceId: options.clientInstanceId,
          scheduledStartId: start.id,
          scheduledFor
        });
        if (existing) return;
        const history: ScheduledStartRun = {
          id: createPlatformId<"ScheduledStartRunId">("scheduled_run"),
          scheduledStartId: start.id,
          scheduledFor,
          conversationId: null,
          agentRunId: null,
          status: "skipped",
          reason: null,
          personalConnectionsAllowed: start.personalConnectionsAllowed,
          createdAt: moment.toISOString()
        };
        const open = await tx.scheduledStarts.hasOpenRun({
          clientInstanceId: options.clientInstanceId,
          scheduledStartId: start.id
        });
        if (open)
          history.reason =
            open === "waiting_for_decision" ? "waiting_for_decision" : "previous_run_active";
        else {
          const owner = await tx.users.getUser({
            clientInstanceId: options.clientInstanceId,
            userId: asUserId(start.ownerUserId)
          });
          const workspace = await tx.workspaces.getWorkspace(
            options.clientInstanceId,
            start.collaborationWorkspaceId
          );
          const member = await tx.workspaces.getMembership({
            clientInstanceId: options.clientInstanceId,
            collaborationWorkspaceId: start.collaborationWorkspaceId,
            userId: asUserId(start.ownerUserId)
          });
          if (!owner || owner.status !== "active") history.reason = "owner_unavailable";
          else if (!workspace || !member) history.reason = "workspace_unavailable";
          else {
            if (!assets?.agents.some((agent) => agent.name === start.agentName))
              history.reason = "agent_unavailable";
            else {
              const identity = owner.identities[0];
              const user: AuthenticatedUser = {
                id: owner.id,
                subjectUserId: owner.id,
                externalUserId: identity?.externalUserId ?? owner.id,
                displayLabel: owner.displayLabel,
                email: owner.email,
                roles: owner.roles,
                permissionRefs: owner.permissionRefs,
                permissions: owner.permissions,
                clientInstanceId: owner.clientInstanceId,
                authSource: identity?.authSource ?? "scheduled-start"
              };
              const conversation = await tx.conversations.createConversation({
                clientInstanceId: options.clientInstanceId,
                collaborationWorkspaceId: start.collaborationWorkspaceId,
                createdByUserId: owner.id,
                createdByExternalUserId: user.externalUserId,
                visibility: "private",
                title: start.prompt.slice(0, 120),
                retainedUntil: new Date(
                  moment.getTime() + options.config.retention.conversationDays * 86_400_000
                ).toISOString()
              });
              const messageId = createPlatformId<"MessageId">("msg");
              const prepared = await tx.agentRuns.prepareConversationRunStart({
                clientInstanceId: options.clientInstanceId,
                conversationId: conversation.id,
                ownerUserId: owner.id,
                userMessage: {
                  id: messageId,
                  text: start.prompt,
                  metadata: createUserMessageMetadata({
                    attachmentManifest: { version: 1, attachments: [] }
                  })
                },
                run: {
                  id: createPlatformId<"AgentRunId">("run"),
                  clientInstanceId: options.clientInstanceId,
                  conversationId: conversation.id,
                  ownerUserId: owner.id,
                  inputMessageId: messageId,
                  agentName: start.agentName,
                  status: "queued",
                  startedAt: moment.toISOString(),
                  locale: owner.locale ?? options.config.localization.defaultLocale,
                  authorization: {
                    personalConnectionsAllowed: start.personalConnectionsAllowed,
                    principal: createUserPrincipal(user),
                    subjectUserId: owner.id,
                    scopes: ["*"]
                  },
                  correlationId: job.correlationId
                }
              });
              if (!("run" in prepared))
                throw new AppError(
                  "INTERNAL",
                  "First scheduled message cannot queue as a follow-up"
                );
              history.conversationId = conversation.id;
              history.agentRunId = prepared.run.id;
              history.status = "queued";
              await tx.audit.appendAuditEvent({
                clientInstanceId: options.clientInstanceId,
                type: "scheduled_start.fired",
                status: "success",
                subject: start.id,
                correlationId: job.correlationId,
                metadata: { conversationId: conversation.id, agentRunId: prepared.run.id }
              });
            }
          }
          if (history.reason) history.status = "failed";
        }
        await tx.scheduledStarts.addRun({
          clientInstanceId: options.clientInstanceId,
          run: history
        });
        await tx.scheduledStarts.pruneRunless({
          clientInstanceId: options.clientInstanceId,
          scheduledStartId: start.id,
          keepAfter: new Date(
            moment.getTime() - options.config.retention.auditDays * 86_400_000
          ).toISOString()
        });
        if (history.reason === "owner_unavailable" || history.reason === "workspace_unavailable") {
          await tx.scheduledStarts.update({
            clientInstanceId: start.clientInstanceId,
            id: start.id,
            ownerUserId: start.ownerUserId,
            patch: { state: "paused", nextRunAt: null },
            now: moment.toISOString()
          });
        } else if (!job.payload.manual) await advance(tx, start, moment);
      });
    },
    async onExhausted(job, tx) {
      const start = await tx.scheduledStarts.get({
        clientInstanceId: options.clientInstanceId,
        id: job.payload.scheduledStartId,
        forUpdate: true
      });
      if (start && start.ownerUserId === job.payload.ownerUserId) {
        const existing = await tx.scheduledStarts.getRun({
          clientInstanceId: start.clientInstanceId,
          scheduledStartId: start.id,
          scheduledFor: job.payload.dueAt
        });
        if (!existing)
          await tx.scheduledStarts.addRun({
            clientInstanceId: start.clientInstanceId,
            run: {
              id: createPlatformId<"ScheduledStartRunId">("scheduled_run"),
              scheduledStartId: start.id,
              scheduledFor: job.payload.dueAt,
              conversationId: null,
              agentRunId: null,
              status: "failed",
              reason: "dispatch_failed",
              personalConnectionsAllowed: start.personalConnectionsAllowed,
              createdAt: now().toISOString()
            }
          });
      }
      if (
        start &&
        start.ownerUserId === job.payload.ownerUserId &&
        !job.payload.manual &&
        start.state === "active" &&
        start.nextRunAt === job.payload.dueAt
      )
        await advance(
          tx,
          start,
          new Date(Math.max(now().getTime(), Date.parse(job.payload.dueAt)))
        );
    }
  });
}

async function advance(tx: PlatformStores, start: ScheduledStart, moment: Date) {
  const cron = parseCron(start.cron);
  const nextRunAt = cron
    ? (nextDueAfter([cron], moment, start.timeZone)?.toISOString() ?? null)
    : null;
  const updated = await tx.scheduledStarts.update({
    clientInstanceId: start.clientInstanceId,
    id: start.id,
    ownerUserId: start.ownerUserId,
    patch: { nextRunAt, ...(nextRunAt ? {} : { state: "paused" as const }) },
    now: moment.toISOString()
  });
  if (nextRunAt) await schedulePromptJob(tx, updated, nextRunAt);
}
