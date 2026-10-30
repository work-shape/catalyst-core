import {
  KNOWLEDGE_BASE_ASSET_KIND,
  WORKFLOW_ASSET_KIND,
  WORKFLOW_TRIGGER_EVENT_MAX_AGE_MS,
  WORKFLOW_TRIGGER_EVENTS,
  createActorAccess,
  defineJobHandler,
  isAppError,
  isWorkflowTriggerEventName,
  workflowEventJobKind,
  type ClientInstanceId,
  type PlatformStores,
  type RegisteredJobHandler,
  type WorkflowManifest,
  type WorkflowRun,
  type WorkflowTriggerEvent
} from "@work-shape/catalyst-core";
import {
  workflowDefinitionPages,
  type WorkflowDefinitionRevision,
  type WorkflowDefinitionSource
} from "./definition-source";
import { principalActor } from "./run-identity";
import type { PreparedStart } from "./run-start";
import type { RunOrigin } from "./scheduled-start";

// The `platform_event` trigger (EW-4). The audit record of an event of
// `WORKFLOW_TRIGGER_EVENTS` queues one job in its own transaction (`workflowEventJobOf`); the
// job starts a run of each published Workflow whose trigger names the event and matches its
// source, once per Workflow and event. A Workflow of a workspace hears only the events of its
// own workspace's sources, one of the instance hears them all, and a run starts only where the
// Workflow's account may read the event's source. The event carries ids, names and counts. An
// event older than `WORKFLOW_TRIGGER_EVENT_MAX_AGE_MS` when its job runs starts nothing.

/** The source of an event as rights are decided on it. */
interface EventSource {
  kind: string;
  id: string;
  name: string;
  workspaceId?: string;
}

interface EventTriggerOptions {
  clientInstanceId: ClientInstanceId;
  stores: PlatformStores;
  definitions: WorkflowDefinitionSource;
  now(): Date;
  prepareStart(published: WorkflowDefinitionRevision, given: unknown): Promise<PreparedStart>;
  openRun(
    tx: PlatformStores,
    prepared: PreparedStart,
    started: RunOrigin
  ): Promise<WorkflowRun | undefined>;
}

/** Whether a trigger of the definition names the event and, where it filters, its source. */
export function workflowHearsEvent(
  manifest: Pick<WorkflowManifest, "steps">,
  event: Pick<WorkflowTriggerEvent, "name"> & { source: Pick<EventSource, "name"> }
): boolean {
  const [trigger] = manifest.steps;
  if (trigger?.type !== "trigger") return false;
  const key = WORKFLOW_TRIGGER_EVENTS[event.name].filter;
  return trigger.triggers.some(
    (candidate) =>
      candidate.kind === "platform_event" &&
      candidate.event === event.name &&
      (candidate.filter?.[key] === undefined || candidate.filter[key] === event.source.name)
  );
}

export function createEventTrigger(options: EventTriggerOptions): RegisteredJobHandler {
  const { clientInstanceId, stores, definitions, now, prepareStart, openRun } = options;

  /** The source of the event as it is now; nothing where it is gone. */
  async function sourceOf(kind: string, id: string): Promise<EventSource | undefined> {
    if (kind !== KNOWLEDGE_BASE_ASSET_KIND) return undefined;
    // A Knowledge Base's store has the id of its asset and names the asset.
    const store = await stores.dataStores.getDataStore({ clientInstanceId, id });
    if (!store?.ownerKnowledgeBaseId) return undefined;
    const asset = await stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind,
      name: store.ownerKnowledgeBaseId
    });
    if (asset?.id !== id || asset.status !== "active") return undefined;
    return {
      kind,
      id,
      name: asset.name,
      ...(asset.scope.kind === "workspace" ? { workspaceId: asset.scope.workspaceId } : {})
    };
  }

  /** Whether the run's account holds the right on the source, by its grants alone. */
  async function accountMay(
    principal: PreparedStart["principal"],
    right: string,
    source: EventSource
  ): Promise<boolean> {
    const record = await stores.apiAccess.findServicePrincipalByName({
      clientInstanceId,
      name: principal.name
    });
    if (record?.status !== "active" || record.id !== principal.id) return false;
    const holder = { kind: "service_principal" as const, id: record.id };
    const access = createActorAccess(
      { ...holder, clientInstanceId, roles: [], permissionRefs: record.permissionRefs },
      await stores.access.loadPersistedAccess({
        clientInstanceId,
        holder,
        workspaceId: source.workspaceId ?? null
      })
    );
    return access.authorize(right, {
      kind: source.kind,
      name: source.name,
      assetId: source.id,
      ...(source.workspaceId === undefined ? {} : { workspaceId: source.workspaceId })
    }).allowed;
  }

  async function published(id: string): Promise<WorkflowDefinitionRevision | undefined> {
    try {
      return await definitions.read(id);
    } catch (error) {
      // A definition that cannot be read now starts nothing; the others still hear the event.
      if (isAppError(error)) return undefined;
      throw error;
    }
  }

  return defineJobHandler({
    kind: workflowEventJobKind,
    slots: 1,
    async run(job, control) {
      const { payload } = job;
      if (!isWorkflowTriggerEventName(payload.name)) return;
      // An event that waited too long, such as while its job stood, is history: it starts no run.
      const age = now().getTime() - Date.parse(payload.occurredAt);
      if (!(age <= WORKFLOW_TRIGGER_EVENT_MAX_AGE_MS)) {
        await stores.audit.appendAuditEvent({
          clientInstanceId,
          type: "workflow.event_dropped",
          status: "failed",
          actor: { displayLabel: "platform event", roles: [] },
          subject: payload.sourceId,
          correlationId: job.correlationId,
          metadata: { event: payload.name, eventId: payload.eventId, reason: "event_expired" }
        });
        return;
      }
      const declared = WORKFLOW_TRIGGER_EVENTS[payload.name];
      const source = await sourceOf(declared.source, payload.sourceId);
      if (!source) return;
      const event: WorkflowTriggerEvent = {
        id: payload.eventId,
        name: payload.name,
        occurredAt: payload.occurredAt,
        source: { kind: source.kind, id: source.id, name: source.name },
        data: payload.data
      };
      const dropped = (asset: string, reason: string) =>
        stores.audit.appendAuditEvent({
          clientInstanceId,
          type: "workflow.event_dropped",
          status: "failed",
          actor: { displayLabel: "platform event", roles: [] },
          subject: asset,
          correlationId: job.correlationId,
          metadata: { event: event.name, eventId: event.id, reason }
        });
      for await (const page of workflowDefinitionPages(definitions)) {
        for (const summary of page) {
          const revision = await published(summary.id);
          if (!revision || !workflowHearsEvent(revision.manifest, event)) continue;
          const asset = await stores.configAssets.getConfigAsset({
            clientInstanceId,
            kind: WORKFLOW_ASSET_KIND,
            name: revision.manifest.id
          });
          if (asset?.status !== "active") continue;
          // A Workflow of a workspace hears the events of its own workspace only.
          if (asset.scope.kind === "workspace" && asset.scope.workspaceId !== source.workspaceId)
            continue;
          let prepared: PreparedStart;
          try {
            // An event gives a run no input: a Workflow that needs one is not started by it.
            prepared = await prepareStart(revision, {});
          } catch (error) {
            if (!isAppError(error)) throw error;
            await dropped(asset.id, refusalReason(error));
            continue;
          }
          if (!(await accountMay(prepared.principal, declared.right, source))) {
            await dropped(asset.id, "source_unreadable");
            continue;
          }
          const { principal } = prepared;
          // Once per Workflow and event: a retried job meets the run it started already.
          await control.transaction((tx) =>
            openRun(tx, prepared, {
              trigger: "platform_event",
              triggerEvent: event,
              // Nobody is present at an event: the run is started as its own principal.
              startedBy: {
                kind: "service_principal",
                id: principal.id,
                label: principal.displayLabel
              },
              actor: principalActor({ principal }),
              correlationId: job.correlationId
            })
          );
        }
      }
    }
  });
}

function refusalReason(error: { code: string; details?: unknown }): string {
  const details = error.details;
  if (typeof details === "object" && details !== null && "reason" in details) {
    const { reason } = details;
    if (typeof reason === "string" && reason.length > 0) return reason;
  }
  return error.code;
}
