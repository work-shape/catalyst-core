import { unreadableInputMessage } from "./unreadable-input";
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
  type OperationDefinition,
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
//
// Filters (DS-6b) go only to the Knowledge Bases that declare every one passed: one that does
// not is left out of the call and named under `skipped`, because its unfiltered passages would
// ignore the restriction the agent asked for. Which filters a Knowledge Base declares is read
// from its own search's input, which refuses any other.

const searchToolInputSchema = z.strictObject({
  query: z.string().trim().min(1).max(KNOWLEDGE_SEARCH_QUERY_MAX_CHARS),
  knowledgeBases: z.array(z.string().min(1)).min(1).optional(),
  limit: z.number().int().min(1).max(KNOWLEDGE_SEARCH_LIMIT_MAX).optional(),
  filters: z.record(z.string().min(1).max(63), z.string().max(1_000)).optional()
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
  reason:
    "permission_missing" | "not_searchable" | "unavailable" | "filter_not_declared" | "failed";
  message: string;
}

/**
 * Whether a Knowledge Base's search takes a filter of this name: its input refuses a name it
 * does not declare as a key it does not know, and takes any value of one it declares, or
 * refuses that value for its own reason.
 */
function declaresFilter(search: OperationDefinition, filter: string): boolean {
  const parsed = search.inputSchema.safeParse({ query: "x", filters: { [filter]: "" } });
  return (
    parsed.success ||
    !parsed.error.issues.some(
      (issue) => issue.code === "unrecognized_keys" && issue.path.join(".") === "filters"
    )
  );
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
    return failed(
      "validation_failed",
      unreadableInputMessage(options.unreadableInput, context.locale)
    );
  }
  const parsed = searchToolInputSchema.safeParse(request.input);
  if (!parsed.success) {
    return failed(
      "validation_failed",
      'Send the words to search for under "query", and optionally the ids under "knowledgeBases", a "limit" up to 50 and declared "filters" as values by name.'
    );
  }
  const {
    query,
    knowledgeBases: named,
    limit = KNOWLEDGE_SEARCH_LIMIT_DEFAULT,
    filters
  } = parsed.data;
  const filterNames = Object.keys(filters ?? {});
  const listed = (await deps.agentToolNames?.(request.agentName, request.conversationId)) ?? [];
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
    const search = operations.get(knowledgeSearchOperationName(name));
    const undeclared = search
      ? filterNames.filter((filter) => !declaresFilter(search, filter))
      : [];
    if (search && undeclared.length > 0) {
      skipped.push({
        knowledgeBase: name,
        reason: "filter_not_declared",
        message: `It declares no filter ${undeclared.map((filter) => `'${filter}'`).join(", ")}, so it was not searched.`
      });
    } else if (search) {
      const fits = search.inputSchema.safeParse({ query, limit, ...(filters ? { filters } : {}) });
      if (!fits.success) {
        return failed(
          "validation_failed",
          `A filter value does not fit the Knowledge Base '${name}': ${fits.error.issues.map((issue) => issue.message).join("; ")}`
        );
      }
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
          input: { query, limit, ...(filters ? { filters } : {}) }
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
