import { ApiError, type ApiClient } from "@work-shape/catalyst-api-client";
import type { Asset } from "@work-shape/catalyst-api-client";
import { WORKFLOW_ACTIONS, WORKFLOW_ASSET_KIND } from "@work-shape/catalyst-core";
import { principalGrantRequest } from "../../admin/access/principal-grants-model";
import { PendingApprovalError } from "../build-area/build-refusals";
import {
  appCallersOf,
  listedOf,
  toAssetWorkflowListItem,
  toWorkflow,
  toWorkflowListItem,
  toWorkflowRun,
  toWorkflowStepRun
} from "./workflow-mapping";
import type {
  WorkflowRunsSource,
  WorkflowStepChoicesSource,
  WorkflowsSource
} from "./source-shapes";
import type {
  WorkflowDefinitionView,
  WorkflowListItem,
  WorkflowStepRunView
} from "./workflow-views";

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
type WorkflowsClient = Pick<
  ApiClient,
  "workflows" | "assets" | "permissions" | "operations" | "knowledge_bases"
>;

/**
 * What a step's Settings offer: the operations the reader may call from a step, and the
 * published Workflows that list the trigger `parent`, of the instance and of the workspace.
 * One the reader may only use is not offered: the step's own read of it would be refused.
 */
function stepChoicesSource(client: WorkflowsClient): WorkflowStepChoicesSource {
  return {
    listOperations: async (cursor, signal) => {
      const page = await client.operations.list_callable({
        query: { for: "workflow", ...(cursor === undefined ? {} : { cursor }) },
        signal
      });
      return {
        items: page.operations.map((operation) => ({
          name: operation.name,
          title: operation.title,
          ...(operation.description === undefined ? {} : { description: operation.description }),
          effect: operation.effect,
          source: operation.source,
          available: operation.available,
          ...(operation.inputSchema === undefined ? {} : { inputSchema: operation.inputSchema })
        })),
        nextCursor: page.nextCursor
      };
    },
    listChildWorkflows: async (workspaceId, cursor, signal) => {
      const page = await client.workflows.list({
        query: { limit: WORKFLOW_SUMMARY_PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) },
        signal
      });
      return {
        items: page.items
          .filter(
            (row) =>
              (row.workspaceId === undefined || row.workspaceId === workspaceId) &&
              (row.triggers ?? []).includes("parent") &&
              row.actions.includes(WORKFLOW_ACTIONS.read)
          )
          .map((row) => ({
            id: row.id,
            name: row.name.trim() || row.id,
            ...(row.inputs === undefined ? {} : { inputs: row.inputs }),
            mayStart: row.actions.includes(WORKFLOW_ACTIONS.use)
          })),
        nextCursor: page.nextCursor
      };
    }
  };
}

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

/**
 * The lists are in byte order of name: the engine's, the instance's assets and the open
 * workspace's assets (WS-OWN-1b). A cursor retains each unread position.
 */
interface ListPart {
  cursor?: string | undefined;
  after?: string | undefined;
  done: boolean;
}
interface ListPosition {
  published: ListPart;
  assets: ListPart;
  workspaceAssets: ListPart;
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
  if (cursor === undefined)
    return {
      published: { done: false },
      assets: { done: false },
      workspaceAssets: { done: false }
    };
  try {
    const value: unknown = JSON.parse(cursor);
    if (!isRecord(value)) throw new Error("Invalid Workflow list cursor");
    return {
      published: listPartOf(value.published),
      assets: listPartOf(value.assets),
      workspaceAssets: listPartOf(value.workspaceAssets)
    };
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

type ListReader<Row> = ReturnType<typeof listReader<Row>>;

/**
 * Two readers of rows that never share a name, as one in byte order of name: the assets of the
 * instance and those of one workspace, since a name is unique on the instance.
 */
function mergedReader<Row>(
  first: ListReader<Row>,
  second: ListReader<Row>,
  keyOf: (row: Row) => string
): Pick<ListReader<Row>, "peek" | "take"> {
  const from = new Map<string, ListReader<Row>>();
  return {
    async peek() {
      const [a, b] = await Promise.all([first.peek(), second.peek()]);
      if (!a.ready || !b.ready) return { ready: false };
      const row =
        a.row === undefined
          ? b.row
          : b.row === undefined || keyOf(a.row) <= keyOf(b.row)
            ? a.row
            : b.row;
      if (row !== undefined) from.set(keyOf(row), row === a.row ? first : second);
      return { ready: true, row };
    },
    take(row: Row) {
      (from.get(keyOf(row)) ?? first).take(row);
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

/** The owners of the Workflows read so far, per client of an instance (see `createInstanceSource`). */
const knownOwners = new WeakMap<WorkflowsClient, Map<string, string | undefined>>();
function ownersOf(client: WorkflowsClient): Map<string, string | undefined> {
  const known = knownOwners.get(client) ?? new Map<string, string | undefined>();
  knownOwners.set(client, known);
  return known;
}

/** An explicit move supersedes the owner learned by earlier reads of this Workflow. */
export function rememberWorkflowOwner(
  client: WorkflowsClient,
  workflow: string,
  workspaceId: string | undefined
): void {
  ownersOf(client).set(workflow, workspaceId);
}

/**
 * The source of an instance. The list joins engine start/run summaries with asset rights,
 * including Workflows held by write or publish alone. A definition is read as an asset.
 */
export function createInstanceSource(client: WorkflowsClient, key: string): WorkflowsSource {
  // The workspace that owns each Workflow read so far (WS-OWN-1b): an asset is addressed in
  // the scope of its owner, and a name is unique on the instance. Kept per client, not per
  // source: every screen makes a source of its own.
  const owners = ownersOf(client);
  const learn = (workflow: string, scope: { kind: string; workspaceId?: string } | undefined) => {
    if (scope !== undefined)
      owners.set(workflow, scope.kind === "workspace" ? scope.workspaceId : undefined);
  };
  const ownerOf = (workflow: string): { workspaceId?: string } => {
    const workspaceId = owners.get(workflow);
    return workspaceId === undefined ? {} : { workspaceId };
  };
  /**
   * The owner of a Workflow not read before: the open workspace where its list holds it, else
   * the instance. Asked by a list, as a conversation's subject is, so no read answers 404.
   */
  const findOwner = async (workflow: string, workspaceId: string, signal: AbortSignal) => {
    const here = await client.assets.list({
      params: { kind: WORKFLOW_ASSET_KIND },
      query: { workspaceId, prefix: workflow, limit: 50 },
      signal
    });
    const owned = here.items.some(
      (item) => item.name === workflow && item.scope.kind === "workspace"
    );
    owners.set(workflow, owned ? workspaceId : undefined);
  };
  /** The asset of a Workflow, read in the scope of its owner. */
  const readAsset = async (
    workflow: string,
    workspaceId: string,
    signal: AbortSignal,
    revision?: number
  ) => {
    if (!owners.has(workflow) && workspaceId !== "") await findOwner(workflow, workspaceId, signal);
    return client.assets.get({
      params: { kind: WORKFLOW_ASSET_KIND, name: workflow },
      query: {
        ...ownerOf(workflow),
        ...(revision === undefined ? {} : { revision: String(revision) })
      },
      signal
    });
  };
  return {
    key,
    // Join the engine's start/run summaries with per-asset rights, including published
    // Workflows held by write or publish alone. Each source advances independently.
    listWorkflows: async (workspaceId, query, signal) => {
      const position = listPositionOf(query.cursor);
      let reads = 0;
      const takeRead = () => reads++ < LIST_READS_PER_PAGE;
      // The instance's Workflows and the open workspace's; another workspace's are its own.
      const published = listReader(
        position.published,
        async (cursor) => {
          const page = await client.workflows.list({
            query: { limit: query.limit, cursor },
            signal
          });
          return {
            ...page,
            items: page.items.filter(
              (row) => row.workspaceId === undefined || row.workspaceId === workspaceId
            )
          };
        },
        (row) => row.id,
        takeRead
      );
      const assetsIn = (part: ListPart, scope: { workspaceId?: string }) =>
        listReader(
          part,
          (cursor) =>
            client.assets.list({
              params: { kind: WORKFLOW_ASSET_KIND },
              query: { limit: query.limit, cursor, ...scope },
              signal
            }),
          (row) => row.name,
          takeRead
        );
      if (workspaceId === "") position.workspaceAssets.done = true;
      const assets = mergedReader(
        assetsIn(position.assets, {}),
        assetsIn(position.workspaceAssets, { workspaceId }),
        (row) => row.name
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
          learn(
            engine.row.id,
            same
              ? asset.row?.scope
              : engine.row.workspaceId === undefined
                ? { kind: "instance" }
                : { kind: "workspace", workspaceId: engine.row.workspaceId }
          );
          items.push(toWorkflowListItem(engine.row, same ? asset.row : undefined));
          published.take(engine.row);
          if (same && asset.row !== undefined) assets.take(asset.row);
        } else if (asset.row !== undefined) {
          learn(asset.row.name, asset.row.scope);
          items.push(toAssetWorkflowListItem(asset.row));
          assets.take(asset.row);
        }
      }
      return {
        items,
        nextCursor:
          position.published.done && position.assets.done && position.workspaceAssets.done
            ? undefined
            : JSON.stringify(position)
      };
    },
    // The definition is the Workflow's asset, and so is whether a revision is published;
    // whether the instance starts it, and the id of its published revision, are on its entry
    // of the list. A Workflow the list does not name is not the reader's to start.
    getWorkflow: async (workspaceId, workflow, signal) => {
      const [asset, summary] = await Promise.all([
        readAsset(workflow, workspaceId, signal),
        findSummary(client, workflow, signal)
      ]);
      learn(workflow, asset.scope);
      const definition = definitionOf(asset);
      return {
        ...toWorkflow(
          {
            name: asset.name,
            config: definition.manifest,
            publishedRevision: asset.publishedRevision
          },
          summary === undefined
            ? { ...listedOf(summary), runsAs: asset.runsAs }
            : listedOf(summary),
          asset
        ),
        definition,
        ...appCallersOf(asset),
        ...(asset.workflowCallers === undefined
          ? {}
          : {
              callers: asset.workflowCallers.map((caller) => ({
                id: caller.name,
                title: caller.title.trim() || caller.name,
                ...(caller.scope.kind === "workspace"
                  ? { workspaceId: caller.scope.workspaceId }
                  : {})
              }))
            })
      };
    },
    runs: runsSource(client),
    stepChoices: stepChoicesSource(client),
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
        (await readAsset(workflow, "", signal, revision)).publishNarrative
    },
    // The question before a delete names what the delete ends in the Knowledge Bases; an
    // instance without them answers none (KBW-2c).
    removal: {
      read: async (workflow, signal) => {
        const [asset, sources] = await Promise.all([
          readAsset(workflow, "", signal),
          client.knowledge_bases
            .workflow_sources({ params: { workflow }, signal })
            .catch((error: unknown) => {
              if (error instanceof ApiError && error.status === 404) return undefined;
              throw error;
            })
        ]);
        return {
          revision: asset.revision,
          knowledgeBases: sources?.knowledgeBases ?? [],
          hidden: sources?.hidden ?? { knowledgeBases: 0, documents: 0 }
        };
      },
      remove: async (workflow, expectedRevision) => {
        done(
          await client.assets.delete({
            params: { kind: WORKFLOW_ASSET_KIND, name: workflow },
            body: { expectedRevision, ...ownerOf(workflow) }
          })
        );
      }
    },
    // A draft is published and discarded as the draft of any asset is.
    drafts: {
      publish: async (workflow, revision) => {
        done(
          await client.assets.publish({
            params: { kind: WORKFLOW_ASSET_KIND, name: workflow },
            body: { revision, ...ownerOf(workflow) }
          })
        );
      },
      discard: async (workflow, expectedRevision) => {
        done(
          await client.assets.discard_draft({
            params: { kind: WORKFLOW_ASSET_KIND, name: workflow },
            body: { expectedRevision, ...ownerOf(workflow) }
          })
        );
      },
      test: async (workflow, input) =>
        toWorkflowRun(done(await client.workflows.test({ params: { workflow }, body: { input } }))),
      listLiveOnce: async (workflow, signal) =>
        (
          await client.assets.list_live_once({
            params: { kind: WORKFLOW_ASSET_KIND, name: workflow },
            query: ownerOf(workflow),
            signal
          })
        ).items.map((item) => ({
          step: item.part,
          switchedAt: item.switchedAt,
          ...(item.usedByRunId === undefined || item.usedAt === undefined
            ? {}
            : { used: { runId: item.usedByRunId, at: item.usedAt } })
        })),
      readRevision: async (workflow, revision, signal) =>
        definitionOf(await readAsset(workflow, "", signal, revision)),
      validate: async (workflow, config) =>
        (
          await client.assets.validate({
            params: { kind: WORKFLOW_ASSET_KIND },
            body: { config: { ...config }, ...ownerOf(workflow) }
          })
        ).issues.map((issue) => ({
          message: issue.message,
          path: issue.path ?? [],
          ...(issue.code === undefined ? {} : { code: issue.code })
        })),
      save: async (workflow, config, expectedRevision) => {
        const saved = done(
          await client.assets.put({
            params: { kind: WORKFLOW_ASSET_KIND, name: workflow },
            body: { config: { ...config }, expectedRevision, ...ownerOf(workflow) }
          })
        );
        return { revision: saved.revision };
      },
      runLiveOnce: async (workflow, step, expectedRevision) => {
        done(
          await client.assets.run_live_once({
            params: { kind: WORKFLOW_ASSET_KIND, name: workflow },
            body: { part: step, expectedRevision, ...ownerOf(workflow) }
          })
        );
      }
    }
  };
}

/** A revision as the asset read answers it, for editing by hand. */
function definitionOf(
  asset: Pick<Asset, "config" | "revision" | "contentRevision" | "stepFacts">
): WorkflowDefinitionView {
  const { manifest } = asset.config;
  return {
    config: asset.config,
    manifest: isRecord(manifest) ? manifest : {},
    revision: asset.contentRevision ?? asset.revision,
    ...(asset.stepFacts === undefined ? {} : { stepFacts: asset.stepFacts })
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
