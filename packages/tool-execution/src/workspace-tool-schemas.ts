import { z } from "zod";
import type { JsonObject } from "@vivd-catalyst/core";

export interface WorkspaceCommandServiceLimits {
  defaultTimeoutSeconds: number;
  maxTimeoutSeconds: number;
  idleTimeoutSeconds?: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxWorkspaceBytes: number;
  maxReadFileBytes: number;
  maxReadPreviewBytes: number;
  maxApplyPatchBytes: number;
  maxCommandLength: number;
  maxExpectedOutputs: number;
  maxPreviewImages: number;
  maxPathLength: number;
  perConversationActiveCommands: number;
  perUserActiveCommands: number;
  globalActiveCommands: number;
}

export const DEFAULT_LIMITS: WorkspaceCommandServiceLimits = {
  defaultTimeoutSeconds: 60,
  maxTimeoutSeconds: 300,
  idleTimeoutSeconds: 30,
  maxStdoutBytes: 64 * 1024,
  maxStderrBytes: 64 * 1024,
  maxWorkspaceBytes: 100 * 1024 * 1024,
  maxReadFileBytes: 128 * 1024,
  maxReadPreviewBytes: 16 * 1024,
  maxApplyPatchBytes: 256 * 1024,
  maxCommandLength: 64 * 1024,
  maxExpectedOutputs: 32,
  maxPreviewImages: 12,
  maxPathLength: 512,
  perConversationActiveCommands: 1,
  perUserActiveCommands: 1,
  globalActiveCommands: 4
};

const workspacePathSchema = z.string().min(1).max(DEFAULT_LIMITS.maxPathLength);
const workspaceCommandDescription =
  "Complete Bash command or multiline script. Each call starts in /workspace unless cwd is provided for that call. The standard project directories scripts, artifacts, previews, and tmp are available at the start of every command. Files created or changed under /workspace persist across calls. Run helpers directly, e.g. `pptx_inspect deck.pptx --view summary`; do not write `set -e pptx_inspect ...`. For multiline create-and-verify commands, put `set -e` on its own line before later commands. Do not pass helper flags such as `--view`, `--spec`, `--out`, `--range`, `--page`, or `--sheet` to `cat`, `ls`, or `printf`.";
const workspaceCwdDescription =
  "Optional workspace-relative directory for this command only. It does not persist as the next command's cwd.";
const workspaceExpectedOutputsDescription =
  "Optional postconditions for files that should exist in /workspace after the command. Use kind \"directory\" only when checking that a rendered/generated directory contains tracked files. Use this for created outputs or verification steps that depend on an existing artifact. Set promote only when the command itself should promote the output.";
const workspaceImportPathDescription =
  "Optional workspace-relative destination path override. Usually omit this and use the returned importedFiles[].path exactly in workspace.exec.";
const workspaceApplyPatchDescription =
  "Unified diff patch for workspace text files. Use paths relative to /workspace, /workspace/path, or git-style a/path and b/path headers. Supports create, update, and delete; binary files and renames are rejected.";
const workspacePromotePathDescription =
  "Workspace path to the final user-facing artifact. Prefer artifacts/ or /workspace/artifacts/ outputs.";
const workspacePreviewArtifactDescription =
  "Managed source artifact id for DOCX/XLSX/PPTX/PDF preview rendering or already-managed image previews.";
const workspacePreviewPathDescription =
  "Workspace path to a rendered preview image, usually under previews/, e.g. previews/report/page-1.png or /workspace/previews/report/page-1.png.";
const workspacePreviewPathsDescription =
  "Workspace paths to rendered preview images, usually under previews/. Preview images are model-visible but are not user-download artifacts unless separately promoted.";
const workspacePreviewPagesDescription =
  "Optional PDF/DOCX page numbers to load when preview metadata has page numbers.";
const workspacePreviewSlidesDescription =
  "Optional PPTX slide numbers to load when preview metadata has slide numbers.";
const workspacePreviewSheetsDescription =
  "Optional XLSX sheet names to load when preview metadata has sheet labels.";
const workspacePreviewRangesDescription =
  "Optional XLSX ranges to load. Prefer sheet-qualified ranges like `Summary!A1:B4`; unqualified ranges require exactly one `sheets` value.";
const workspacePreviewMaxImagesDescription = "Maximum preview images to attach to model context.";
const workspacePreviewPositiveIntegerListSchema = z
  .array(z.number().int().min(1))
  .min(1)
  .max(DEFAULT_LIMITS.maxPreviewImages);
const workspacePreviewTextListSchema = z
  .array(z.string().min(1).max(160))
  .min(1)
  .max(DEFAULT_LIMITS.maxPreviewImages);

export const expectedOutputInputSchema = z
  .object({
    path: workspacePathSchema,
    kind: z.string().min(1).max(160).optional(),
    promote: z.boolean().default(false)
  })
  .strict();

export const workspaceExecInputSchema = z
  .object({
    command: z.string().min(1).max(DEFAULT_LIMITS.maxCommandLength).describe(workspaceCommandDescription),
    cwd: workspacePathSchema.describe(workspaceCwdDescription).optional(),
    timeoutSeconds: z.number().int().min(1).max(86_400).optional(),
    expectedOutputs: z
      .array(expectedOutputInputSchema)
      .max(DEFAULT_LIMITS.maxExpectedOutputs)
      .describe(workspaceExpectedOutputsDescription)
      .optional()
  })
  .strict();

export const workspaceListFilesInputSchema = z.object({}).strict();

export const workspaceImportFilesInputSchema = z
  .object({
    files: z
      .array(
        z
          .object({
            fileId: z.string().min(1).max(255),
            path: workspacePathSchema.describe(workspaceImportPathDescription).optional()
          })
          .strict()
      )
      .min(1)
      .max(16)
  })
  .strict();

export const workspaceReadFileInputSchema = z
  .object({
    path: workspacePathSchema
  })
  .strict();

export const workspaceApplyPatchInputSchema = z
  .object({
    patch: z.string().min(1).max(DEFAULT_LIMITS.maxApplyPatchBytes).describe(workspaceApplyPatchDescription)
  })
  .strict();

export const workspacePromoteArtifactInputSchema = z
  .object({
    path: workspacePathSchema.describe(workspacePromotePathDescription),
    kind: z.string().min(1).max(160).default("workspace.file"),
    filename: z.string().min(1).max(255).optional(),
    mimeType: z.string().min(1).max(160).optional()
  })
  .strict();

export const workspacePreviewImagesInputSchema = z
  .object({
    artifactId: z.string().min(1).max(255).describe(workspacePreviewArtifactDescription).optional(),
    path: workspacePathSchema.describe(workspacePreviewPathDescription).optional(),
    paths: z
      .array(workspacePathSchema)
      .min(1)
      .max(DEFAULT_LIMITS.maxPreviewImages)
      .describe(workspacePreviewPathsDescription)
      .optional(),
    pages: workspacePreviewPositiveIntegerListSchema.describe(workspacePreviewPagesDescription).optional(),
    slides: workspacePreviewPositiveIntegerListSchema.describe(workspacePreviewSlidesDescription).optional(),
    sheets: workspacePreviewTextListSchema.describe(workspacePreviewSheetsDescription).optional(),
    ranges: workspacePreviewTextListSchema.describe(workspacePreviewRangesDescription).optional(),
    maxImages: z
      .number()
      .int()
      .min(1)
      .max(DEFAULT_LIMITS.maxPreviewImages)
      .default(DEFAULT_LIMITS.maxPreviewImages)
      .describe(workspacePreviewMaxImagesDescription)
  })
  .strict()
  .superRefine((input, context) => {
    const sourceCount = [input.artifactId, input.path, input.paths].filter((value) => value !== undefined).length;
    if (sourceCount !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide exactly one preview source: artifactId, path, or paths"
      });
    }
    if ((input.path || input.paths) && (input.pages || input.slides || input.sheets || input.ranges)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Page, slide, sheet, and range selectors apply only to artifactId previews"
      });
    }
  });

const changedFileOutputSchema = z.object({
  path: z.string(),
  byteSize: z.number(),
  checksum: z.string(),
  mimeType: z.string().optional(),
  artifactId: z.string().optional()
});

const promotedArtifactOutputSchema = z.object({
  artifactId: z.string(),
  path: z.string(),
  kind: z.string(),
  mimeType: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const workspaceExecOutputSchema = z.object({
  commandId: z.string(),
  workspaceId: z.string(),
  status: z.enum(["queued", "running", "cancelling", "completed", "failed", "cancelled"]),
  limits: z.object({
    timeoutSeconds: z.number(),
    idleTimeoutSeconds: z.number().optional(),
    maxStdoutBytes: z.number().optional(),
    maxStderrBytes: z.number().optional(),
    maxWorkspaceBytes: z.number().optional()
  }),
  exitCode: z.number().nullable(),
  stdoutPreview: z.string(),
  stderrPreview: z.string(),
  durationMs: z.number().nullable(),
  changedFiles: z.array(changedFileOutputSchema),
  promotedArtifacts: z.array(promotedArtifactOutputSchema),
  truncated: z.object({ stdout: z.boolean(), stderr: z.boolean() })
});

export const workspaceListFilesOutputSchema = z.object({
  workspaceId: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      byteSize: z.number(),
      checksum: z.string(),
      mimeType: z.string().optional(),
      updatedAt: z.string(),
      lastCommandId: z.string().optional(),
      promotedArtifacts: z
        .array(
          z.object({ artifactId: z.string(), kind: z.string(), promotedAt: z.string() })
        )
        .optional()
    })
  )
});

export const workspaceImportFilesOutputSchema = z.object({
  workspaceId: z.string(),
  importedFiles: z.array(
    z.object({
      fileId: z.string(),
      path: z.string(),
      filename: z.string(),
      byteSize: z.number(),
      checksum: z.string(),
      mimeType: z.string().optional()
    })
  )
});

export const workspaceReadFileOutputSchema = z.object({
  workspaceId: z.string(),
  path: z.string(),
  byteSize: z.number(),
  mimeType: z.string().optional(),
  encoding: z.literal("utf-8"),
  contentPreview: z.string(),
  truncated: z.boolean()
});

export const workspaceApplyPatchOutputSchema = z.object({
  workspaceId: z.string(),
  changedFiles: z.array(changedFileOutputSchema),
  deletedFiles: z.array(
    z.object({
      path: z.string()
    })
  )
});

export const workspacePromoteArtifactOutputSchema = z.object({
  artifactId: z.string(),
  path: z.string(),
  kind: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  byteSize: z.number(),
  checksum: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const workspacePreviewImageOutputSchema = z.object({
  sourceArtifactId: z.string(),
  imageArtifactId: z.string(),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  status: z.literal("ready"),
  pageNumber: z.number().int().positive().optional(),
  slideNumber: z.number().int().positive().optional(),
  sheet: z.string().optional(),
  range: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional()
});

const workspacePreviewWarningOutputSchema = z.object({
  code: z.string(),
  message: z.string(),
  pageNumber: z.number().int().positive().optional(),
  slideNumber: z.number().int().positive().optional(),
  sheet: z.string().optional(),
  range: z.string().optional()
});

export const workspacePreviewImagesOutputSchema = z.object({
  artifactId: z.string(),
  status: z.enum(["ready", "pending", "failed", "unsupported"]),
  maxImages: z.number().int().positive(),
  images: z.array(workspacePreviewImageOutputSchema),
  warnings: z.array(workspacePreviewWarningOutputSchema),
  errorCode: z.string().optional()
});

// Override required: validation allows high values so configured runtime limits can return limit-specific errors.
export const workspaceExecInputJsonSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["command"],
  properties: {
    command: {
      type: "string",
      minLength: 1,
      maxLength: DEFAULT_LIMITS.maxCommandLength,
      description: workspaceCommandDescription
    },
    cwd: {
      type: "string",
      minLength: 1,
      maxLength: DEFAULT_LIMITS.maxPathLength,
      description: workspaceCwdDescription
    },
    timeoutSeconds: { type: "integer", minimum: 1, maximum: DEFAULT_LIMITS.maxTimeoutSeconds },
    expectedOutputs: {
      type: "array",
      maxItems: DEFAULT_LIMITS.maxExpectedOutputs,
      description: workspaceExpectedOutputsDescription,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: { type: "string", minLength: 1, maxLength: DEFAULT_LIMITS.maxPathLength },
          kind: { type: "string", minLength: 1, maxLength: 160 },
          promote: { type: "boolean", default: false }
        }
      }
    }
  }
};

// Override required: the model-facing schema must advertise the exactly-one preview source constraint.
export const workspacePreviewImagesInputJsonSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  anyOf: [
    { required: ["artifactId"] },
    { required: ["path"] },
    { required: ["paths"] }
  ],
  properties: {
    artifactId: {
      type: "string",
      minLength: 1,
      maxLength: 255,
      description: workspacePreviewArtifactDescription
    },
    path: {
      type: "string",
      minLength: 1,
      maxLength: DEFAULT_LIMITS.maxPathLength,
      description: workspacePreviewPathDescription
    },
    paths: {
      type: "array",
      minItems: 1,
      maxItems: DEFAULT_LIMITS.maxPreviewImages,
      items: {
        type: "string",
        minLength: 1,
        maxLength: DEFAULT_LIMITS.maxPathLength
      },
      description: workspacePreviewPathsDescription
    },
    pages: {
      type: "array",
      minItems: 1,
      maxItems: DEFAULT_LIMITS.maxPreviewImages,
      items: { type: "integer", minimum: 1 },
      description: workspacePreviewPagesDescription
    },
    slides: {
      type: "array",
      minItems: 1,
      maxItems: DEFAULT_LIMITS.maxPreviewImages,
      items: { type: "integer", minimum: 1 },
      description: workspacePreviewSlidesDescription
    },
    sheets: {
      type: "array",
      minItems: 1,
      maxItems: DEFAULT_LIMITS.maxPreviewImages,
      items: { type: "string", minLength: 1, maxLength: 160 },
      description: workspacePreviewSheetsDescription
    },
    ranges: {
      type: "array",
      minItems: 1,
      maxItems: DEFAULT_LIMITS.maxPreviewImages,
      items: { type: "string", minLength: 1, maxLength: 160 },
      description: workspacePreviewRangesDescription
    },
    maxImages: {
      type: "integer",
      minimum: 1,
      maximum: DEFAULT_LIMITS.maxPreviewImages,
      default: DEFAULT_LIMITS.maxPreviewImages,
      description: workspacePreviewMaxImagesDescription
    }
  }
};
