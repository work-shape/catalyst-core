import type { ApiClient } from "@work-shape/catalyst-api-client";
import { WORKFLOW_ASSET_KIND } from "@work-shape/catalyst-core";
import { principalGrantRequest } from "../../admin/access/principal-grants-model";
import { PendingApprovalError } from "../build-area/build-refusals";
import {
  listedOf,
  toAssetWorkflowListItem,
  toDraftWorkflowListItem,
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
 * How many reads one page of the screen's list makes at most while they find nothing to show.
 * What is left is handed on as the page's cursor.
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

/**
 * Where the next page of the list starts. The list is the published Workflows, as the engine
 * pages them, and then the drafts, as the asset list pages them. A cursor of the screen names
 * the part and the cursor of that part's own list.
 */
type ListPosition = { part: "published" | "drafts"; cursor: string | undefined };

const PUBLISHED_PREFIX = "published:";
const DRAFTS_PREFIX = "drafts:";

function listPositionOf(cursor: string | undefined): ListPosition {
  if (cursor?.startsWith(DRAFTS_PREFIX)) {
    return { part: "drafts", cursor: cursor.slice(DRAFTS_PREFIX.length) || undefined };
  }
  return {
    part: "published",
    cursor: cursor?.startsWith(PUBLISHED_PREFIX)
      ? cursor.slice(PUBLISHED_PREFIX.length) || undefined
      : undefined
  };
}

/** One read of one part of the list, with the screen's cursor of what follows it. */
async function readListPart(
  client: WorkflowsClient,
  position: ListPosition,
  limit: number,
  signal: AbortSignal
): Promise<{ items: WorkflowListItem[]; nextCursor: string | undefined }> {
  const paging = { limit, ...(position.cursor === undefined ? {} : { cursor: position.cursor }) };
  if (position.part === "published") {
    const page = await client.workflows.list({ query: paging, signal });
    return {
      items: page.items.map((item) => toWorkflowListItem(item)),
      nextCursor: page.nextCursor === undefined ? DRAFTS_PREFIX : PUBLISHED_PREFIX + page.nextCursor
    };
  }
  const page = await client.assets.list({
    params: { kind: WORKFLOW_ASSET_KIND },
    query: paging,
    signal
  });
  return {
    items: page.items
      .filter((asset) => asset.publishedRevision === undefined)
      .map(toDraftWorkflowListItem),
    nextCursor: page.nextCursor === undefined ? undefined : DRAFTS_PREFIX + page.nextCursor
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
 * The source of an instance. The list is the engine's: the published Workflows the reader may
 * read, each with its latest run. A definition is read as an asset, the shape a Workflow is
 * stored in.
 */
export function createInstanceSource(client: WorkflowsClient, key: string): WorkflowsSource {
  return {
    key,
    // The engine lists what is published; a Workflow never published is listed from its
    // asset, as a draft, after the published ones. The screen shows a draft only to who may
    // write Workflows.
    listWorkflows: async (_workspaceId, query, signal) => {
      // A part may answer a page with nothing to show: the engine lists no published
      // Workflow, or a page of assets holds only published ones. The next read follows at
      // once, so the screen meets an empty page only after LIST_READS_PER_PAGE such reads.
      const items: WorkflowListItem[] = [];
      let cursor = query.cursor;
      for (let read = 0; read < LIST_READS_PER_PAGE; read += 1) {
        const page = await readListPart(client, listPositionOf(cursor), query.limit, signal);
        items.push(...page.items);
        cursor = page.nextCursor;
        if (items.length > 0 || cursor === undefined) break;
      }
      return { items, nextCursor: cursor };
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
