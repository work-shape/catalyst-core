import { listAll, type ApiClient } from "@vivd-catalyst/api-client";
import { WORKFLOW_ASSET_KIND } from "@vivd-catalyst/core";
import { PendingApprovalError } from "../build-area/build-refusals";
import {
  listedOf,
  toDraftWorkflowListItem,
  toWorkflow,
  toWorkflowListItem,
  toWorkflowRun,
  toWorkflowStepRun
} from "./workflow-mapping";
import type { WorkflowRunsSource, WorkflowsSource } from "./source-shapes";
import type { WorkflowStepRunView } from "./workflow-views";

// The Workflow screens over the instance: the operations of the Workflows module and, for a
// definition, the read of an asset.

/** How many step runs one read of a run's frame asks for: the most a list read gives. */
const FRAME_PAGE_SIZE = 200;
/**
 * How many reads a run's frame takes at most. The contract has no read of the step runs
 * outside the items of a loop yet, so the frame is picked out of all step runs of the run, in
 * the order they were made. A run with more step runs than these reads hold is drawn as far as
 * they reach, and its page says so.
 */
const FRAME_MAX_PAGES = 10;

/** The part of the client the Workflow screens call. */
type WorkflowsClient = Pick<ApiClient, "workflows" | "assets">;

function runsSource(client: WorkflowsClient): WorkflowRunsSource {
  return {
    listRuns: async (workflow, query, signal) => {
      const page = await client.workflows.list_runs({
        params: { workflow },
        query: { limit: query.limit, cursor: query.cursor },
        signal
      });
      return { items: page.items.map(toWorkflowRun), nextCursor: page.nextCursor };
    },
    getRun: async (runId, signal) =>
      toWorkflowRun(await client.workflows.get_run({ params: { runId }, signal })),
    listFrameStepRuns: async (runId, signal) => {
      const stepRuns: WorkflowStepRunView[] = [];
      let cursor: string | undefined;
      for (let read = 0; read < FRAME_MAX_PAGES; read += 1) {
        const page = await client.workflows.list_step_runs({
          params: { runId },
          query: { limit: FRAME_PAGE_SIZE, cursor },
          signal
        });
        for (const stepRun of page.items) {
          // A step run of an item of a loop is one of many: the loop's counts stand for them.
          if (stepRun.iteration === undefined) {
            stepRuns.push(toWorkflowStepRun(stepRun));
          }
        }
        cursor = page.nextCursor;
        if (cursor === undefined) {
          return { stepRuns, complete: true };
        }
      }
      return { stepRuns, complete: false };
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
 * The source of an instance. The list is the engine's: the published Workflows the reader may
 * read, each with its latest run. A definition is read as an asset, the shape a Workflow is
 * stored in.
 */
export function createInstanceSource(client: WorkflowsClient, key: string): WorkflowsSource {
  return {
    key,
    // The engine lists what is published; a Workflow never published is listed from its
    // asset, as a draft. The screen shows a draft only to who may write Workflows.
    listWorkflows: async (_workspaceId, _query, signal) => {
      const [{ items }, assets] = await Promise.all([
        client.workflows.list({ signal }),
        listAll((paging) =>
          client.assets.list({ params: { kind: WORKFLOW_ASSET_KIND }, query: paging, signal })
        )
      ]);
      const listed = new Set(items.map((entry) => entry.id));
      const drafts = assets.filter(
        (asset) => asset.publishedRevision === undefined && !listed.has(asset.name)
      );
      return {
        items: [...items.map(toWorkflowListItem), ...drafts.map(toDraftWorkflowListItem)],
        // The engine's list is whole in one answer, and the drafts are read to their end.
        nextCursor: undefined
      };
    },
    // The definition is the Workflow's asset; whether the instance starts it, and the id of
    // its published revision, are on its entry of the list. A Workflow the list does not name
    // has no published revision.
    getWorkflow: async (_workspaceId, workflow, signal) => {
      const [asset, { items }] = await Promise.all([
        client.assets.get({ params: { kind: WORKFLOW_ASSET_KIND, name: workflow }, signal }),
        client.workflows.list({ signal })
      ]);
      const summary = items.find((entry) => entry.id === workflow);
      const { manifest } = asset.config;
      return toWorkflow(
        {
          name: asset.name,
          config: isRecord(manifest) ? manifest : {},
          publishedRevision: summary === undefined ? undefined : asset.publishedRevision
        },
        summary === undefined ? { ...listedOf(summary), runsAs: asset.runsAs } : listedOf(summary),
        asset
      );
    },
    runs: runsSource(client),
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
