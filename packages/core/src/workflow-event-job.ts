import { z } from "zod";
import type { AuditEventInput } from "./audit";
import { defineJobKind, subjectDedupeKey } from "./jobs";
import type { JsonObject } from "./json";
import {
  WORKFLOW_RUN_JOB_KINDS,
  WORKFLOW_TRIGGER_EVENTS,
  isWorkflowTriggerEventName
} from "./workflows";
import {
  WORKFLOW_STEP_JOB_BACKOFF_BASE_MS,
  WORKFLOW_STEP_JOB_BACKOFF_MAX_MS
} from "./workflow-step-job";

// The job that starts the runs one platform event starts (EW-4). It is defined here and not
// with the engine because the store queues it: the audit record of an event of
// `WORKFLOW_TRIGGER_EVENTS` and its job are written in the same transaction, so an event is
// neither lost nor dispatched before it is committed. The payload holds the event's ids,
// names and counts, never content.

const payloadSchema = z.strictObject({
  eventId: z.string().min(1),
  name: z.string().min(1),
  sourceId: z.string().min(1),
  occurredAt: z.string().min(1),
  data: z.record(z.string(), z.json())
});

export type WorkflowEventJobPayload = z.infer<typeof payloadSchema>;

export const workflowEventJobKind = defineJobKind<WorkflowEventJobPayload>({
  kind: WORKFLOW_RUN_JOB_KINDS.dispatchEvent,
  payloadSchema,
  maxAttempts: 5,
  backoff: { baseMs: WORKFLOW_STEP_JOB_BACKOFF_BASE_MS, maxMs: WORKFLOW_STEP_JOB_BACKOFF_MAX_MS },
  leaseMs: 120_000,
  concurrency: {}
});

/**
 * The job an audit record queues, where its type is an event a `platform_event` trigger may
 * name and it names its source; nothing for every other record. Only the event's declared
 * fields are carried.
 */
export function workflowEventJobOf(
  record: Pick<AuditEventInput, "type" | "subject" | "metadata">,
  stored: { id: string; createdAt: string }
): WorkflowEventJobPayload | undefined {
  if (!isWorkflowTriggerEventName(record.type) || !record.subject) return undefined;
  const metadata: JsonObject = record.metadata ?? {};
  const data: JsonObject = {};
  for (const field of WORKFLOW_TRIGGER_EVENTS[record.type].fields) {
    const value = metadata[field];
    if (value !== undefined) data[field] = value;
  }
  return {
    eventId: stored.id,
    name: record.type,
    sourceId: record.subject,
    occurredAt: stored.createdAt,
    data
  };
}

/** The key of the job of one event: it is queued once. */
export function workflowEventJobKey(eventId: string): string {
  return subjectDedupeKey(workflowEventJobKind.kind, eventId);
}
