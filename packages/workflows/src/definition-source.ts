import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AppError, WORKFLOW_MANIFEST_FILE, type WorkflowManifest } from "@vivd-catalyst/core";
import { readWorkflowManifest } from "./definition";

/**
 * Where the engine reads the published definition of a Workflow when a run is started. The
 * engine keeps a copy on the run and never asks again for it.
 */
export interface WorkflowDefinitionSource {
  /** The definition of the Workflow of this id, or nothing where none is published. */
  read(id: string): Promise<WorkflowManifest | undefined>;
}

/** A source that knows no Workflow: what an instance has until definitions are stored. */
export const noWorkflowDefinitions: WorkflowDefinitionSource = {
  read: () => Promise.resolve(undefined)
};

/** What a folder name may be so that it is read: an id, and never a path. */
const FOLDER_NAME = /^[a-z][a-z0-9_-]{0,62}$/u;

/**
 * Definitions as folders of one directory: `<root>/<id>/workflow.yaml`, the shape a Workflow
 * has as an asset. It stores nothing and is read on every start. A definition that cannot be
 * run answers the start with what is wrong with it.
 */
export function createWorkflowFolderSource(root: string): WorkflowDefinitionSource {
  return {
    async read(id) {
      if (!FOLDER_NAME.test(id)) return undefined;
      let text: string;
      try {
        text = await readFile(join(root, id, WORKFLOW_MANIFEST_FILE), "utf8");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      }
      const result = readWorkflowManifest(text);
      if (!result.ok) {
        throw new AppError("CONFLICT", `The definition of the Workflow '${id}' cannot be run`, {
          reason: "definition_invalid",
          issues: result.issues
        });
      }
      if (result.manifest.id !== id) {
        throw new AppError("CONFLICT", `The definition in the folder '${id}' names another id`, {
          reason: "definition_invalid"
        });
      }
      return result.manifest;
    }
  };
}
