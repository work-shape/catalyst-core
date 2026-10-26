import { AppError, WORKFLOW_MANIFEST_FILE, readYamlData } from "@work-shape/catalyst-core";
import { workflowConfigSchema } from "@work-shape/catalyst-config-schema";
import type { WorkflowAssetKind } from "@work-shape/catalyst-server";
import {
  WORKFLOW_CODE_ERRORS,
  workflowStepFileIssues,
  workflowStepFilesRefusal,
  writeWorkflowManifest,
  type WorkflowStepFile
} from "@work-shape/catalyst-workflows";

// A Workflow as a folder (WF-GIT-1): `workflow.yaml` and the files of its `steps/` folder, as
// the revision config `{ name, manifest, files }` holds them. The config holds every file of
// the folder, so the folder of a revision is always its config written out: a write of the
// config renders `workflow.yaml` from the manifest, and a write of the folder keeps the bytes
// of `workflow.yaml` it was sent and reads them into the manifest. The file set of every
// revision is that folder, and its commit holds the same.

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encode = (text: string) => new TextEncoder().encode(text);

function textOf(bytes: Uint8Array): string | undefined {
  try {
    return utf8.decode(bytes);
  } catch {
    return undefined;
  }
}

function refusal(reason: string, message: string, path: string): AppError {
  return new AppError("VALIDATION_FAILED", message, { reason, path }, { exposeMessage: true });
}

/**
 * What the engine refuses of the step files alone, whatever the steps name: a path outside
 * `steps/`, a file twice, text the store cannot hold, too many bytes. Asked before the folder
 * is stored, so such a write is refused as a save always was and nothing is committed.
 */
function stepFileIssues(files: readonly WorkflowStepFile[]) {
  return workflowStepFileIssues({ steps: [] }, files).filter(
    (issue) => issue.code !== WORKFLOW_CODE_ERRORS.fileUnused
  );
}

/** The manifest `workflow.yaml` holds, or the refusal of a file that holds none. */
function readManifest(bytes: Uint8Array): unknown {
  const text = textOf(bytes);
  if (text === undefined) {
    throw refusal(
      "workflow_file_not_text",
      `'${WORKFLOW_MANIFEST_FILE}' is no UTF-8 text.`,
      WORKFLOW_MANIFEST_FILE
    );
  }
  const read = readYamlData(text, WORKFLOW_MANIFEST_FILE, { refuseAliases: true });
  if (!read.ok) throw refusal(read.issue.code, read.issue.message, WORKFLOW_MANIFEST_FILE);
  return read.value;
}

/** The folder of a Workflow's revision, and the config a write of it makes. */
export const WORKFLOW_REVISION_FILES: NonNullable<WorkflowAssetKind["revisionFiles"]> = {
  manifestFile: WORKFLOW_MANIFEST_FILE,
  read(name, files) {
    const manifest = files.find((file) => file.path === WORKFLOW_MANIFEST_FILE);
    if (!manifest) {
      throw refusal(
        "workflow_manifest_missing",
        `The files hold no '${WORKFLOW_MANIFEST_FILE}'. Every write carries the whole folder of the Workflow, '${WORKFLOW_MANIFEST_FILE}' among it.`,
        WORKFLOW_MANIFEST_FILE
      );
    }
    const others = files
      .filter((file) => file !== manifest)
      .map(({ path, bytes }) => {
        const content = textOf(bytes);
        // A step's file is a script or instructions, which the config holds as text.
        if (content === undefined) {
          throw refusal("workflow_file_not_text", `The file '${path}' is no UTF-8 text.`, path);
        }
        return { path, content };
      })
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    const issues = stepFileIssues(others);
    if (issues.length > 0) throw workflowStepFilesRefusal(name, issues);
    return {
      config: {
        name,
        manifest: readManifest(manifest.bytes),
        ...(others.length > 0 ? { files: others } : {})
      },
      // The config holds every file: none is kept beside it alone.
      extras: []
    };
  },
  manifestOf: () => ({ kind: "workflow" }),
  indexed: (config) => config,
  carried: (config) => config,
  filesOfConfig(config) {
    const workflow = workflowConfigSchema.safeParse(config);
    // A config whose files the engine refuses has no folder: its write is refused as before.
    if (!workflow.success || stepFileIssues(workflow.data.files ?? []).length > 0) return [];
    return [
      {
        path: WORKFLOW_MANIFEST_FILE,
        bytes: encode(writeWorkflowManifest(workflow.data.manifest))
      },
      ...(workflow.data.files ?? []).map((file) => ({
        path: file.path,
        bytes: encode(file.content)
      }))
    ];
  },
  matchesConfig(config, file) {
    const workflow = workflowConfigSchema.safeParse(config);
    if (!workflow.success) return false;
    if (file.path !== WORKFLOW_MANIFEST_FILE) {
      const held = workflow.data.files?.find((candidate) => candidate.path === file.path);
      return held !== undefined && textOf(file.bytes) === held.content;
    }
    try {
      // Written out the same, whatever order of keys or comments the stored bytes hold.
      return (
        writeWorkflowManifest(readManifest(file.bytes)) ===
        writeWorkflowManifest(workflow.data.manifest)
      );
    } catch {
      return false;
    }
  }
};
