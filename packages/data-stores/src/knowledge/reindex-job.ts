import { z } from "zod";
import {
  defineJobKind,
  KNOWLEDGE_JOB_KINDS,
  type ClientInstanceId,
  type PlatformStores
} from "@work-shape/catalyst-core";

// The job kind of a re-index (KB-8), apart from its handler, so the migration of an owned store
// can queue the rebuild of keyword languages without importing the embedding code.

const reindexOnlyPayloadSchema = z.strictObject({
  knowledgeBaseId: z.string().min(1).max(200),
  /** The binding the re-index embeds with: a later change of it supersedes this job. */
  bindingId: z.string().min(1).max(200),
  /** The run that started it, which its embedding usage is counted for. */
  operationRunId: z.string().min(1).max(200)
});

/**
 * A job of the same kind that only drops the generations the published revision no longer
 * uses: of the same kind, so it never runs beside a re-index of the same Knowledge Base.
 */
const dropUnusedPayloadSchema = z.strictObject({
  knowledgeBaseId: z.string().min(1).max(200),
  dropUnused: z.literal(true)
});

/** A job of the same kind that rebuilds the full-text columns of the keyword languages (KB-12). */
const keywordLanguagesPayloadSchema = z.strictObject({
  knowledgeBaseId: z.string().min(1).max(200),
  keywordLanguages: z.literal(true)
});

export const reindexPayloadSchema = z.union([
  reindexOnlyPayloadSchema,
  dropUnusedPayloadSchema,
  keywordLanguagesPayloadSchema
]);

export type ReindexPayload = z.infer<typeof reindexOnlyPayloadSchema>;

/** One per Knowledge Base at a time; heartbeats keep its lease while it embeds. */
export const knowledgeReindexJob = defineJobKind({
  kind: KNOWLEDGE_JOB_KINDS.reindex,
  payloadSchema: reindexPayloadSchema,
  maxAttempts: 5,
  backoff: { baseMs: 30_000, maxMs: 10 * 60_000 },
  leaseMs: 2 * 60_000,
  concurrency: { perKey: 1 }
});

/**
 * Queues the job that brings the store's full-text columns to the keyword languages of the
 * published revision (KB-12): of the re-index's kind, so it never runs beside a re-index of the
 * same Knowledge Base, and it embeds nothing.
 */
export function enqueueKeywordLanguages(
  stores: Pick<PlatformStores, "jobs">,
  clientInstanceId: ClientInstanceId,
  knowledgeBaseId: string
): Promise<unknown> {
  return stores.jobs.enqueue(
    knowledgeReindexJob,
    { knowledgeBaseId, keywordLanguages: true },
    { clientInstanceId, subject: knowledgeBaseId, concurrencyKey: knowledgeBaseId }
  );
}
