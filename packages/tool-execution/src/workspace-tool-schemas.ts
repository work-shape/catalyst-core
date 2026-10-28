import type { JsonObject } from "@work-shape/catalyst-core";
import {
  ARTIFACT_PREVIEW_STATUSES,
  SUPPORTED_IMAGE_MIME_TYPES,
  WORKSPACE_COMMAND_STATUSES
} from "@work-shape/catalyst-core";
import { PROJECT_FILE_CHANGES } from "@work-shape/catalyst-core";
import { z } from "zod";

export interface WorkspaceCommandServiceLimits {
  defaultTimeoutSeconds: number;
  maxTimeoutSeconds: number;
  idleTimeoutSeconds?: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxWorkspaceBytes: number;
  maxReadFileBytes: number;
  maxReadPreviewBytes: number;
  maxCommandLength: number;
  maxExpectedOutputs: number;
  maxPreviewImages: number;
  maxPathLength: number;
}

export const DEFAULT_LIMITS: WorkspaceCommandServiceLimits = {
  defaultTimeoutSeconds: 60,
  maxTimeoutSeconds: 300,
  idleTimeoutSeconds: 30,
  maxStdoutBytes: 64 * 1024,
  maxStderrBytes: 64 * 1024,
  maxWorkspaceBytes: 100 * 1024 * 1024,
  // Ceiling of workspace.read_file. A read loads the whole stored file into memory once per
  // call, so this bounds the memory of one read, not the size of an answer.
  maxReadFileBytes: 8 * 1024 * 1024,
  // Most bytes of file text in one workspace.read_file answer; the model's context pays for it.
  maxReadPreviewBytes: 16 * 1024,
  maxCommandLength: 64 * 1024,
  maxExpectedOutputs: 32,
  maxPreviewImages: 12,
  maxPathLength: 512
};

/**
 * Lines in one workspace.read_file answer when the call gives no `limit`. An answer is also cut
 * at `maxReadPreviewBytes`, whichever comes first. No operator setting: a call that wants more
 * or fewer lines passes `limit`.
 */
export const WORKSPACE_READ_DEFAULT_LINES = 400;

const workspacePathSchema = z.string().min(1).max(DEFAULT_LIMITS.maxPathLength);
// The rules for a command are in the description of workspace.exec, once.
const workspaceCommandDescription = "Complete Bash command or multiline script.";
const workspaceReadOffsetDescription =
  "First line to return, counted from 1. Omit it to start at line 1. To continue, pass the nextOffset of the previous answer.";
const workspaceReadLimitDescription = `Number of lines to return. Omit it for up to ${WORKSPACE_READ_DEFAULT_LINES} lines.`;
const workspaceCwdDescription =
  "Optional workspace-relative directory for this command only. It does not persist as the next command's cwd.";
const workspaceExpectedOutputsDescription =
  'Files that should exist in /workspace after the command. Kind "directory" checks that a generated directory holds tracked files. Set promote only when the command itself should promote the output.';
const workspaceImportPathDescription =
  "Optional workspace-relative destination path override. Usually omit this and use the returned importedFiles[].path exactly in workspace.exec.";
const workspacePromotePathDescription =
  "Workspace path to the final user-facing artifact. Prefer artifacts/ or /workspace/artifacts/ outputs.";
const workspacePreviewArtifactDescription = "Managed DOCX/XLSX/PPTX/PDF or image artifact id.";
const workspacePreviewPathDescription =
  "A rendered preview image, such as previews/report/page-1.png.";
const workspacePreviewPathsDescription = "Rendered preview images, usually under previews/.";
const workspacePreviewPagesDescription = "PDF/DOCX page numbers.";
const workspacePreviewSlidesDescription = "PPTX slide numbers.";
const workspacePreviewSheetsDescription = "XLSX sheet names.";
const workspacePreviewRangesDescription =
  "XLSX ranges such as `Summary!A1:B4`; an unqualified range needs exactly one `sheets` value.";
const workspacePreviewMaxImagesDescription = "Most images to load.";
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
    command: z
      .string()
      .min(1)
      .max(DEFAULT_LIMITS.maxCommandLength)
      .describe(workspaceCommandDescription),
    cwd: workspacePathSchema.describe(workspaceCwdDescription).optional(),
    timeoutSeconds: z.number().int().min(1).optional(),
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
    path: workspacePathSchema,
    offset: z.number().int().min(1).describe(workspaceReadOffsetDescription).optional(),
    limit: z.number().int().min(1).describe(workspaceReadLimitDescription).optional()
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
    pages: workspacePreviewPositiveIntegerListSchema
      .describe(workspacePreviewPagesDescription)
      .optional(),
    slides: workspacePreviewPositiveIntegerListSchema
      .describe(workspacePreviewSlidesDescription)
      .optional(),
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
    const sourceCount = [input.artifactId, input.path, input.paths].filter(
      (value) => value !== undefined
    ).length;
    if (sourceCount !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide exactly one preview source: artifactId, path, or paths"
      });
    }
    if (
      (input.path || input.paths) &&
      (input.pages || input.slides || input.sheets || input.ranges)
    ) {
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
  status: z.enum(WORKSPACE_COMMAND_STATUSES),
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
  projectFileChanges: z
    .array(
      z.object({
        projectId: z.string(),
        path: z.string(),
        version: z.number().int().positive(),
        change: z.enum(PROJECT_FILE_CHANGES),
        previousVersion: z.number().int().positive().optional(),
        changed: z.object({ path: z.string(), version: z.number().int().positive() }).optional()
      })
    )
    .optional(),
  truncated: z.object({ stdout: z.boolean(), stderr: z.boolean() })
});

export const workspaceListFilesOutputSchema = z.object({
  // Absent while the conversation has no execution workspace; listing does not create one.
  workspaceId: z.string().optional(),
  files: z.array(
    z.object({
      path: z.string(),
      byteSize: z.number(),
      checksum: z.string(),
      mimeType: z.string().optional(),
      updatedAt: z.string(),
      lastCommandId: z.string().optional(),
      /** A file of the project folder (`project/...`): its version (PRJ-2). */
      version: z.number().int().positive().optional(),
      promotedArtifacts: z
        .array(z.object({ artifactId: z.string(), kind: z.string(), promotedAt: z.string() }))
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
  /** A file of the project folder (`project/...`): the version to pass as replacesVersion. */
  version: z.number().int().positive().optional(),
  encoding: z.literal("utf-8"),
  contentPreview: z.string(),
  // True when the answer does not reach the end of the file.
  truncated: z.boolean(),
  // The lines `contentPreview` holds, counted from 1. Both are 0 for an empty file.
  startLine: z.number().int().min(0),
  endLine: z.number().int().min(0),
  totalLines: z.number().int().min(0),
  // The `offset` to continue with, when lines remain after `endLine`.
  nextOffset: z.number().int().min(1).optional(),
  // True when `contentPreview` is the start of one line that is longer than one answer. The
  // rest of that line is not reachable through `nextOffset`; the hint says how to read it.
  lineCut: z.boolean().optional(),
  // How to get the rest, in words. Present when `truncated` is true.
  hint: z.string().optional()
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
  mimeType: z.enum(SUPPORTED_IMAGE_MIME_TYPES),
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
  status: z.enum(ARTIFACT_PREVIEW_STATUSES),
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
    timeoutSeconds: { type: "integer", minimum: 1 },
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
  // No `anyOf` over the three sources here: a model provider refuses a combinator at the root
  // of a tool's input schema. The description says to give exactly one, and the input schema
  // refuses a call that gives none or several.
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
