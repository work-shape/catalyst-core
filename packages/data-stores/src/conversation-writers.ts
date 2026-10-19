import { z } from "zod";
import type { DataStoreRuntime } from "./runtime";

// Provenance follows retained successful calls, never transcripts or row contents. Keep a
// page read bounded even for a busy store; larger histories are explicitly lower-bound counts.
const WRITER_RUNS_PER_OPERATION = 1_000;
const writtenRows = z.object({
  inserted: z.number().optional(),
  updated: z.number().optional(),
  deleted: z.number().optional()
});

export async function conversationWriters(
  runtime: DataStoreRuntime,
  store: { name: string; createdAt: string }
) {
  const pages = await Promise.all(
    ["insert", "update", "delete_rows"].map((verb) =>
      runtime.stores.operationRuns.list({
        clientInstanceId: runtime.clientInstanceId,
        // Bound the indexed operation slice before filtering by origin/status. Filtering those
        // in SQL could walk every Workflow call looking for a rare conversation write.
        filters: { operation: `data_store.${store.name}.${verb}`, since: store.createdAt },
        page: { limit: WRITER_RUNS_PER_OPERATION + 1 }
      })
    )
  );
  const agents = new Set<string>();
  const conversations = new Set<string>();
  for (const page of pages) {
    for (const run of page.slice(0, WRITER_RUNS_PER_OPERATION)) {
      if (run.status !== "done" || run.target !== "live" || run.origin.kind !== "agent") continue;
      const written = writtenRows.safeParse(run.output?.value);
      if (!written.success) continue;
      const { inserted = 0, updated = 0, deleted = 0 } = written.data;
      if (inserted + updated + deleted === 0) continue;
      agents.add(run.origin.agentName);
      conversations.add(run.origin.conversationId);
    }
  }
  return {
    agents: agents.size,
    conversations: conversations.size,
    truncated: pages.some((page) => page.length > WRITER_RUNS_PER_OPERATION)
  };
}
