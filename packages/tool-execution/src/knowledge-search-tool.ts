import { z } from "zod";
import {
  fuseByReciprocalRank,
  KNOWLEDGE_OPERATION_PREFIX,
  KNOWLEDGE_SEARCH_LIMIT_DEFAULT,
  KNOWLEDGE_SEARCH_LIMIT_MAX,
  KNOWLEDGE_SEARCH_QUERY_MAX_CHARS,
  knowledgeQueryOperationName,
  knowledgeSearchOperationName,
  type AgentRunId,
  type OperationCallRuntime,
  type RuntimeCallContext,
  type ToolExecutionRequest,
  type ToolExecutionResult,
  type ToolOperationRunner
} from "@work-shape/catalyst-core";
import type { RunOperationDeps } from "./operation-execution";
import { failed } from "./tool-results";

// The agent tool `knowledge.search` (P40): one call searches every Knowledge Base the agent is
// assigned that keeps documents, or the ones its input names, as one call of
// `knowledge.<id>.search` per Knowledge Base through the runner, so each is authorized against
// the person's `knowledge_base.use`, checked against policy and recorded by itself. The lists
// are merged by rank (reciprocal rank fusion, k = 60), never by raw score, because scores of
// different Knowledge Bases are not comparable. A Knowledge Base the person may not search, or
// one that failed, is named under `skipped` with the reason, and the others answer.
//
// Each passage gets a ref `K<n>` that stays unique across the searches of one Agent Run, so the
// agent cites `[K1]` without two passages sharing a ref. The count is held in this process; a
// run resumed by another process starts again at K1. Spec: "Search, the agent tool and
// citations"; checks 35 to 37.

const searchToolInputSchema = z.strictObject({
  query: z.string().trim().min(1).max(KNOWLEDGE_SEARCH_QUERY_MAX_CHARS),
  knowledgeBases: z.array(z.string().min(1)).min(1).optional(),
  limit: z.number().int().min(1).max(KNOWLEDGE_SEARCH_LIMIT_MAX).optional()
});

/** A passage as `knowledge.<id>.search` answers it. Read again here: it is another call's output. */
const passageSchema = z.object({
  ref: z.string(),
  knowledgeBase: z.string(),
  documentId: z.string(),
  fileId: z.string(),
  fileName: z.string(),
  title: z.string(),
  page: z.number().int().optional(),
  heading: z.string().optional(),
  text: z.string(),
  score: z.number(),
  originLink: z.string().optional()
});

const searchOutputSchema = z.object({ passages: z.array(passageSchema) });

type Passage = z.infer<typeof passageSchema>;

/** Why a Knowledge Base was not searched, as the agent reads it. */
interface Skipped {
  knowledgeBase: string;
  reason: "permission_missing" | "not_searchable" | "unavailable" | "failed";
  message: string;
}

/** How many Agent Runs the count of refs is held for at once. The oldest is let go first. */
const REF_COUNTS_MAX = 1_000;

/** The next ref number of each Agent Run this process searched for. */
export function createKnowledgeRefCounter(): (runId: AgentRunId, count: number) => number {
  const next = new Map<AgentRunId, number>();
  return (runId, count) => {
    const first = next.get(runId) ?? 1;
    next.delete(runId);
    next.set(runId, first + count);
    if (next.size > REF_COUNTS_MAX) {
      const oldest = next.keys().next();
      if (!oldest.done) next.delete(oldest.value);
    }
    return first;
  };
}

/**
 * A call of `knowledge.search` as calls of the search of each Knowledge Base it reaches,
 * merged into one answer. `run` is the runner itself: each call takes the path of every
 * operation.
 */
export async function runKnowledgeSearch(
  request: ToolExecutionRequest,
  context: RuntimeCallContext,
  options: Pick<OperationCallRuntime, "unreadableInput"> | undefined,
  deps: Pick<RunOperationDeps, "agentToolNames" | "registry">,
  run: ToolOperationRunner,
  takeRefs: (runId: AgentRunId, count: number) => number
): Promise<ToolExecutionResult> {
  if (options?.unreadableInput) {
    return failed("validation_failed", options.unreadableInput.message);
  }
  const parsed = searchToolInputSchema.safeParse(request.input);
  if (!parsed.success) {
    return failed(
      "validation_failed",
      'Send the words to search for under "query", and optionally the ids under "knowledgeBases" and a "limit" up to 50.'
    );
  }
  const { query, knowledgeBases: named, limit = KNOWLEDGE_SEARCH_LIMIT_DEFAULT } = parsed.data;
  const listed = (await deps.agentToolNames?.(request.agentName)) ?? [];
  const assigned = [
    ...new Set(
      listed.flatMap((name) => {
        const parts = name.startsWith(KNOWLEDGE_OPERATION_PREFIX) ? name.split(".") : [];
        return parts.length === 3 && parts[2] === "search" && parts[1] ? [parts[1]] : [];
      })
    )
  ];
  const notAssigned = (named ?? []).filter((name) => !assigned.includes(name));
  if (notAssigned.length > 0) {
    return failed(
      "not_allowed",
      `The Knowledge Base '${notAssigned[0]}' is not assigned to this agent. Search the Knowledge Bases the tool lists.`,
      { reason: "knowledge_base_not_assigned", knowledgeBase: notAssigned[0] ?? "" }
    );
  }
  const wanted = named ? [...new Set(named)] : assigned;
  const operations = await deps.registry.resolveMany(
    wanted.flatMap((name) => [
      knowledgeSearchOperationName(name),
      knowledgeQueryOperationName(name)
    ])
  );
  const skipped: Skipped[] = [];
  const searched: string[] = [];
  for (const name of wanted) {
    if (operations.has(knowledgeSearchOperationName(name))) {
      searched.push(name);
    } else if (!operations.has(knowledgeQueryOperationName(name))) {
      skipped.push({
        knowledgeBase: name,
        reason: "unavailable",
        message: "It is not published or no longer there."
      });
    } else if (named) {
      // A Knowledge Base of tables is read with `knowledge.query`. Unnamed, it is no candidate.
      skipped.push({
        knowledgeBase: name,
        reason: "not_searchable",
        message: "It holds tables and is read with knowledge.query, not searched."
      });
    }
  }
  if (searched.length === 0 && skipped.length === 0) {
    return failed(
      "not_allowed",
      "No Knowledge Base assigned to this agent keeps documents to search. Use knowledge.query for one of tables."
    );
  }
  const answers = await Promise.all(
    searched.map((name) =>
      run(
        {
          ...request,
          toolName: knowledgeSearchOperationName(name),
          input: { query, limit }
        },
        context
      )
    )
  );
  const lists: Passage[][] = [];
  for (const [index, answer] of answers.entries()) {
    const knowledgeBase = searched[index] ?? "";
    if (answer.status === "cancelled") return answer;
    if (answer.status === "waiting_for_decision") {
      skipped.push({
        knowledgeBase,
        reason: "unavailable",
        message:
          "Searching it waits for a decision, which a search of several Knowledge Bases does not wait for. Ask the person to search it on its page."
      });
      continue;
    }
    if (answer.status !== "success") {
      skipped.push({
        knowledgeBase,
        reason:
          answer.error.code === "permission_missing" || answer.error.code === "not_allowed"
            ? "permission_missing"
            : "failed",
        message: answer.error.message
      });
      continue;
    }
    const output = searchOutputSchema.safeParse(answer.output);
    if (!output.success) {
      skipped.push({
        knowledgeBase,
        reason: "failed",
        message: "Its answer could not be read."
      });
      continue;
    }
    lists.push(output.data.passages);
  }
  // A permission refusal is never an empty search or a business result.
  const refused = skipped.find((entry) => entry.reason === "permission_missing");
  if (refused && lists.length === 0) return failed("permission_missing", refused.message);
  const merged = fuseByReciprocalRank(
    lists,
    (passage) => `${passage.knowledgeBase}\u0000${passage.ref}`
  ).slice(0, limit);
  const first = merged.length > 0 ? takeRefs(request.agentRunId, merged.length) : 1;
  const passages = merged.map(({ entry }, index) => ({
    ...entry,
    ref: `K${first + index}`
  }));
  return {
    status: "success",
    output: {
      passages,
      ...(skipped.length > 0 ? { skipped: skipped.map((entry) => ({ ...entry })) } : {})
    }
  };
}
