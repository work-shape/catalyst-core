import { createHash, randomUUID } from "node:crypto";
import {
  AppError,
  asConversationId,
  asManagedArtifactId,
  asUserId,
  authenticatedUserFromRecord,
  DEFAULT_PROJECT_FILE_LIMITS,
  getSubjectUserId,
  isAppError,
  isAuthenticatedServicePrincipal,
  normalizeProjectFilePath,
  normalizeProjectFolderPath,
  projectFileConflictPath,
  projectFileMimeType,
  projectFileObjectPrefix,
  PROJECT_INSTRUCTIONS_PATH,
  readObjectBytes,
  type AuthenticatedUser,
  type Conversation,
  type ConversationProjectFolder,
  type ObjectStorage,
  type Project,
  type ProjectFile,
  type ProjectFileChange,
  type ProjectFileLimits,
  type ProjectFileOrigin,
  type ProjectFileVersion,
  type ProjectFolderPort,
  type ProjectCommandFolder,
  type ProjectCommandFolderPort,
  type ProjectCommandFolderRequest,
  type WriteProjectFileVersionResult
} from "@work-shape/catalyst-core";
import { requireChatConversationAccess } from "../conversations/conversation-access";
import type { ChatServerOptions } from "../types";
import {
  projectNotAvailable,
  requireProjectAccess,
  requireProjectReadable
} from "./project-access";

/** What the files of projects are kept and read with. The routes and the agent's tools share it. */
export type ProjectFileOptions = Pick<
  ChatServerOptions,
  "stores" | "clientInstanceId" | "config" | "modules" | "logger"
> &
  Partial<Pick<ChatServerOptions, "pages" | "attachments" | "managedObjects">>;

interface WriteInput {
  path: string;
  /** `null` deletes the file. */
  bytes: Uint8Array | null;
  mimeType?: string;
  /** Reuses an object a kept version names, for a restore. */
  stored?: { objectKey: string; byteSize: number; checksum: string; mimeType: string };
  /** The kept version `stored` comes from, read again under the project's lock. */
  restores?: number;
  replaces?: number;
  origin: ProjectFileOrigin;
  userId: string;
  conversationId?: string;
  runId?: string;
  /** Keep a write to a file that changed since as a copy beside it, named for this person. */
  conflictCopy?: { author: string; locale?: string };
}

/**
 * The files of projects (PRJ-2): one folder per project that people and agents write in place.
 * Every read and write by a person asks the project's audience first; one outside it gets a
 * project that does not exist, also by its id. The bytes lie in the instance's `files` store
 * below the project's asset (`assets/<id>/files/`), so they go with the project.
 */
export class ProjectFileService implements ProjectFolderPort, ProjectCommandFolderPort {
  constructor(private readonly options: ProjectFileOptions) {}

  get limits(): ProjectFileLimits {
    return this.options.config.projects?.files ?? DEFAULT_PROJECT_FILE_LIMITS;
  }

  // --- A person on the page or in the chat ---------------------------------------------------

  async listFiles(user: AuthenticatedUser, projectId: string) {
    const project = await this.readable(user, projectId);
    const [files, usage] = await Promise.all([
      this.options.stores.projectFiles.listProjectFiles({
        clientInstanceId: this.options.clientInstanceId,
        projectId: project.id
      }),
      this.options.stores.projectFiles.projectFileUsage({
        clientInstanceId: this.options.clientInstanceId,
        projectId: project.id
      })
    ]);
    const labels = await this.labels(files.map((file) => file.updatedByUserId));
    return {
      items: files.map((file) => ({
        path: file.path,
        version: file.version,
        byteSize: file.byteSize,
        mimeType: file.mimeType,
        origin: file.origin,
        updatedAt: file.updatedAt,
        ...withPerson(file.updatedByUserId, labels, (person) => ({ updatedBy: person })),
        ...(file.conversationId ? { conversationId: file.conversationId } : {})
      })),
      usage,
      limits: this.limits
    };
  }

  async versions(user: AuthenticatedUser, projectId: string, rawPath: string) {
    const project = await this.readable(user, projectId);
    const path = requirePath(rawPath);
    const [versions, current] = await Promise.all([
      this.options.stores.projectFiles.listProjectFileVersions({
        clientInstanceId: this.options.clientInstanceId,
        projectId: project.id,
        path
      }),
      this.current(project.id, path)
    ]);
    if (versions.length === 0) throw fileNotAvailable();
    const labels = await this.labels(versions.map((version) => version.byUserId));
    return {
      path,
      ...(current ? { currentVersion: current.version } : {}),
      items: versions.map((version) => ({
        version: version.version,
        deleted: version.deleted,
        byteSize: version.byteSize,
        ...(version.mimeType ? { mimeType: version.mimeType } : {}),
        origin: version.origin,
        at: version.at,
        ...withPerson(version.byUserId, labels, (person) => ({ by: person })),
        ...(version.conversationId ? { conversationId: version.conversationId } : {})
      }))
    };
  }

  async content(user: AuthenticatedUser, projectId: string, rawPath: string, version?: number) {
    const project = await this.readable(user, projectId);
    const path = requirePath(rawPath);
    const stored = await this.storedVersion(project.id, path, version);
    return {
      bytes: await readObjectBytes(this.objects(), stored.objectKey),
      mimeType: stored.mimeType,
      filename: path.slice(path.lastIndexOf("/") + 1)
    };
  }

  /** A person's upload. A taken path is refused unless they confirmed "Replace" for its version. */
  async upload(
    user: AuthenticatedUser,
    projectId: string,
    input: {
      path?: string;
      filename: string;
      mimeType?: string;
      bytes: Uint8Array;
      replaces?: number;
    }
  ): Promise<ProjectFileChange> {
    const project = await this.readable(user, projectId);
    const path = requirePath(input.path ?? input.filename);
    return this.changeOrRefuse(project, {
      path,
      bytes: input.bytes,
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
      replaces: input.replaces ?? 0,
      origin: "upload",
      userId: getSubjectUserId(user)
    });
  }

  async move(user: AuthenticatedUser, projectId: string, rawFrom: string, rawTo: string) {
    const project = await this.readable(user, projectId);
    const folder = rawFrom.trim().endsWith("/");
    const from = folder ? normalizeProjectFolderPath(rawFrom) : normalizeProjectFilePath(rawFrom);
    const to = folder ? normalizeProjectFolderPath(rawTo) : normalizeProjectFilePath(rawTo);
    if (!from || !to) throw invalidPath();
    if (from === to) return { moved: 0 };
    if (folder && to.startsWith(from)) {
      throw new AppError("VALIDATION_FAILED", "A folder cannot move into itself", undefined, {
        exposeMessage: true
      });
    }
    const result = await this.options.stores.projectFiles.moveProjectFiles({
      clientInstanceId: this.options.clientInstanceId,
      projectId: project.id,
      from,
      to
    });
    if (result.status === "missing") throw fileNotAvailable();
    if (result.status === "taken") {
      throw new AppError(
        "CONFLICT",
        "A file of the project is at that path already",
        { reason: "project_file_taken" },
        { exposeMessage: true }
      );
    }
    return { moved: result.moved };
  }

  /** Delete as a version: restorable while its versions are kept. */
  async remove(
    user: AuthenticatedUser,
    projectId: string,
    rawPath: string,
    replaces?: number
  ): Promise<ProjectFileChange> {
    const project = await this.readable(user, projectId);
    return this.changeOrRefuse(project, {
      path: requirePath(rawPath),
      bytes: null,
      ...(replaces === undefined ? {} : { replaces }),
      origin: "person",
      userId: getSubjectUserId(user)
    });
  }

  /** "Delete for good": the file with all its versions, by anyone in the audience. */
  async purge(user: AuthenticatedUser, projectId: string, rawPath: string) {
    const project = await this.readable(user, projectId);
    const path = requirePath(rawPath);
    const purged = await this.options.stores.projectFiles.purgeProjectFile({
      clientInstanceId: this.options.clientInstanceId,
      projectId: project.id,
      path
    });
    if (purged.versions === 0) throw fileNotAvailable();
    await this.release(purged.releasedObjectKeys);
    return { versions: purged.versions };
  }

  /** "Restore" makes an older version the newest; with `replaces` it is an Undo of that one. */
  async restore(
    user: AuthenticatedUser,
    projectId: string,
    input: { path: string; version: number; replaces?: number }
  ): Promise<ProjectFileChange> {
    const project = await this.readable(user, projectId);
    const path = requirePath(input.path);
    const version = await this.options.stores.projectFiles.getProjectFileVersion({
      clientInstanceId: this.options.clientInstanceId,
      projectId: project.id,
      path,
      version: input.version
    });
    if (!version) throw fileNotAvailable();
    const change = await this.changeOrRefuse(project, {
      path,
      bytes: version.objectKey ? new Uint8Array() : null,
      ...(version.objectKey ? { stored: storedOf(version), restores: version.version } : {}),
      ...(input.replaces === undefined ? {} : { replaces: input.replaces }),
      origin: "person",
      userId: getSubjectUserId(user)
    });
    return change.change === "updated" || change.change === "created"
      ? { ...change, change: "restored" }
      : change;
  }

  /**
   * Whether the instructions of a chat's project changed since the chat's last run took them
   * (PRJ-3), from outside this chat: by a person on the page or another chat's agent. Only the
   * versions; the text is read through the project's files.
   */
  async conversationInstructions(user: AuthenticatedUser, conversationId: string) {
    const conversation = await requireChatConversationAccess(
      this.options,
      asConversationId(conversationId),
      user
    );
    if (conversation.projectId === undefined || !this.options.modules.isEnabled("projects")) {
      return { changed: false };
    }
    const project = await this.readable(user, conversation.projectId);
    const [versions, run] = await Promise.all([
      this.options.stores.projectFiles.listProjectFileVersions({
        clientInstanceId: this.options.clientInstanceId,
        projectId: project.id,
        path: PROJECT_INSTRUCTIONS_PATH
      }),
      this.options.stores.agentRuns.getLatestConversationAgentRun({
        clientInstanceId: this.options.clientInstanceId,
        conversationId: conversation.id
      })
    ]);
    const newest = versions[0];
    const currentVersion = newest && !newest.deleted ? newest.version : undefined;
    const used = run?.project?.projectId === project.id ? run.project : undefined;
    const changed =
      used !== undefined &&
      newest !== undefined &&
      used.instructionsVersion !== currentVersion &&
      newest.conversationId !== conversation.id;
    return {
      projectId: project.id,
      projectTitle: project.title,
      ...(currentVersion === undefined ? {} : { currentVersion }),
      ...(used?.instructionsVersion === undefined ? {} : { usedVersion: used.instructionsVersion }),
      changed
    };
  }

  /** "Save to project": a file of a chat in a project, kept in that project's folder. */
  async saveFromConversation(
    user: AuthenticatedUser,
    conversationId: string,
    input: { source: { fileId: string } | { artifactId: string }; path?: string }
  ): Promise<ProjectFileChange> {
    const conversation = await requireChatConversationAccess(
      this.options,
      asConversationId(conversationId),
      user
    );
    if (conversation.projectId === undefined) {
      throw new AppError(
        "VALIDATION_FAILED",
        "This conversation is in no project",
        { reason: "conversation_without_project" },
        { exposeMessage: true }
      );
    }
    const project = await this.readable(user, conversation.projectId);
    const file = await this.conversationFile(conversation, input.source);
    if (input.path !== undefined) {
      return this.changeOrRefuse(project, {
        path: requirePath(input.path),
        bytes: file.bytes,
        ...(file.mimeType ? { mimeType: file.mimeType } : {}),
        replaces: 0,
        origin: "person",
        userId: getSubjectUserId(user),
        conversationId: conversation.id
      });
    }
    const placed = await this.placeNew(project.id, file.filename, {
      bytes: file.bytes,
      ...(file.mimeType ? { mimeType: file.mimeType } : {}),
      origin: "person",
      userId: getSubjectUserId(user),
      conversationId: conversation.id
    });
    if (!placed) throw invalidPath();
    return placed;
  }

  /**
   * The bytes of a project file for "Add from project", where the chat may take it: the person
   * reads the project, and everyone who reads the chat reads the project too. A chat's own
   * project always passes; another project's only where its audience holds the chat's.
   */
  async fileForConversation(
    user: AuthenticatedUser,
    conversationId: string,
    input: { projectId: string; path: string }
  ) {
    const conversation = await requireChatConversationAccess(
      this.options,
      asConversationId(conversationId),
      user
    );
    const project = await this.readable(user, input.projectId);
    if (!(await this.chatReadersReadProject(conversation, project))) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Not everyone who reads this conversation reads that project",
        { reason: "project_audience_wider" },
        { exposeMessage: true }
      );
    }
    const path = requirePath(input.path);
    const stored = await this.storedVersion(project.id, path);
    return {
      conversation,
      filename: path.slice(path.lastIndexOf("/") + 1),
      mimeType: stored.mimeType,
      bytes: await readObjectBytes(this.objects(), stored.objectKey)
    };
  }

  /**
   * An upload in a chat of a project lands at the folder's root (PRJ-2). A name that is taken
   * by other bytes gets the next free one; the same bytes are left as they are. Nothing where
   * the chat is in no project or the folder has no room.
   */
  async landUpload(
    conversation: Conversation,
    user: AuthenticatedUser,
    input: { filename: string; mimeType?: string; bytes: Uint8Array }
  ): Promise<ProjectFileChange | undefined> {
    const folder = await this.folderOf({
      clientInstanceId: this.options.clientInstanceId,
      conversationId: conversation.id,
      user
    });
    if (!folder) return undefined;
    try {
      return await this.placeNew(folder.projectId, input.filename, {
        bytes: input.bytes,
        ...(input.mimeType ? { mimeType: input.mimeType } : {}),
        origin: "upload",
        userId: getSubjectUserId(user),
        conversationId: conversation.id
      });
    } catch (error) {
      if (isAppError(error) && error.code === "VALIDATION_FAILED") {
        this.options.logger.warn(
          { projectId: folder.projectId },
          "project upload not kept: the folder has no room"
        );
        return undefined;
      }
      throw error;
    }
  }

  /**
   * A new file at the folder's root under its own name. A name taken by other bytes gets the
   * next free one, `name (2).pdf`; the same bytes are left as they are.
   */
  private async placeNew(
    projectId: string,
    filename: string,
    input: Omit<WriteInput, "path" | "replaces" | "bytes"> & { bytes: Uint8Array }
  ): Promise<ProjectFileChange | undefined> {
    const name = normalizeProjectFilePath(filename.replace(/\//gu, "_"));
    if (!name) return undefined;
    const checksum = sha256(input.bytes);
    for (let attempt = 1; attempt <= 50; attempt += 1) {
      const path = attempt === 1 ? name : numbered(name, attempt);
      const current = await this.current(projectId, path);
      if (current?.checksum === checksum) {
        return { path, version: current.version, change: "unchanged" };
      }
      if (current) continue;
      try {
        return answered(await this.change({ projectId }, { ...input, path, replaces: 0 }));
      } catch (error) {
        // Taken in the meantime: the next name.
        if (isAppError(error) && error.code === "CONFLICT") continue;
        throw error;
      }
    }
    return undefined;
  }

  /** Whether the folder has room for one more file of this size, before an upload is taken. */
  async roomFor(conversation: Conversation, byteSize: number): Promise<boolean> {
    if (conversation.projectId === undefined || !this.options.modules.isEnabled("projects")) {
      return true;
    }
    if (byteSize > this.limits.maxFileBytes) return false;
    const usage = await this.options.stores.projectFiles.projectFileUsage({
      clientInstanceId: this.options.clientInstanceId,
      projectId: conversation.projectId
    });
    return (
      usage.files + 1 <= this.limits.maxFiles &&
      usage.bytes + byteSize <= this.limits.maxProjectBytes
    );
  }

  // --- The agent of a chat, through the file tools (ProjectFolderPort) ----------------------

  async folderOf(input: {
    clientInstanceId: string;
    conversationId: string;
    user?: AuthenticatedUser;
  }): Promise<ConversationProjectFolder | undefined> {
    if (input.clientInstanceId !== this.options.clientInstanceId) return undefined;
    if (!this.options.modules.isEnabled("projects")) return undefined;
    let conversation = await this.options.stores.conversations.getConversation(
      this.options.clientInstanceId,
      asConversationId(input.conversationId)
    );
    // A subagent's thread works in its root's folder: it is read through its root.
    if (conversation?.kind === "run_thread" && conversation.parentConversationId) {
      conversation = await this.options.stores.conversations.getConversation(
        this.options.clientInstanceId,
        conversation.parentConversationId
      );
    }
    if (
      !conversation ||
      conversation.kind === "run_thread" ||
      conversation.status !== "active" ||
      !conversation.projectId
    ) {
      return undefined;
    }
    const project = await this.options.stores.projects.getProject({
      clientInstanceId: this.options.clientInstanceId,
      projectId: conversation.projectId
    });
    if (!project || project.collaborationWorkspaceId !== conversation.collaborationWorkspaceId) {
      return undefined;
    }
    // The run acts for a person, who must still be in the audience. Projects are chat work of
    // people: a run without a person, or of a service principal, reaches no folder.
    if (!input.user || isAuthenticatedServicePrincipal(input.user)) return undefined;
    try {
      await requireProjectReadable(this.options, input.user, project);
    } catch (error) {
      if (isAppError(error) && error.code === "NOT_FOUND") return undefined;
      throw error;
    }
    return {
      clientInstanceId: this.options.clientInstanceId,
      projectId: project.id,
      title: project.title,
      collaborationWorkspaceId: project.collaborationWorkspaceId,
      conversationId: conversation.id
    };
  }

  async folderOfCommand(
    command: ProjectCommandFolderRequest
  ): Promise<ProjectCommandFolder | undefined> {
    if (command.clientInstanceId !== this.options.clientInstanceId || !command.agentRunId)
      return undefined;
    const run = await this.options.stores.agentRuns.getAgentRun({
      clientInstanceId: this.options.clientInstanceId,
      runId: command.agentRunId
    });
    if (
      !run?.ownerUserId ||
      run.conversationId !== command.conversationId ||
      run.ownerUserId !== command.ownerUserId ||
      run.workflowStepRunId ||
      run.principalId ||
      (run.authorization && run.authorization.principal.kind !== "user")
    )
      return undefined;
    const person = await this.options.stores.users.getUser({
      clientInstanceId: this.options.clientInstanceId,
      userId: asUserId(run.ownerUserId)
    });
    if (person?.status !== "active") return undefined;
    const user = authenticatedUserFromRecord({
      user: person,
      identity: { authSource: "project-command", externalUserId: person.id }
    });
    const folder = await this.folderOf({
      clientInstanceId: command.clientInstanceId,
      conversationId: command.conversationId,
      user
    });
    return folder
      ? { folder, userId: person.id, ...(run.locale ? { locale: run.locale } : {}) }
      : undefined;
  }

  async readVersion(folder: ConversationProjectFolder, file: ProjectFile): Promise<Uint8Array> {
    const version = await this.storedVersion(
      folder.projectId,
      requirePath(file.path),
      file.version
    );
    return readObjectBytes(this.objects(), version.objectKey);
  }

  async removeVersion(
    folder: ConversationProjectFolder,
    input: { path: string; replaces: number; userId: string; runId: string }
  ): Promise<ProjectFileChange | undefined> {
    const result = await this.change(folder, {
      ...input,
      path: requirePath(input.path),
      bytes: null,
      origin: "agent",
      conversationId: folder.conversationId
    });
    if (result.status === "conflict" || result.status === "missing") return undefined;
    return answered(result);
  }

  list(folder: ConversationProjectFolder): Promise<ProjectFile[]> {
    return this.options.stores.projectFiles.listProjectFiles({
      clientInstanceId: this.options.clientInstanceId,
      projectId: folder.projectId
    });
  }

  async read(
    folder: ConversationProjectFolder,
    rawPath: string
  ): Promise<{ file: ProjectFile; bytes: Uint8Array } | undefined> {
    const path = normalizeProjectFilePath(rawPath);
    if (!path) throw invalidPath();
    const file = await this.current(folder.projectId, path);
    if (!file) return undefined;
    return { file, bytes: await readObjectBytes(this.objects(), file.objectKey) };
  }

  async readVersion(
    folder: ConversationProjectFolder,
    rawPath: string,
    version: number
  ): Promise<Uint8Array | undefined> {
    const path = normalizeProjectFilePath(rawPath);
    if (!path) throw invalidPath();
    const kept = await this.options.stores.projectFiles.getProjectFileVersion({
      clientInstanceId: this.options.clientInstanceId,
      projectId: folder.projectId,
      path,
      version
    });
    return kept?.objectKey ? readObjectBytes(this.objects(), kept.objectKey) : undefined;
  }

  async write(
    folder: ConversationProjectFolder,
    input: {
      path: string;
      bytes: Uint8Array;
      mimeType?: string;
      replaces?: number;
      userId: string;
      runId?: string;
      locale?: string;
    }
  ): Promise<ProjectFileChange> {
    const path = normalizeProjectFilePath(input.path);
    if (!path) throw invalidPath();
    const result = await this.change(folder, {
      path,
      bytes: input.bytes,
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
      ...(input.replaces === undefined ? {} : { replaces: input.replaces }),
      origin: "agent",
      userId: input.userId,
      conversationId: folder.conversationId,
      ...(input.runId ? { runId: input.runId } : {}),
      conflictCopy: {
        author: await this.firstName(input.userId),
        ...(input.locale ? { locale: input.locale } : {})
      }
    });
    return answered(result);
  }

  // --- Inside ---------------------------------------------------------------------------------

  /** The project, where the person reaches its workspace and is in its audience. */
  private async readable(user: AuthenticatedUser, projectId: string): Promise<Project> {
    if (!this.options.modules.isEnabled("projects")) throw projectNotAvailable();
    if (isAuthenticatedServicePrincipal(user)) throw projectNotAvailable();
    return requireProjectAccess(this.options, user, projectId);
  }

  /** A change of a person: a conflict is refused, never kept as a copy they did not ask for. */
  private async changeOrRefuse(
    project: Pick<Project, "id">,
    input: WriteInput
  ): Promise<ProjectFileChange> {
    return answered(await this.change({ projectId: project.id }, input));
  }

  private async change(
    folder: { projectId: string },
    input: WriteInput
  ): Promise<WriteProjectFileVersionResult> {
    const { clientInstanceId } = this.options;
    const limits = this.limits;
    let content = null as null | {
      objectKey: string;
      byteSize: number;
      checksum: string;
      mimeType: string;
    };
    let put: string | undefined;
    if (input.stored) {
      content = input.stored;
    } else if (input.bytes !== null) {
      if (input.bytes.byteLength > limits.maxFileBytes) {
        throw overLimit("file_bytes", limits);
      }
      const checksum = sha256(input.bytes);
      const mimeType = projectFileMimeType(input.path, input.mimeType);
      const current = await this.current(folder.projectId, input.path);
      if (
        current?.checksum === checksum &&
        (input.replaces === undefined || input.replaces === current.version)
      ) {
        return { status: "unchanged", file: current };
      }
      put = `${projectFileObjectPrefix(folder.projectId)}${randomUUID()}`;
      await this.objects().put(put, input.bytes, { contentType: mimeType });
      content = { objectKey: put, byteSize: input.bytes.byteLength, checksum, mimeType };
    }
    const at = new Date();
    let result: WriteProjectFileVersionResult;
    try {
      result = await this.options.stores.projectFiles.writeProjectFileVersion({
        clientInstanceId,
        projectId: folder.projectId,
        path: input.path,
        ...(input.replaces === undefined ? {} : { replaces: input.replaces }),
        ...(input.restores === undefined ? {} : { restores: input.restores }),
        content,
        origin: input.origin,
        byUserId: input.userId,
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
        at: at.toISOString(),
        limits,
        ...(input.conflictCopy && content
          ? {
              conflictPath: projectFileConflictPath({
                path: input.path,
                author: input.conflictCopy.author,
                at,
                ...(this.options.config.clientInstance.timeZone
                  ? { timeZone: this.options.config.clientInstance.timeZone }
                  : {}),
                ...(input.conflictCopy.locale ? { locale: input.conflictCopy.locale } : {})
              })
            }
          : {})
      });
    } catch (error) {
      if (put) await this.release([put]);
      throw error;
    }
    const kept = result.status === "written" || result.status === "conflict_copy";
    if (put && !kept) await this.release([put]);
    if ("releasedObjectKeys" in result) await this.release(result.releasedObjectKeys);
    if (result.status === "over_limit") throw overLimit(result.limit, result.limits);
    return result;
  }

  private current(projectId: string, path: string): Promise<ProjectFile | undefined> {
    return this.options.stores.projectFiles.getProjectFile({
      clientInstanceId: this.options.clientInstanceId,
      projectId,
      path
    });
  }

  private async storedVersion(
    projectId: string,
    path: string,
    version?: number
  ): Promise<{ objectKey: string; mimeType: string }> {
    if (version === undefined) {
      const file = await this.current(projectId, path);
      if (!file) throw fileNotAvailable();
      return file;
    }
    const kept = await this.options.stores.projectFiles.getProjectFileVersion({
      clientInstanceId: this.options.clientInstanceId,
      projectId,
      path,
      version
    });
    if (!kept?.objectKey) throw fileNotAvailable();
    return { objectKey: kept.objectKey, mimeType: kept.mimeType ?? projectFileMimeType(path) };
  }

  /** Who reads the chat is held by who reads the project. */
  private async chatReadersReadProject(
    conversation: Conversation,
    project: Project
  ): Promise<boolean> {
    if (conversation.projectId === project.id) return true;
    const chat = await this.readersOfConversation(conversation);
    // One person reads the chat, and the person asking reads the project: the asking person is
    // that one, as nobody else reaches a chat only one person reads.
    if (chat.kind === "person") return true;
    const readers = await this.readersOfProject(project);
    return readers.kind === "workspace" && readers.workspaceId === chat.workspaceId;
  }

  private async readersOfConversation(
    conversation: Conversation
  ): Promise<{ kind: "person" } | { kind: "workspace"; workspaceId: string }> {
    if (conversation.projectId !== undefined) {
      const own = await this.options.stores.projects.getProject({
        clientInstanceId: this.options.clientInstanceId,
        projectId: conversation.projectId
      });
      if (!own) throw new AppError("NOT_FOUND", "Conversation is not available");
      return this.readersOfProject(own);
    }
    if (conversation.visibility === "private") return { kind: "person" };
    return this.readersOfWorkspace(conversation.collaborationWorkspaceId);
  }

  private async readersOfProject(
    project: Project
  ): Promise<{ kind: "person" } | { kind: "workspace"; workspaceId: string }> {
    if (project.audience === "private") return { kind: "person" };
    return this.readersOfWorkspace(project.collaborationWorkspaceId);
  }

  private async readersOfWorkspace(
    workspaceId: Conversation["collaborationWorkspaceId"]
  ): Promise<{ kind: "person" } | { kind: "workspace"; workspaceId: string }> {
    const workspace = await this.options.stores.workspaces.getWorkspace(
      this.options.clientInstanceId,
      workspaceId
    );
    return workspace?.kind === "personal" ? { kind: "person" } : { kind: "workspace", workspaceId };
  }

  private async conversationFile(
    conversation: Conversation,
    source: { fileId: string } | { artifactId: string }
  ): Promise<{ filename: string; mimeType?: string; bytes: Uint8Array }> {
    if ("fileId" in source) {
      if (!this.options.attachments) throw fileNotAvailable();
      const file = await this.options.attachments.readConversationFile({
        conversationId: conversation.id,
        fileId: source.fileId
      });
      return {
        filename: file.filename,
        ...(file.mimeType ? { mimeType: file.mimeType } : {}),
        bytes: file.bytes
      };
    }
    const artifactId = asManagedArtifactId(source.artifactId);
    const record = await this.options.stores.files.getManagedArtifact({
      clientInstanceId: this.options.clientInstanceId,
      artifactId
    });
    if (!record || record.conversationId !== conversation.id || !this.options.managedObjects) {
      throw fileNotAvailable();
    }
    const artifact = await this.options.managedObjects.readArtifact({
      clientInstanceId: this.options.clientInstanceId,
      artifactId
    });
    return {
      filename: record.filename ?? record.id,
      mimeType: artifact.mimeType,
      bytes: artifact.bytes
    };
  }

  private objects(): ObjectStorage {
    const objects = this.options.pages?.objects;
    if (!objects) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Project files are kept in the instance's files store, and this instance has none",
        { reason: "project_files_unavailable" },
        { exposeMessage: true }
      );
    }
    return objects;
  }

  /** Removes objects no kept version names. One that stays is under the project's prefix. */
  private async release(objectKeys: readonly string[]): Promise<void> {
    for (const key of objectKeys) {
      try {
        await this.objects().delete(key);
      } catch (error) {
        this.options.logger.warn(
          { errorCode: isAppError(error) ? error.code : "INTERNAL" },
          "project file object not removed"
        );
      }
    }
  }

  private async labels(userIds: readonly (string | undefined)[]): Promise<Map<string, string>> {
    const labels = new Map<string, string>();
    for (const userId of new Set(userIds)) {
      if (!userId) continue;
      const user = await this.options.stores.users.getUser({
        clientInstanceId: this.options.clientInstanceId,
        userId: asUserId(userId)
      });
      if (user) labels.set(userId, user.displayLabel);
    }
    return labels;
  }

  private async firstName(userId: string): Promise<string> {
    const label = (await this.labels([userId])).get(userId) ?? "";
    return label.split(/[\s@]/u)[0] ?? "";
  }
}

/** The answer of a change, or the refusal a person reads for it. */
function answered(result: WriteProjectFileVersionResult): ProjectFileChange {
  switch (result.status) {
    case "written":
      return {
        path: result.file.path,
        version: result.file.version,
        change: result.previousVersion === undefined ? "created" : "updated",
        ...(result.previousVersion === undefined ? {} : { previousVersion: result.previousVersion })
      };
    case "deleted":
      return {
        path: result.path,
        version: result.version,
        change: "deleted",
        previousVersion: result.previousVersion
      };
    case "conflict_copy":
      return {
        path: result.file.path,
        version: result.file.version,
        change: "conflict_copy",
        changed: { path: result.changedPath, version: result.currentVersion }
      };
    case "unchanged":
      return { path: result.file.path, version: result.file.version, change: "unchanged" };
    case "conflict":
      throw new AppError(
        "CONFLICT",
        `${result.path} changed since: it is at version ${String(result.currentVersion)}`,
        { reason: "project_file_changed", currentVersion: result.currentVersion },
        { exposeMessage: true }
      );
    case "missing":
      throw fileNotAvailable();
    case "over_limit":
      throw overLimit(result.limit, result.limits);
  }
}

function overLimit(limit: string, limits: ProjectFileLimits): AppError {
  const message =
    limit === "file_bytes"
      ? `A project file has at most ${String(limits.maxFileBytes)} bytes`
      : limit === "files"
        ? `A project holds at most ${String(limits.maxFiles)} files`
        : `A project holds at most ${String(limits.maxProjectBytes)} bytes with its versions`;
  return new AppError(
    "VALIDATION_FAILED",
    message,
    { reason: `project_${limit}_limit`, ...limits },
    { exposeMessage: true }
  );
}

function fileNotAvailable(): AppError {
  return new AppError("NOT_FOUND", "Project file is not available");
}

function invalidPath(): AppError {
  return new AppError(
    "VALIDATION_FAILED",
    "A project file path is folders and a name joined by /, without . or .. and at most 512 characters",
    { reason: "project_file_path" },
    { exposeMessage: true }
  );
}

function requirePath(path: string): string {
  const normalized = normalizeProjectFilePath(path);
  if (!normalized) throw invalidPath();
  return normalized;
}

function storedOf(version: ProjectFileVersion) {
  if (!version.objectKey) throw fileNotAvailable();
  return {
    objectKey: version.objectKey,
    byteSize: version.byteSize,
    checksum: version.checksum ?? "",
    mimeType: version.mimeType ?? projectFileMimeType(version.path)
  };
}

/** The person who made a version, by name; nothing once that person is deleted. */
function withPerson<Shown extends object>(
  userId: string | undefined,
  labels: Map<string, string>,
  show: (person: { id: string; label: string }) => Shown
): Partial<Shown> {
  const label = userId ? labels.get(userId) : undefined;
  return userId && label ? show({ id: userId, label }) : {};
}

function numbered(path: string, attempt: number): string {
  const dot = path.lastIndexOf(".");
  const split = dot > path.lastIndexOf("/") + 1 ? dot : path.length;
  return `${path.slice(0, split)} (${String(attempt)})${path.slice(split)}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
