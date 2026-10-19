import type { ApiClient } from "@work-shape/catalyst-api-client";
import { WORKFLOW_ASSET_KIND } from "@work-shape/catalyst-core";
import { principalGrantRequest } from "../../admin/access/principal-grants-model";
import { PendingApprovalError } from "../build-area/build-refusals";
import {
  listedOf,
  toAssetWorkflowListItem,
  toWorkflow,
  toWorkflowListItem,
  toWorkflowRun,
  toWorkflowStepRun
} from "./workflow-mapping";
import type { WorkflowRunsSource, WorkflowsSource } from "./source-shapes";
import type { WorkflowListItem, WorkflowStepRunView } from "./workflow-views";

// The Workflow screens over the instance: the operations of the Workflows module and, for a
// definition, the read of an asset.

/**
 * How many step runs one page of a run's frame asks for: the most a list read gives. The
 * contract has no read of the step runs outside the items of a loop yet, so the frame is picked
 * out of all step runs of the run, in the order they were made, a page at a time.
 */
const FRAME_PAGE_SIZE = 200;

/** How many Workflows one read of the engine's list asks for, where a page asks for none. */
const WORKFLOW_SUMMARY_PAGE_SIZE = 200;

/**
 * Bounds the source reads for one screen page, including empty pages. Unread positions
 * travel in the next cursor, so a sparse list stays reachable without one long request.
 */
const LIST_READS_PER_PAGE = 5;

/** The part of the client the Workflow screens call. */
type WorkflowsClient = Pick<ApiClient, "workflows" | "assets" | "permissions">;

function runsSource(client: WorkflowsClient): WorkflowRunsSource {
  return {
    listRuns: async (workflow, query, signal) => {
      const page = await client.workflows.list_runs({
        params: { workflow },
        query: {
          limit: query.limit,
          cursor: query.cursor,
          ...(query.keyPrefix === undefined ? {} : { keyPrefix: query.keyPrefix })
        },
        signal
      });
      return { items: page.items.map(toWorkflowRun), nextCursor: page.nextCursor };
    },
    getRun: async (runId, signal) =>
      toWorkflowRun(await client.workflows.get_run({ params: { runId }, signal })),
    listFrameStepRuns: async (runId, cursor, signal) => {
      const page = await client.workflows.list_step_runs({
        params: { runId },
        query: { limit: FRAME_PAGE_SIZE, cursor },
        signal
      });
      const stepRuns: WorkflowStepRunView[] = [];
      const entryLoops: WorkflowStepRunView[] = [];
      for (const stepRun of page.items) {
        // A step run of an item of a loop is one of many: the loop's counts stand for them.
        // A loop in an item is kept apart: its counts say what failed inside it.
        if (stepRun.iteration === undefined) {
          stepRuns.push(toWorkflowStepRun(stepRun));
        } else if (stepRun.loop !== undefined) {
          entryLoops.push(toWorkflowStepRun(stepRun));
        }
      }
      return { stepRuns, entryLoops, nextCursor: page.nextCursor };
    },
    listEntryStepRuns: async (runId, query, signal) => {
      const page = await client.workflows.list_step_runs({
        params: { runId },
        query: {
          containerStepRunId: query.containerStepRunId,
          status: query.status,
          limit: query.limit,
          cursor: query.cursor
        },
        signal
      });
      return { items: page.items.map(toWorkflowStepRun), nextCursor: page.nextCursor };
    },
    getStepTranscript: async (runId, stepRunId, signal) => {
      const { messages, truncated } = await client.workflows.get_step_transcript({
        params: { runId, stepRunId },
        signal
      });
      return { messages, truncated };
    },
    start: async (workflow, input) =>
      toWorkflowRun(done(await client.workflows.start({ params: { workflow }, body: { input } }))),
    cancel: async (runId) =>
      toWorkflowRun(done(await client.workflows.cancel_run({ params: { runId } })))
  };
}

/** What a call answered, or the refusal of a call that is held for an approval. */
function done<Output>(
  outcome: { status: "done"; output: Output } | { status: "pending_approval" }
): Output {
  if (outcome.status === "done") return outcome.output;
  throw new PendingApprovalError();
}

/** The two lists are in byte order of name. A cursor retains each unread position. */
interface ListPart {
  cursor?: string | undefined;
  after?: string | undefined;
  done: boolean;
}
interface ListPosition {
  published: ListPart;
  assets: ListPart;
}

function listPartOf(value: unknown): ListPart {
  if (
    !isRecord(value) ||
    typeof value.done !== "boolean" ||
    (value.cursor !== undefined && typeof value.cursor !== "string") ||
    (value.after !== undefined && typeof value.after !== "string")
  ) {
    throw new Error("Invalid Workflow list cursor");
  }
  return { done: value.done, cursor: value.cursor, after: value.after };
}

function listPositionOf(cursor: string | undefined): ListPosition {
  if (cursor === undefined) return { published: { done: false }, assets: { done: false } };
  try {
    const value: unknown = JSON.parse(cursor);
    if (!isRecord(value)) throw new Error("Invalid Workflow list cursor");
    return { published: listPartOf(value.published), assets: listPartOf(value.assets) };
  } catch {
    throw new Error("Invalid Workflow list cursor");
  }
}

interface ListPage<Row> {
  items: readonly Row[];
  nextCursor?: string | undefined;
}

/**
 * Keeps one source page in memory during a read. A partially consumed page is read again
 * from its cursor next time, skipping names already consumed. Keeping the exclusive name
 * rather than an offset also tolerates an earlier row being deleted between reads.
 */
function listReader<Row>(
  position: ListPart,
  read: (cursor: string | undefined) => Promise<ListPage<Row>>,
  keyOf: (row: Row) => string,
  takeRead: () => boolean
) {
  let page: ListPage<Row> | undefined;
  return {
    async peek(): Promise<{ ready: false } | { ready: true; row: Row | undefined }> {
      while (!position.done) {
        if (page === undefined) {
          if (!takeRead()) return { ready: false };
          page = await read(position.cursor);
        }
        const row = page.items.find(
          (item) => position.after === undefined || keyOf(item) > position.after
        );
        if (row !== undefined) return { ready: true, row };
        position.cursor = page.nextCursor;
        position.after = undefined;
        position.done = page.nextCursor === undefined;
        page = undefined;
      }
      return { ready: true, row: undefined };
    },
    take(row: Row) {
      position.after = keyOf(row);
      if (page !== undefined && position.after === keyOf(page.items.at(-1) ?? row)) {
        position.cursor = page.nextCursor;
        position.after = undefined;
        position.done = page.nextCursor === undefined;
        page = undefined;
      }
    }
  };
}

/** The engine's summary of one published Workflow, read page after page until it is found. */
async function findSummary(client: WorkflowsClient, workflow: string, signal: AbortSignal) {
  let cursor: string | undefined;
  do {
    const page = await client.workflows.list({
      query: { limit: WORKFLOW_SUMMARY_PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) },
      signal
    });
    const summary = page.items.find((entry) => entry.id === workflow);
    if (summary !== undefined) return summary;
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return undefined;
}

/**
 * The source of an instance. The list joins engine start/run summaries with asset rights,
 * including Workflows held by write or publish alone. A definition is read as an asset.
 */
export function createInstanceSource(client: WorkflowsClient, key: string): WorkflowsSource {
  return {
    key,
    // Join the engine's start/run summaries with per-asset rights, including published
    // Workflows held by write or publish alone. Each source advances independently.
    listWorkflows: async (_workspaceId, query, signal) => {
      const position = listPositionOf(query.cursor);
      let reads = 0;
      const takeRead = () => reads++ < LIST_READS_PER_PAGE;
      const published = listReader(
        position.published,
        (cursor) => client.workflows.list({ query: { limit: query.limit, cursor }, signal }),
        (row) => row.id,
        takeRead
      );
      const assets = listReader(
        position.assets,
        (cursor) =>
          client.assets.list({
            params: { kind: WORKFLOW_ASSET_KIND },
            query: { limit: query.limit, cursor },
            signal
          }),
        (row) => row.name,
        takeRead
      );
      const items: WorkflowListItem[] = [];
      while (items.length < query.limit) {
        const [engine, asset] = await Promise.all([published.peek(), assets.peek()]);
        if (!engine.ready || !asset.ready) break;
        if (engine.row === undefined && asset.row === undefined) break;
        if (
          engine.row !== undefined &&
          (asset.row === undefined || engine.row.id <= asset.row.name)
        ) {
          const same = engine.row.id === asset.row?.name;
          items.push(toWorkflowListItem(engine.row, same ? asset.row : undefined));
          published.take(engine.row);
          if (same && asset.row !== undefined) assets.take(asset.row);
        } else if (asset.row !== undefined) {
          items.push(toAssetWorkflowListItem(asset.row));
          assets.take(asset.row);
        }
      }
      return {
        items,
        nextCursor:
          position.published.done && position.assets.done ? undefined : JSON.stringify(position)
      };
    },
    // The definition is the Workflow's asset, and so is whether a revision is published;
    // whether the instance starts it, and the id of its published revision, are on its entry
    // of the list. A Workflow the list does not name is not the reader's to start.
    getWorkflow: async (_workspaceId, workflow, signal) => {
      const [asset, summary] = await Promise.all([
        client.assets.get({ params: { kind: WORKFLOW_ASSET_KIND, name: workflow }, signal }),
        findSummary(client, workflow, signal)
      ]);
      const { manifest } = asset.config;
      return toWorkflow(
        {
          name: asset.name,
          config: isRecord(manifest) ? manifest : {},
          publishedRevision: asset.publishedRevision
        },
        summary === undefined ? { ...listedOf(summary), runsAs: asset.runsAs } : listedOf(summary),
        asset
      );
    },
    runs: runsSource(client),
    publishRights: {
      read: async (workflow, signal) =>
        client.workflows.principal_rights({ params: { workflow }, signal }),
      // The ordinary grant write, with every rule it asks; one right at a time.
      give: async (grant) => {
        done(
          await client.permissions.grant({
            body: principalGrantRequest({
              principalId: grant.holderId,
              action: grant.action,
              assetId: grant.scopeId
            })
          })
        );
      }
    },
    // The sentence on a publish is the one the asset read of that revision words.
    publishNarrative: {
      read: async (workflow, revision, signal) =>
        (
          await client.assets.get({
            params: { kind: WORKFLOW_ASSET_KIND, name: workflow },
            query: { revision: String(revision) },
            signal
          })
        ).publishNarrative
    },
    // A draft is published and discarded as the draft of any asset is.
    drafts: {
      publish: async (workflow, revision) => {
        done(
          await client.assets.publish({
            params: { kind: WORKFLOW_ASSET_KIND, name: workflow },
            body: { revision }
          })
        );
      },
      discard: async (workflow, expectedRevision) => {
        done(
          await client.assets.discard_draft({
            params: { kind: WORKFLOW_ASSET_KIND, name: workflow },
            body: { expectedRevision }
          })
        );
      },
      test: async (workflow, input) =>
        toWorkflowRun(done(await client.workflows.test({ params: { workflow }, body: { input } }))),
      listLiveOnce: async (workflow, signal) =>
        (
          await client.assets.list_live_once({
            params: { kind: WORKFLOW_ASSET_KIND, name: workflow },
            signal
          })
        ).items.map((item) => ({
          step: item.part,
          switchedAt: item.switchedAt,
          ...(item.usedByRunId === undefined || item.usedAt === undefined
            ? {}
            : { used: { runId: item.usedByRunId, at: item.usedAt } })
        })),
      runLiveOnce: async (workflow, step, expectedRevision) => {
        done(
          await client.assets.run_live_once({
            params: { kind: WORKFLOW_ASSET_KIND, name: workflow },
            body: { part: step, expectedRevision }
          })
        );
      }
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
