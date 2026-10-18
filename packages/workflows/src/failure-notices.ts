import {
  asUserId,
  defineJobHandler,
  defineJobKind,
  isWorkflowRunEnded,
  type ClientInstanceId,
  type Notices,
  type PlatformStores,
  type WorkflowRun
} from "@work-shape/catalyst-core";
import { z } from "zod";

export const workflowFailureNoticeJob = defineJobKind({
  kind: "workflow_run.notify_failure",
  payloadSchema: z.strictObject({ rootRunId: z.string().min(1) }),
  maxAttempts: 3,
  backoff: { baseMs: 1000, maxMs: 30_000 },
  leaseMs: 60_000,
  concurrency: {},
  manualRetry: false
});

/** Only a root end queues this job, including a successful root with failed children. */
export function createFailureNotices(options: {
  clientInstanceId: ClientInstanceId;
  notices?: (stores: PlatformStores) => Notices;
}) {
  const { clientInstanceId } = options;
  return defineJobHandler({
    kind: workflowFailureNoticeJob,
    slots: 1,
    async run(job, control) {
      await control.transaction(async (tx) => {
        const rootRunId = job.payload.rootRunId;
        const known = await tx.workflowRuns.readRun({ clientInstanceId, id: rootRunId });
        if (!known) return;
        const root = await tx.workflowRuns.lockRun({ clientInstanceId, id: known.id });
        if (!root || root.parentRunId || !isWorkflowRunEnded(root.status)) return;
        const count = await tx.workflowNotices.failureCount({ clientInstanceId, rootRunId });
        if (count === 0) return;
        const publisher =
          root.mode === "test"
            ? root.startedBy.id
            : await tx.workflowNotices.publisher({
                clientInstanceId,
                revisionId: root.definitionRevisionId
              });
        if (!publisher) return; // Folder definitions have no publisher; assets record it at publish.
        const user = await tx.users.getUser({ clientInstanceId, userId: asUserId(publisher) });
        if (!user || user.status !== "active") return;
        const notices = options.notices?.(tx);
        if (!notices) throw new Error("The instance has no notice sender");
        if (!(await tx.workflowNotices.markNotified({ clientInstanceId, rootRunId }))) return;
        await notices.send(
          {
            from: failureSender(root),
            to: { users: [publisher] },
            title: "Workflow runs need attention",
            text: `${count} run(s) failed or reached a limit. Open the root run to review them.`,
            channels: ["inbox"],
            link: { kind: "workflow_run", workflowId: root.workflow, runId: root.id }
          },
          { correlationId: root.correlationId }
        );
      });
    }
  });
}

function failureSender(run: WorkflowRun) {
  return {
    kind: "service" as const,
    id: run.principal.id,
    workflowRunId: run.id,
    displayLabel: run.principal.displayLabel,
    permissionRefs: [],
    permissions: [],
    scopes: [],
    clientInstanceId: run.clientInstanceId,
    authSource: "workflow_run"
  };
}
