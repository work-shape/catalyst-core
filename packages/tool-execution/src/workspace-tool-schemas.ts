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
  maxCommandLength: number;
  maxExpectedOutputs: number;
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
  maxCommandLength: 8192,
  maxExpectedOutputs: 32,
  maxPathLength: 512,
  perConversationActiveCommands: 1,
  perUserActiveCommands: 1,
  globalActiveCommands: 4
};

const workspacePathSchema = z.string().min(1).max(DEFAULT_LIMITS.maxPathLength);

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

export const workspacePromoteArtifactInputSchema = z
  .object({
    path: workspacePathSchema,
    kind: z.string().min(1).max(160).default("workspace.file"),
    filename: z.string().min(1).max(255).optional(),
    mimeType: z.string().min(1).max(160).optional()
  })
  .strict();

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
        "Complete /bin/sh command or multiline script. Run helpers directly, e.g. `pptx_inspect deck.pptx --view summary`; do not write `set -e pptx_inspect ...`. If strict mode is needed, put `set -e` on its own line before the command. Do not pass helper flags such as `--view`, `--out`, or `--range` to `cat` or `ls`."
    },
    cwd: { type: "string", maxLength: DEFAULT_LIMITS.maxPathLength },
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

export const workspacePromoteArtifactInputJsonSchema: JsonObject = {
  ...workspacePathInputJsonSchema,
  properties: {
    path: { type: "string", maxLength: DEFAULT_LIMITS.maxPathLength },
    kind: { type: "string", maxLength: 160, default: "workspace.file" },
    filename: { type: "string", maxLength: 255 },
    mimeType: { type: "string", maxLength: 160 }
  }
};
