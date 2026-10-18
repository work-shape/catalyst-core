import {
  asUserId,
  defineJobHandler,
  defineJobKind,
  isWorkflowRunEnded,
  type ClientInstanceId,
  type LocaleCode,
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

// The platform writes this notice itself, so its words are ours: counts only, never a value
// of the run. It counts runs with failures: failed, at a limit, or with failed entries. It is in
// the publisher's language as their record says it at delivery, and in the instance's default
// language where they chose none, as the digest mail is.
const failureCopy: Record<LocaleCode, (count: number) => { title: string; text: string }> = {
  en: (count) =>
    count === 1
      ? {
          title: "A Workflow run needs attention",
          text: "1 run failed, reached a limit or has failed entries. Open the run to review it."
        }
      : {
          title: "Workflow runs need attention",
          text: `${count} runs failed, reached a limit or have failed entries. Open the run to review them.`
        },
  de: (count) =>
    count === 1
      ? {
          title: "Ein Workflow-Lauf braucht deine Aufmerksamkeit",
          text: "1 Lauf ist fehlgeschlagen, hat ein Limit erreicht oder enthält fehlgeschlagene Einträge. Öffne den Lauf, um ihn zu prüfen."
        }
      : {
          title: "Workflow-Läufe brauchen deine Aufmerksamkeit",
          text: `${count} Läufe sind fehlgeschlagen, haben ein Limit erreicht oder enthalten fehlgeschlagene Einträge. Öffne den Lauf, um sie zu prüfen.`
        }
};

/** Only a root end queues this job, including a successful root with failed children. */
export function createFailureNotices(options: {
  clientInstanceId: ClientInstanceId;
  notices?: (stores: PlatformStores) => Notices;
  /** The instance's default language, for a publisher who chose none. English when left out. */
  locale?: LocaleCode;
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
            ...failureCopy[user.locale ?? options.locale ?? "en"](count),
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
