import { completedOutput, type ApiClient } from "@work-shape/catalyst-api-client";
import type { ScheduledRun, ScheduledStart, ScheduledStartInput } from "./scheduled-model";

// The one place that names the operations of scheduled starts. Every screen reads through
// `ScheduledStartsSource`.

/** One page of a list, as every list operation answers it. */
interface ScheduledPage<Item> {
  items: Item[];
  nextCursor?: string;
}

interface ScheduledPaging {
  limit: number;
  cursor?: string;
}

/** The reads and writes of a person's own scheduled starts. */
export interface ScheduledStartsSource {
  /** Without a workspace, the person's own in every workspace. */
  list(
    workspaceId: string | undefined,
    paging: ScheduledPaging,
    signal: AbortSignal
  ): Promise<ScheduledPage<ScheduledStart>>;
  runs(
    scheduledStartId: string,
    paging: ScheduledPaging,
    signal: AbortSignal
  ): Promise<ScheduledPage<ScheduledRun>>;
  create(workspaceId: string, input: ScheduledStartInput): Promise<ScheduledStart>;
  update(scheduledStartId: string, input: ScheduledStartInput): Promise<ScheduledStart>;
  setState(scheduledStartId: string, state: ScheduledStart["state"]): Promise<ScheduledStart>;
  runNow(scheduledStartId: string): Promise<void>;
  remove(scheduledStartId: string): Promise<void>;
}

/** A change of one's own scheduled start never waits for somebody else's approval. */
const HELD = "The change of a scheduled prompt waits for an approval and has changed nothing yet";

function withCursor(paging: ScheduledPaging): ScheduledPaging {
  return paging.cursor === undefined ? { limit: paging.limit } : paging;
}

/** The instance's scheduled starts, read and written with the session's client. */
export function createScheduledStartsSource(client: ApiClient): ScheduledStartsSource {
  return {
    list: async (workspaceId, paging, signal) => {
      const page = await client.scheduled_starts.list({
        query: {
          ...(workspaceId === undefined ? {} : { collaborationWorkspaceId: workspaceId }),
          ...withCursor(paging)
        },
        signal
      });
      return { items: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
    },
    runs: async (scheduledStartId, paging, signal) => {
      const page = await client.scheduled_starts.runs({
        params: { scheduledStartId },
        query: withCursor(paging),
        signal
      });
      return { items: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
    },
    create: async (workspaceId, input) =>
      completedOutput(
        await client.scheduled_starts.create({
          body: { collaborationWorkspaceId: workspaceId, ...input }
        }),
        HELD
      ),
    update: async (scheduledStartId, input) =>
      completedOutput(
        await client.scheduled_starts.update({ params: { scheduledStartId }, body: input }),
        HELD
      ),
    setState: async (scheduledStartId, state) =>
      completedOutput(
        await client.scheduled_starts.set_state({ params: { scheduledStartId }, body: { state } }),
        HELD
      ),
    runNow: async (scheduledStartId) => {
      completedOutput(
        await client.scheduled_starts.run_now({ params: { scheduledStartId } }),
        HELD
      );
    },
    remove: async (scheduledStartId) => {
      completedOutput(await client.scheduled_starts.delete({ params: { scheduledStartId } }), HELD);
    }
  };
}
