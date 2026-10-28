import type { z } from "zod";
import {
  getRuntimeSubjectUserId,
  isAppError,
  isProjectInstructionsPath,
  normalizeProjectFilePath,
  PROJECT_FOLDER_PREFIX,
  projectPathOf,
  type ConversationProjectFolder,
  type JsonObject,
  type PolicyValue,
  type ProjectFileChange,
  type ProjectFolderPort,
  type ToolExecutionContext,
  type ToolHandlerResult
} from "@work-shape/catalyst-core";
import { toolSuccess } from "@work-shape/catalyst-tool-sdk";
import {
  WORKSPACE_EDIT_MAX_EDITS,
  WORKSPACE_WRITE_FILE_MAX_BYTES,
  type projectFileToolChangeSchema,
  type workspaceEditFileInputSchema,
  type workspaceEditFileOutputSchema,
  type workspaceWriteFileInputSchema,
  type workspaceWriteFileOutputSchema
} from "../workspace-file-write-schemas";
import type {
  workspaceListFilesOutputSchema,
  workspaceReadFileInputSchema,
  workspaceReadFileOutputSchema
} from "../workspace-tool-schemas";
import { failed } from "../workspace-tool-results";
import type { WorkspaceToolDependencies } from "./dependencies";
import { editTextBytes } from "./edited-text";
import { answerTextRead } from "./text-read-answer";

// The project folder in the file tools (PRJ-2). A chat in a project reads and writes its own
// project's folder at `project/`, and no other: the folder is found from the chat, never named
// by the model. Each write is a version of the file at once; a write over a file that changed
// since it was read is kept beside it as a conflict copy.

/** A chat's folder with the path inside it, where a tool's path is below `project/`. */
interface ProjectFolderTarget {
  port: ProjectFolderPort;
  folder: ConversationProjectFolder;
  /** The path inside the project; `""` for the folder itself. */
  path: string;
  /** The agent run that writes, named on each version it makes. */
  runId?: string;
}

/**
 * The project folder a path of a file tool names. Nothing where the path is not below
 * `project/`, or the chat has no folder: then it is a path of the chat's workspace as before.
 */
export async function projectFolderTarget(
  deps: WorkspaceToolDependencies,
  context: ToolExecutionContext,
  path: string
): Promise<ProjectFolderTarget | undefined> {
  const inside = projectPathOf(path);
  if (inside === undefined) return undefined;
  const folder = await chatFolder(deps, context);
  return folder ? { ...folder, path: inside } : undefined;
}

async function chatFolder(
  deps: WorkspaceToolDependencies,
  context: ToolExecutionContext
): Promise<Omit<ProjectFolderTarget, "path"> | undefined> {
  const port = deps.projectFolder;
  const call = deps.workspaces.callOf(context);
  if (!port || !call) return undefined;
  const folder = await port.folderOf({
    clientInstanceId: context.clientInstanceId,
    conversationId: call.conversationId,
    user: context.user
  });
  return folder ? { port, folder, runId: call.agentRunId } : undefined;
}

/**
 * What a write to the project's instructions asks of the policy (PRJ-3): the person's click on
 * the card that shows the change. Nothing for any other path, or where no project folder is
 * reached through the file tools.
 */
export function projectInstructionsFloor(
  deps: WorkspaceToolDependencies,
  path: string
): PolicyValue | undefined {
  return deps.projectFolder && isProjectInstructionsPath(path) ? "confirm" : undefined;
}

/** The files of the chat's project folder, as `workspace.list_files` lists them. */
export async function listProjectFolderFiles(
  deps: WorkspaceToolDependencies,
  context: ToolExecutionContext
): Promise<z.infer<typeof workspaceListFilesOutputSchema>["files"]> {
  const found = await chatFolder(deps, context);
  if (!found) return [];
  const files = await found.port.list(found.folder);
  return files.map((file) => ({
    path: `${PROJECT_FOLDER_PREFIX}${file.path}`,
    byteSize: file.byteSize,
    checksum: file.checksum,
    mimeType: file.mimeType,
    updatedAt: file.updatedAt,
    version: file.version
  }));
}

export async function readProjectFolderFile(
  deps: WorkspaceToolDependencies,
  target: ProjectFolderTarget,
  input: z.infer<typeof workspaceReadFileInputSchema>
): Promise<ToolHandlerResult<z.infer<typeof workspaceReadFileOutputSchema>>> {
  const path = filePath(target);
  if (path.status === "failed") return path.result;
  const found = await target.port.read(target.folder, path.value);
  if (!found) return notFound(path.value);
  const { file, bytes } = found;
  if (file.byteSize > deps.limits.maxReadFileBytes) {
    return failed(
      "handler_failed",
      `'${shown(file.path)}' has ${file.byteSize} bytes, more than workspace.read_file reads (maxReadFileBytes, ${deps.limits.maxReadFileBytes} bytes).`,
      {
        path: shown(file.path),
        byteSize: file.byteSize,
        maxReadFileBytes: deps.limits.maxReadFileBytes
      }
    );
  }
  const answer = answerTextRead(
    deps,
    input,
    {
      workspaceId: `project:${target.folder.projectId}`,
      path: shown(file.path),
      byteSize: file.byteSize,
      mimeType: file.mimeType,
      version: file.version,
      auditSubject: target.folder.projectId
    },
    bytes
  );
  return answer;
}

export async function writeProjectFolderFile(
  target: ProjectFolderTarget,
  input: z.infer<typeof workspaceWriteFileInputSchema>,
  context: ToolExecutionContext
): Promise<ToolHandlerResult<z.infer<typeof workspaceWriteFileOutputSchema>>> {
  const path = filePath(target);
  if (path.status === "failed") return path.result;
  if (input.content.includes("\0")) {
    return failed(
      "validation_failed",
      "The content holds a NUL character, and workspace.write_file writes text only.",
      { path: shown(path.value) }
    );
  }
  const bytes = new TextEncoder().encode(input.content);
  if (bytes.byteLength > WORKSPACE_WRITE_FILE_MAX_BYTES) {
    return failed(
      "validation_failed",
      `The content has ${bytes.byteLength} bytes and workspace.write_file takes at most ${WORKSPACE_WRITE_FILE_MAX_BYTES}. Nothing was written.`,
      {
        path: shown(path.value),
        byteSize: bytes.byteLength,
        maxBytes: WORKSPACE_WRITE_FILE_MAX_BYTES
      }
    );
  }
  let replaces = input.replacesVersion;
  if (replaces === undefined) {
    // A write that names no version is for a new file: one that exists is not replaced blind.
    const current = (await target.port.list(target.folder)).find(
      (file) => file.path === path.value
    );
    if (current) {
      return failed(
        "validation_failed",
        `'${shown(path.value)}' already exists, at version ${current.version}. Nothing was written. Read it with workspace.read_file and pass replacesVersion ${current.version} to replace it, or change part of it with workspace.edit_file.`,
        { path: shown(path.value), version: current.version }
      );
    }
    replaces = 0;
  }
  const written = await write(target, context, path.value, bytes, replaces);
  if (written.status === "failed") return written.result;
  const project = written.value;
  return toolSuccess(
    {
      path: shown(project.path),
      byteSize: bytes.byteLength,
      created: project.change === "created" || project.change === "conflict_copy",
      project
    },
    {
      // The project, the version and the size. Neither the content nor the path, which can name a
      // client, is in an audit event or an Operation Run.
      auditSummary: {
        action: "workspace.write_file",
        subject: target.folder.projectId,
        metadata: auditOf(target, project, bytes.byteLength)
      }
    }
  );
}

export async function editProjectFolderFile(
  deps: WorkspaceToolDependencies,
  target: ProjectFolderTarget,
  input: z.infer<typeof workspaceEditFileInputSchema>,
  context: ToolExecutionContext
): Promise<ToolHandlerResult<z.infer<typeof workspaceEditFileOutputSchema>>> {
  const path = filePath(target);
  if (path.status === "failed") return path.result;
  if (input.edits.length > WORKSPACE_EDIT_MAX_EDITS) {
    return failed(
      "validation_failed",
      `workspace.edit_file takes at most ${WORKSPACE_EDIT_MAX_EDITS} edits per call and got ${input.edits.length}. Nothing was changed. Send the edits in several calls.`,
      { path: shown(path.value), edits: input.edits.length, maxEdits: WORKSPACE_EDIT_MAX_EDITS }
    );
  }
  const found = await target.port.read(target.folder, path.value);
  if (!found) return notFound(path.value);
  if (found.file.byteSize > deps.limits.maxReadFileBytes) {
    return failed(
      "handler_failed",
      `'${shown(path.value)}' has ${found.file.byteSize} bytes and workspace.edit_file edits files of at most ${deps.limits.maxReadFileBytes}. Nothing was changed.`,
      { path: shown(path.value), byteSize: found.file.byteSize }
    );
  }
  const edited = editTextBytes(shown(path.value), found.bytes, found.file.mimeType, input.edits);
  if (edited.status === "failed") return edited.result;
  // The edits were found in the version read just now; that is the one they replace, unless
  // the agent names the one it read before.
  const written = await write(
    target,
    context,
    path.value,
    edited.value,
    input.replacesVersion ?? found.file.version
  );
  if (written.status === "failed") return written.result;
  const project = written.value;
  return toolSuccess(
    {
      path: shown(project.path),
      byteSize: edited.value.byteLength,
      editsApplied: input.edits.length,
      project
    },
    {
      auditSummary: {
        action: "workspace.edit_file",
        subject: target.folder.projectId,
        metadata: {
          ...auditOf(target, project, edited.value.byteLength),
          editCount: input.edits.length
        }
      }
    }
  );
}

type ToolChange = z.infer<typeof projectFileToolChangeSchema>;

async function write(
  target: ProjectFolderTarget,
  context: ToolExecutionContext,
  path: string,
  bytes: Uint8Array,
  replaces: number
): Promise<
  { status: "success"; value: ToolChange } | { status: "failed"; result: ToolHandlerResult<never> }
> {
  let change: ProjectFileChange;
  try {
    change = await target.port.write(target.folder, {
      path,
      bytes,
      replaces,
      userId: getRuntimeSubjectUserId(context),
      ...(target.runId ? { runId: target.runId } : {}),
      ...(context.locale ? { locale: context.locale } : {})
    });
  } catch (error) {
    // A cap, a path the folder does not take, or a project that went away: said to the agent.
    if (isAppError(error) && error.code !== "INTERNAL") {
      return {
        status: "failed",
        result: failed(
          error.code === "NOT_FOUND" ? "handler_failed" : "validation_failed",
          `${error.message} Nothing was written to '${shown(path)}'.`,
          { path: shown(path), ...detailsOf(error.details) }
        )
      };
    }
    throw error;
  }
  if (
    change.change !== "created" &&
    change.change !== "updated" &&
    change.change !== "unchanged" &&
    change.change !== "conflict_copy"
  ) {
    throw new Error(`A write in the project folder answered ${change.change}`);
  }
  return {
    status: "success",
    value: {
      projectId: target.folder.projectId,
      path: change.path,
      version: change.version,
      change: change.change,
      ...(change.previousVersion !== undefined ? { previousVersion: change.previousVersion } : {}),
      ...(change.changed ? { changed: change.changed } : {})
    }
  };
}

function filePath(
  target: ProjectFolderTarget
): { status: "success"; value: string } | { status: "failed"; result: ToolHandlerResult<never> } {
  const path = normalizeProjectFilePath(target.path);
  if (path === undefined) {
    return {
      status: "failed",
      result: failed(
        "validation_failed",
        `'${shown(target.path)}' is not a file path of the project folder. Name a file below ${PROJECT_FOLDER_PREFIX}, such as ${PROJECT_FOLDER_PREFIX}notes.md, without '.', '..' or empty folder names.`,
        { path: shown(target.path) }
      )
    };
  }
  return { status: "success", value: path };
}

function notFound(path: string): ToolHandlerResult<never> {
  return failed(
    "handler_failed",
    `'${shown(path)}' was not found in the project folder. Call workspace.list_files to see its files, or create it with workspace.write_file.`,
    { path: shown(path) }
  );
}

function shown(path: string): string {
  return `${PROJECT_FOLDER_PREFIX}${path}`;
}

function auditOf(target: ProjectFolderTarget, change: ToolChange, byteSize: number): JsonObject {
  return {
    projectId: target.folder.projectId,
    version: change.version,
    change: change.change,
    byteSize
  };
}

function detailsOf(details: unknown): JsonObject {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return {};
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === "string" ? { reason } : {};
}
