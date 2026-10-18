import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  AppError,
  WORKFLOW_MANIFEST_FILE,
  type ConfigAssetStore,
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
  /** The Workflows that have a published definition, by id. */
  list(): Promise<WorkflowDefinitionSummary[]>;
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
    async list() {
      const summaries: WorkflowDefinitionSummary[] = [];
      for (const folder of (await readdir(root)).sort()) {
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
