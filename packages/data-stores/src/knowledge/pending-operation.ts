import {
  AppError,
  KNOWLEDGE_BASE_ACTIONS,
  KNOWLEDGE_WRITE_OPERATIONS,
  type OperationDefinition,
  type OperationResource
} from "@work-shape/catalyst-core";
import { normalizeKnowledgeText } from "./builtin/chunking";
import { readDocumentPages } from "./field-extraction";
import type { KnowledgeRuntime } from "./runtime";

// PROC-W: `knowledge.<id>.pending` hands a Workflow step the documents of a type whose pages
// changed after a time, as a dataset of the step run. It runs only as a step of a Workflow run:
// its answer is that run's datasets, which no other caller could read.

/** Reading one stored extraction per document, up to `KNOWLEDGE_PENDING_MAX_LIMIT` of them. */
const PENDING_TIMEOUT_MS = 10 * 60_000;

export function pendingOperation(
  runtime: KnowledgeRuntime,
  target: { assetId: string; name: string; resource: OperationResource }
): OperationDefinition | undefined {
  const sources = runtime.sources;
  if (!sources) return undefined;
  const contract = KNOWLEDGE_WRITE_OPERATIONS.pending;
  const name = `knowledge.${target.name}.pending`;
  return {
    name,
    description: contract.description,
    effect: "reading",
    action: KNOWLEDGE_BASE_ACTIONS.read,
    scope: "data_store_rows:read",
    auth: "principal",
    module: "knowledge",
    timeoutMs: PENDING_TIMEOUT_MS,
    inputSchema: contract.inputSchema,
    outputSchema: contract.outputSchema,
    resource: () => target.resource,
    async execute(input, context) {
      const { origin } = context;
      if (origin.kind !== "workflow")
        throw new AppError(
          "VALIDATION_FAILED",
          context.runtime.locale === "de"
            ? `\`${name}\` läuft nur als Schritt eines Workflow Runs.`
            : `\`${name}\` runs only as a step of a Workflow Run.`,
          { reason: "workflow_origin_required" },
          { exposeMessage: true }
        );
      const parsed = contract.inputSchema.parse(input);
      const signal = context.runtime.signal ?? new AbortController().signal;
      const answer = await sources.pending(
        {
          knowledgeBaseId: target.assetId,
          workflowRunId: origin.workflowRunId,
          stepRunId: origin.stepRunId,
          ...(parsed.type === undefined ? {} : { type: parsed.type }),
          // One instant, whatever offset the caller wrote it in.
          ...(parsed.since === undefined ? {} : { since: new Date(parsed.since).toISOString() }),
          limit: parsed.limit,
          async pages(document) {
            const pages = await readDocumentPages(runtime, target.assetId, {
              contentHash: document.contentSha256,
              fileId: document.fileId,
              format: document.format
            });
            return pages?.map((page) => ({
              page: page.page,
              text: normalizeKnowledgeText(page.text)
            }));
          }
        },
        signal
      );
      // Counts only: a name or a path of a document never reaches a log.
      if (answer.unreadable > 0)
        runtime.logger.warn(
          { event: "knowledge_pending_unreadable", count: answer.unreadable },
          "Documents without readable text were left out of pending"
        );
      return { documents: answer.documents };
    }
  };
}
