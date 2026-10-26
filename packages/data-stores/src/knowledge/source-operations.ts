import { z } from "zod";
import {
  AppError,
  auditActorFromIdentity,
  CONNECTION_EXPOSURE_ACTION_PREFIX,
  isOutsideCall,
  KNOWLEDGE_BASE_ACTIONS,
  isAuthenticatedServicePrincipal,
  isOperationRunId,
  KNOWLEDGE_SOURCE_OPERATIONS,
  knowledgeSyncInputSchema,
  knowledgeSyncResultSchema,
  knowledgeSourcesOutputSchema,
  knowledgeSourceItemsInputSchema,
  knowledgeSourceItemsOutputSchema,
  knowledgeLocateInputSchema,
  knowledgeLocateOutputSchema,
  type OperationDefinition,
  type OperationExecutionContext,
  type OperationResource
} from "@work-shape/catalyst-core";
import { firstPassAuditMetadata, firstPassConfirmation } from "./first-pass-estimate";
import type { FirstPassWaiting, KnowledgeSources } from "./source-port";
import { initialSyncIds } from "./builtin/source-lifecycle";
import type { KnowledgeRuntime } from "./runtime";
import type { KnowledgeBaseDefinition } from "./definition";

// The frozen SRC-0 contracts. Source content stays in unrecorded read answers only.
const SOURCE_OPERATION_TIMEOUT_MS = 60_000;
export function sourceOperation(
  runtime: KnowledgeRuntime,
  target: {
    assetId: string;
    name: string;
    resource: OperationResource;
    definition: KnowledgeBaseDefinition;
  },
  part: keyof typeof KNOWLEDGE_SOURCE_OPERATIONS
): OperationDefinition | undefined {
  const sources = runtime.sources;
  if (!sources || "backend" in target.definition) return undefined;
  const definition = target.definition;
  const contract = KNOWLEDGE_SOURCE_OPERATIONS[part];
  const base = {
    name: `knowledge.${target.name}.${part}`,
    effect: contract.effect,
    action: contract.right,
    auth: "principal" as const,
    scope: part === "sync" ? ("config_assets:write" as const) : ("config_assets:read" as const),
    resource: () => target.resource,
    module: "knowledge",
    timeoutMs: SOURCE_OPERATION_TIMEOUT_MS
  };
  function requireSource(source: string) {
    if (!definition.sources?.some((s) => s.id === source))
      throw new AppError("NOT_FOUND", "The Knowledge Base source is not available");
  }
  // The estimate a first pass that waits shows (KB-ISO-1b), from what the store holds now.
  const limitBytes = async () =>
    (
      await runtime.stores.dataStores.getDataStore({
        clientInstanceId: runtime.clientInstanceId,
        id: target.assetId
      })
    )?.sizeLimitBytes;
  const estimate = (limit: number | undefined) => (waiting: FirstPassWaiting) =>
    firstPassConfirmation({
      ...waiting,
      definition,
      embedding: runtime.embedding,
      limitBytes: limit
    });
  switch (part) {
    case "sync":
      return {
        ...base,
        changeClass: "reversible",
        completion: {
          mode: "async",
          stillRunning: "Abgleich läuft weiter",
          example: {
            counts: {
              discovered: 0,
              added: 0,
              changed: 0,
              moved: 0,
              withdrawn: 0,
              failed: 0,
              skipped: 0
            }
          }
        },
        inputSchema: knowledgeSyncInputSchema,
        outputSchema: knowledgeSyncResultSchema,
        async execute(input, context) {
          const parsed = knowledgeSyncInputSchema.parse(input);
          if (parsed.confirm) {
            const confirmed = await confirmFirstPass(
              runtime,
              sources,
              target,
              parsed.source,
              context,
              estimate(await limitBytes())
            );
            if (confirmed) return {};
          }
          requireSource(parsed.source);
          const payload = {
            ...initialSyncIds(target.assetId, parsed.source),
            operationRunId: context.runId
          };
          const runId = await sources.start(
            payload,
            parsed.mode ?? "changes",
            context.runtime.signal ?? new AbortController().signal,
            parsed.mode === "full" &&
              !isAuthenticatedServicePrincipal(context.actor) &&
              (context.origin.kind === "user" ||
                (context.origin.kind === "cli" && !context.origin.unattended))
          );
          if (isOperationRunId(runId)) context.joinAsyncRun?.(runId);
          return {};
        }
      };
    case "sources":
      return {
        ...base,
        inputSchema: z.strictObject({}),
        outputSchema: knowledgeSourcesOutputSchema,
        execute: async (_input, context) =>
          sources.sources(
            target.assetId,
            definition.sources ?? [],
            context.runtime.signal ?? new AbortController().signal,
            estimate(await limitBytes())
          )
      };
    case "source_items":
      return {
        ...base,
        ...sourceNamesRight(target.resource),
        inputSchema: knowledgeSourceItemsInputSchema,
        outputSchema: knowledgeSourceItemsOutputSchema,
        execute: (input, context) => {
          const parsed = knowledgeSourceItemsInputSchema.parse(input);
          requireSource(parsed.source);
          return sources.items(
            target.assetId,
            parsed,
            context.runtime.signal ?? new AbortController().signal
          );
        }
      };
    case "locate":
      return {
        ...base,
        ...sourceNamesRight(target.resource),
        inputSchema: knowledgeLocateInputSchema,
        outputSchema: knowledgeLocateOutputSchema,
        execute: (input, context) =>
          sources.locate(
            target.assetId,
            knowledgeLocateInputSchema.parse(input).sourceItemId,
            context.runtime.signal ?? new AbortController().signal
          )
      };
  }
}

/**
 * Who reads a source's items: a holder of `knowledge_base.read`, but no outside client (an API
 * key, or a call made for one). Their names, paths and links are the outside system's, which
 * no operation exposes to `outside`, as `connections.source_folders` does not.
 */
function sourceNamesRight(resource: OperationResource): {
  action: null;
  authorize: NonNullable<OperationDefinition["authorize"]>;
} {
  return {
    action: null,
    authorize: (_input, { actor, origin, access }) => {
      if (isOutsideCall(actor, origin)) {
        return {
          allowed: false,
          action: `${CONNECTION_EXPOSURE_ACTION_PREFIX}outside`,
          reason: "no_grant"
        };
      }
      const decision = access.authorize(KNOWLEDGE_BASE_ACTIONS.read, resource);
      return decision.allowed
        ? { allowed: true }
        : { allowed: false, action: KNOWLEDGE_BASE_ACTIONS.read, reason: decision.reason };
    }
  };
}

/**
 * `sync({ source, confirm: true })` (KB-ISO-1b): a holder of `knowledge_base.publish` lets the
 * first pass that stopped at 10,000 items go on. The call answers the pass: a connector's sync
 * run it joins, or for a Workflow's `ingest`, whose run is the Workflow step's, its own run
 * done at once. Audited with the counts and the estimate, never a name. Answers whether a pass
 * of the source had stopped; where none had, a connector source syncs as without `confirm`.
 */
async function confirmFirstPass(
  runtime: Pick<KnowledgeRuntime, "stores" | "clientInstanceId" | "now">,
  sources: KnowledgeSources,
  target: { assetId: string; name: string; resource: OperationResource },
  source: string,
  context: OperationExecutionContext,
  estimate: (waiting: FirstPassWaiting) => ReturnType<typeof firstPassConfirmation>
): Promise<boolean> {
  context.access.require(KNOWLEDGE_BASE_ACTIONS.publish, target.resource);
  const signal = context.runtime.signal ?? new AbortController().signal;
  const waiting = await sources.confirmFirstPass(target.assetId, source, signal);
  const workflow = source.startsWith("workflow:");
  if (!waiting) {
    if (!workflow) return false;
    throw new AppError(
      "CONFLICT",
      "No import of this source waits for a confirmation",
      { reason: "knowledge_nothing_to_confirm" },
      { exposeMessage: true }
    );
  }
  if (waiting.confirmedNow)
    await context.audit.record({
      type: "knowledge_base.first_pass_confirmed",
      status: "success",
      actor: auditActorFromIdentity(context.actor),
      subject: target.assetId,
      correlationId: context.correlationId,
      metadata: firstPassAuditMetadata(source, estimate(waiting))
    });
  if (!workflow && isOperationRunId(waiting.operationRunId))
    context.joinAsyncRun?.(waiting.operationRunId);
  else
    await runtime.stores.operationRuns.finish({
      clientInstanceId: runtime.clientInstanceId,
      id: context.runId,
      end: {
        status: "done",
        finishedAt: runtime.now().toISOString(),
        output: { value: { syncRunId: waiting.syncRunId, confirmed: true } }
      }
    });
  return true;
}
