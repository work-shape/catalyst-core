import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  AppError,
  WORKFLOW_MANIFEST_FILE,
  type ConfigAssetStore,
  type StorePage,
  type WorkflowKind,
  type WorkflowManifest
} from "@work-shape/catalyst-core";
import {
  readWorkflowManifest,
  workflowManifestFingerprint,
  type WorkflowDefinitionIssue
} from "./definition";

/** One revision of a definition: what a run is started on and keeps to its end. */
export interface WorkflowDefinitionRevision {
  /** The id of the revision. A run keeps it as its `definitionRevisionId`. */
  revisionId: string;
  manifest: WorkflowManifest;
}

/** A Workflow as a list names it. */
export interface WorkflowDefinitionSummary {
  kind?: WorkflowKind;
  id: string;
  name: string;
  description?: string;
}

/**
 * Where the engine reads the published definition of a Workflow when a run is started. The
 * engine keeps a copy on the run with the id of its revision and never asks again for it, so
 * a definition that changes while a run is going changes nothing of that run.
 */
export interface WorkflowDefinitionSource {
  /** The published revision of the Workflow of this id, or nothing where none is published. */
  read(
    id: string,
    /** Database-backed sources use these readers while a publish holds its transaction. */
    configAssets?: Pick<ConfigAssetStore, "getConfigAsset">
  ): Promise<WorkflowDefinitionRevision | undefined>;
  /** The published cron texts even when the rest of the definition cannot be run.
   * Database-backed sources keep refused definitions scheduled until repaired or withdrawn. */
  readScheduleCrons?(id: string): Promise<string[]>;
  /** A page of published definitions in byte order of id, after the exclusive id cursor. */
  list(page?: StorePage): Promise<WorkflowDefinitionSummary[]>;
}

/** Bounds a discovery read; callers keep the exclusive id to reach every definition. */
export const WORKFLOW_DEFINITION_PAGE_SIZE = 200;

/** Operation discovery consumes every page; an empty/short page ends the walk. */
export async function* workflowDefinitionPages(source: WorkflowDefinitionSource) {
  let after: StorePage["after"];
  while (true) {
    const items = await source.list({
      limit: WORKFLOW_DEFINITION_PAGE_SIZE,
      ...(after ? { after } : {})
    });
    yield items;
    if (items.length < WORKFLOW_DEFINITION_PAGE_SIZE) return;
    const last = items.at(-1);
    if (!last) return;
    after = [last.id];
  }
}

/** A source that knows no Workflow: what an instance has until definitions are stored. */
export const noWorkflowDefinitions: WorkflowDefinitionSource = {
  read: () => Promise.resolve(undefined),
  list: () => Promise.resolve([])
};

/**
 * The refusal of a definition that cannot be run, for a save, a publish and a start alike. Its
 * reason is the contract's code where an issue carries one (`block_depth`,
 * `reference_out_of_scope`, `duplicate_step_id`, `not_supported_yet`,
 * `operation_not_callable`), and every issue is in its details.
 */
export function workflowDefinitionRefusal(
  workflow: string,
  issues: readonly WorkflowDefinitionIssue[]
): AppError {
  const coded = issues.find((issue) => issue.code !== undefined);
  const first = coded ?? issues[0];
  return new AppError(
    "VALIDATION_FAILED",
    `The definition of the Workflow '${workflow}' cannot be run${first ? `: ${first.message}` : ""}`,
    { reason: coded?.code ?? "definition_invalid", issues: [...issues] }
  );
}

/** What a folder name may be so that it is read: an id, and never a path. */
const FOLDER_NAME = /^[a-z][a-z0-9_-]{0,62}$/u;

const isMissing = (error: unknown): boolean =>
  error instanceof Error &&
  "code" in error &&
  (error.code === "ENOENT" || error.code === "ENOTDIR");

/**
 * Definitions as folders of one directory: `<root>/<id>/workflow.yaml`, the shape a Workflow
 * has as an asset. It stores nothing and is read on every start, and the fingerprint of the
 * file's content is the id of its revision. A definition that cannot be run answers the start
 * with what is wrong with it.
 */
export function createWorkflowFolderSource(root: string): WorkflowDefinitionSource {
  async function textOf(id: string): Promise<string | undefined> {
    if (!FOLDER_NAME.test(id)) return undefined;
    try {
      return await readFile(join(root, id, WORKFLOW_MANIFEST_FILE), "utf8");
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }
  return {
    async read(id) {
      const text = await textOf(id);
      if (text === undefined) return undefined;
      const result = readWorkflowManifest(text);
      if (!result.ok) throw workflowDefinitionRefusal(id, result.issues);
      if (result.manifest.id !== id) {
        throw new AppError("CONFLICT", `The definition in the folder '${id}' names another id`, {
          reason: "definition_invalid"
        });
      }
      return {
        revisionId: workflowManifestFingerprint(result.manifest),
        manifest: result.manifest
      };
    },
    async list(page = { limit: WORKFLOW_DEFINITION_PAGE_SIZE }) {
      const summaries: WorkflowDefinitionSummary[] = [];
      for (const folder of (await readdir(root)).sort()) {
        if (typeof page.after?.[0] === "string" && folder <= page.after[0]) continue;
        if (summaries.length >= page.limit) break;
        const text = await textOf(folder);
        const result = text === undefined ? undefined : readWorkflowManifest(text);
        // A folder whose file cannot be run is no Workflow anybody can start.
        if (!result?.ok || result.manifest.id !== folder) continue;
        const { id, name, description, kind } = result.manifest;
        summaries.push({
          id,
          name,
          kind: kind ?? "process",
          ...(description === undefined ? {} : { description })
        });
      }
      return summaries;
    }
  };
}
