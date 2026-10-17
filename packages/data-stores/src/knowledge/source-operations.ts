import { z } from "zod";
import {
  AppError,
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
  type OperationResource
} from "@work-shape/catalyst-core";
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
          requireSource(parsed.source);
          if (parsed.mode !== "full")
            throw new AppError(
              "VALIDATION_FAILED",
              "Change-feed sync is not supported yet; request mode full.",
              { reason: "not_supported_yet" },
              { exposeMessage: true }
            );
          const payload = {
            ...initialSyncIds(target.assetId, parsed.source),
            operationRunId: context.runId
          };
          const runId = await sources.start(
            payload,
            "full",
            context.runtime.signal ?? new AbortController().signal
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
        execute: (_input, context) =>
          sources.sources(
            target.assetId,
            definition.sources ?? [],
            context.runtime.signal ?? new AbortController().signal
          )
      };
    case "source_items":
      return {
        ...base,
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
