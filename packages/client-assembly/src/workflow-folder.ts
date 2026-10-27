import { AppError, WORKFLOW_MANIFEST_FILE, readYamlData } from "@work-shape/catalyst-core";
import { workflowConfigSchema } from "@work-shape/catalyst-config-schema";
import type { WorkflowAssetKind } from "@work-shape/catalyst-server";
import {
  WORKFLOW_SOURCE_DEFAULTS,
  codeEntry,
  indexWorkflowSteps,
  workflowSourceIssues,
  parseWorkflowManifest,
  type WorkflowSourceLimits,
  workflowStepFileIssues,
  workflowStepFilesRefusal,
  writeWorkflowManifest,
  type WorkflowStepFile
} from "@work-shape/catalyst-workflows";

import { editWorkflowManifest } from "./workflow-yaml-edit";

// The immutable file set holds the complete Workflow folder. Config stays the existing read
// model; only legacy scripts needed for a one-release rollback are also held inline.

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
export function workflowRevisionFiles(
  limits: WorkflowSourceLimits = WORKFLOW_SOURCE_DEFAULTS
): NonNullable<WorkflowAssetKind["revisionFiles"]> {
  return {
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
      const issues = workflowSourceIssues(
        files.map((file) => ({ path: file.path, bytes: file.bytes.byteLength })),
        limits
      );
      if (issues.length) throw workflowStepFilesRefusal(name, issues);
      const parsed = parseWorkflowManifest(readManifest(manifest.bytes));
      if (!parsed.ok)
        throw refusal(
          "definition_invalid",
          parsed.issues[0]?.message ?? "Invalid manifest",
          WORKFLOW_MANIFEST_FILE
        );
      // Keep the previous release's scripts for a one-release rollback only.
      const rollback: WorkflowStepFile[] = [];
      const legacyPaths = new Set(
        [...indexWorkflowSteps(parsed.manifest).values()].flatMap(({ step }) =>
          step.type === "code" && step.file !== undefined ? [codeEntry(step)] : []
        )
      );
      let rollbackBytes = 0;
      for (const file of files) {
        if (
          !legacyPaths.has(file.path) ||
          !/^steps\/.+\.(py|js|mjs)$/iu.test(file.path) ||
          file.bytes.byteLength > 256 * 1024
        )
          continue;
        const content = textOf(file.bytes);
        if (content === undefined || rollbackBytes + file.bytes.byteLength > 2 * 1024 ** 2)
          continue;
        rollback.push({ path: file.path, content });
        rollbackBytes += file.bytes.byteLength;
      }
      const missing = workflowStepFileIssues(
        parsed.manifest,
        files.map((file) => ({ path: file.path, content: "" })),
        limits
      );
      if (missing.length) throw workflowStepFilesRefusal(name, missing);
      return {
        config: {
          name,
          manifest: parsed.manifest,
          ...(rollback.length ? { files: rollback } : {})
        },
        extras: files
          .filter((file) => file !== manifest && !rollback.some((old) => old.path === file.path))
          .map((file) => file.path)
      };
    },
    manifestOf: () => ({ kind: "workflow" }),
    indexed: (config) => config,
    carried: (config) => config,
    filesOfConfig(config) {
      const workflow = workflowConfigSchema.safeParse(config);
      // A config whose files the engine refuses has no folder: its write is refused as before.
      if (
        !workflow.success ||
        workflowStepFileIssues({ steps: [] }, workflow.data.files ?? [], limits).length > 0
      )
        return [];
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
    editManifest(config, bytes) {
      const workflow = workflowConfigSchema.safeParse(config);
      const original = textOf(bytes);
      if (!workflow.success || original === undefined) return undefined;
      const edited = editWorkflowManifest(original, workflow.data.manifest);
      return edited === undefined ? undefined : encode(edited);
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
        const parsed = parseWorkflowManifest(readManifest(file.bytes));
        const expected = parseWorkflowManifest(workflow.data.manifest);
        return (
          parsed.ok &&
          expected.ok &&
          writeWorkflowManifest(parsed.manifest) === writeWorkflowManifest(expected.manifest)
        );
      } catch {
        return false;
      }
    }
  };
}

export const WORKFLOW_REVISION_FILES = workflowRevisionFiles();
