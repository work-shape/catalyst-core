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
  maxCommandLength: 8192,
  maxExpectedOutputs: 32,
  maxPreviewImages: 12,
  maxPathLength: 512,
  perConversationActiveCommands: 1,
  perUserActiveCommands: 1,
  globalActiveCommands: 4
};

const workspacePathSchema = z.string().min(1).max(DEFAULT_LIMITS.maxPathLength);
const workspacePreviewPositiveIntegerListSchema = z
  .array(z.number().int().positive())
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
    promote: z.boolean().optional()
  })
  .strict();

export const workspaceExecInputSchema = z
  .object({
    command: z.string().min(1).max(DEFAULT_LIMITS.maxCommandLength),
    cwd: workspacePathSchema.optional(),
    timeoutSeconds: z.number().int().positive().max(86_400).optional(),
    expectedOutputs: z.array(expectedOutputInputSchema).max(DEFAULT_LIMITS.maxExpectedOutputs).optional()
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
            path: workspacePathSchema.optional()
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
    patch: z.string().min(1).max(DEFAULT_LIMITS.maxApplyPatchBytes)
  })
  .strict();

export const workspacePromoteArtifactInputSchema = z
  .object({
    path: workspacePathSchema,
    kind: z.string().min(1).max(160).default("workspace.file"),
    filename: z.string().min(1).max(255).optional(),
    mimeType: z.string().min(1).max(160).optional()
  })
  .strict();

export const workspacePreviewImagesInputSchema = z
  .object({
    artifactId: z.string().min(1).max(255).optional(),
    path: workspacePathSchema.optional(),
    paths: z.array(workspacePathSchema).min(1).max(DEFAULT_LIMITS.maxPreviewImages).optional(),
    pages: workspacePreviewPositiveIntegerListSchema.optional(),
    slides: workspacePreviewPositiveIntegerListSchema.optional(),
    sheets: workspacePreviewTextListSchema.optional(),
    ranges: workspacePreviewTextListSchema.optional(),
    maxImages: z.number().int().positive().max(DEFAULT_LIMITS.maxPreviewImages).optional()
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

export const workspaceExecInputJsonSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["command"],
  properties: {
    command: {
      type: "string",
      minLength: 1,
      maxLength: DEFAULT_LIMITS.maxCommandLength,
      description:
        "Complete Bash command or multiline script. Each call starts in /workspace unless cwd is provided for that call. Files created or changed under /workspace persist across calls. Run helpers directly, e.g. `pptx_inspect deck.pptx --view summary`; do not write `set -e pptx_inspect ...`. If strict mode is needed, put `set -e` on its own line before the command. Do not pass helper flags such as `--view`, `--spec`, `--out`, `--range`, `--page`, or `--sheet` to `cat`, `ls`, or `printf`."
    },
    cwd: {
      type: "string",
      maxLength: DEFAULT_LIMITS.maxPathLength,
      description:
        "Optional workspace-relative directory for this command only. It does not persist as the next command's cwd."
    },
    timeoutSeconds: { type: "integer", minimum: 1, maximum: 300 },
    expectedOutputs: {
      type: "array",
      maxItems: DEFAULT_LIMITS.maxExpectedOutputs,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: { type: "string", maxLength: DEFAULT_LIMITS.maxPathLength },
          kind: { type: "string", maxLength: 160 },
          promote: { type: "boolean", default: false }
        }
      }
    }
  }
};

export const emptyObjectInputJsonSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  properties: {}
};

export const workspaceImportFilesInputJsonSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["files"],
  properties: {
    files: {
      type: "array",
      minItems: 1,
      maxItems: 16,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["fileId"],
        properties: {
          fileId: { type: "string", minLength: 1, maxLength: 255 },
          path: { type: "string", maxLength: DEFAULT_LIMITS.maxPathLength }
        }
      }
    }
  }
};

export const workspacePathInputJsonSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["path"],
  properties: { path: { type: "string", maxLength: DEFAULT_LIMITS.maxPathLength } }
};

export const workspaceApplyPatchInputJsonSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["patch"],
  properties: {
    patch: {
      type: "string",
      minLength: 1,
      maxLength: DEFAULT_LIMITS.maxApplyPatchBytes,
      description:
        "Unified diff patch for workspace text files. Use paths relative to /workspace, /workspace/path, or git-style a/path and b/path headers. Supports create, update, and delete; binary files and renames are rejected."
    }
  }
};

export const workspacePromoteArtifactInputJsonSchema: JsonObject = {
  ...workspacePathInputJsonSchema,
  properties: {
    path: {
      type: "string",
      maxLength: DEFAULT_LIMITS.maxPathLength,
      description:
        "Workspace path to the final user-facing artifact. Prefer artifacts/ or /workspace/artifacts/ outputs."
    },
    kind: { type: "string", maxLength: 160, default: "workspace.file" },
    filename: { type: "string", maxLength: 255 },
    mimeType: { type: "string", maxLength: 160 }
  }
};

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
      description:
        "Managed source artifact id for DOCX/XLSX/PPTX/PDF preview rendering or already-managed image previews."
    },
    path: {
      type: "string",
      minLength: 1,
      maxLength: DEFAULT_LIMITS.maxPathLength,
      description:
        "Workspace path to a rendered preview image, usually under previews/, e.g. previews/report/page-1.png or /workspace/previews/report/page-1.png."
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
      description:
        "Workspace paths to rendered preview images, usually under previews/. Preview images are model-visible but are not user-download artifacts unless separately promoted."
    },
    pages: {
      type: "array",
      minItems: 1,
      maxItems: DEFAULT_LIMITS.maxPreviewImages,
      items: { type: "integer", minimum: 1 },
      description: "Optional PDF/DOCX page numbers to load when preview metadata has page numbers."
    },
    slides: {
      type: "array",
      minItems: 1,
      maxItems: DEFAULT_LIMITS.maxPreviewImages,
      items: { type: "integer", minimum: 1 },
      description: "Optional PPTX slide numbers to load when preview metadata has slide numbers."
    },
    sheets: {
      type: "array",
      minItems: 1,
      maxItems: DEFAULT_LIMITS.maxPreviewImages,
      items: { type: "string", minLength: 1, maxLength: 160 },
      description: "Optional XLSX sheet names to load when preview metadata has sheet labels."
    },
    ranges: {
      type: "array",
      minItems: 1,
      maxItems: DEFAULT_LIMITS.maxPreviewImages,
      items: { type: "string", minLength: 1, maxLength: 160 },
      description:
        "Optional XLSX ranges to load. Prefer sheet-qualified ranges like `Summary!A1:B4`; unqualified ranges require exactly one `sheets` value."
    },
    maxImages: {
      type: "integer",
      minimum: 1,
      maximum: DEFAULT_LIMITS.maxPreviewImages,
      default: DEFAULT_LIMITS.maxPreviewImages,
      description: "Maximum preview images to attach to model context."
    }
  }
};
