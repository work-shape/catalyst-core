import type {
  AuditRecorder,
  HtmlPdfService,
  ClientInstanceId,
  ConversationId,
  ManagedFileId,
  ObjectStorage,
  PlatformStores,
  ProjectFolderPort,
  ToolExecutionContext,
  WorkspaceCommand
} from "@work-shape/catalyst-core";
import {
  createWorkspaceCommandClient,
  type WorkspaceCommandClient
} from "../workspace-command-client";
import type { DirectWebDownloader } from "@work-shape/catalyst-web-access";
import type { WorkspaceSkillSource } from "../run-skills";
import type { WorkspaceCommandTelemetry } from "../workspace-command-telemetry";
import { DEFAULT_LIMITS, type WorkspaceCommandServiceLimits } from "../workspace-tool-schemas";
import {
  createExecutionWorkspaceHandleResolver,
  type ExecutionWorkspaceHandleResolver
} from "./workspace-handle-resolver";

export type WorkspaceToolStore = Pick<PlatformStores, "files" | "executionWorkspaces">;

export interface WorkspaceSourceFileReader {
  readSourceFile(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    fileId: string;
  }): Promise<{
    fileId: ManagedFileId;
    filename: string;
    mimeType?: string;
    byteSize: number;
    bytes: Uint8Array;
  }>;
}

/** The downloader the instance builds from `webAccess.download`, for `web_download`. */
export type WorkspaceWebDownloader = Pick<DirectWebDownloader, "download">;

export interface WorkspaceCommandResultSource {
  resolveWorkspaceCommand(input: {
    command: WorkspaceCommand;
    context: ToolExecutionContext;
  }): Promise<WorkspaceCommand | undefined>;
}

export interface WorkspaceCommandServiceOptions {
  /** The stores of the process. A command and its job are queued in one transaction of them. */
  store: Pick<PlatformStores, "files" | "executionWorkspaces" | "jobs" | "transaction">;
  /** The `workspaces` store, for tools that only read file bytes. */
  objectStore?: ObjectStorage;
  /** The `workspaces` store, for tools that also write. It serves the reads when given alone. */
  fileStore?: ObjectStorage;
  sourceFileReader?: WorkspaceSourceFileReader;
  commandResults?: WorkspaceCommandResultSource;
  /**
   * The skills of an agent run, which its commands mount read-only at `/skills/<name>/`.
   * Without it no command mounts a skill.
   */
  skills?: WorkspaceSkillSource;
  auditRecorder?: AuditRecorder;
  telemetry?: WorkspaceCommandTelemetry;
  /**
   * The folder of the project a conversation is in (PRJ-2): the file tools read and write it
   * under `project/`. Without it, `project/` is a path of the run's workspace like any other.
   */
  projectFolder?: ProjectFolderPort;
  limits?: Partial<WorkspaceCommandServiceLimits>;
  /**
   * The instance's renderer of HTML to PDF (PDF-1). With it the workspace tools include
   * `workspace.html_to_pdf`; without it they do not.
   */
  htmlPdf?: HtmlPdfService;
  /**
   * The instance's downloader of public files (`webAccess.download`). With it the workspace
   * tools include `web_download`; without it they do not.
   */
  webDownload?: WorkspaceWebDownloader;
  execResultWaitMs?: number;
  execResultPollIntervalMs?: number;
  now?: () => string;
}

/** What every workspace tool works with: the service options with their defaults filled in. */
export interface WorkspaceToolDependencies {
  readonly store: Pick<PlatformStores, "files" | "executionWorkspaces">;
  readonly commands: WorkspaceCommandClient;
  readonly workspaces: ExecutionWorkspaceHandleResolver;
  readonly objectStore?: ObjectStorage;
  readonly fileStore?: ObjectStorage;
  readonly sourceFileReader?: WorkspaceSourceFileReader;
  readonly commandResults?: WorkspaceCommandResultSource;
  readonly skills?: WorkspaceSkillSource;
  readonly auditRecorder?: AuditRecorder;
  readonly telemetry?: WorkspaceCommandTelemetry;
  readonly projectFolder?: ProjectFolderPort;
  readonly htmlPdf?: HtmlPdfService;
  readonly webDownload?: WorkspaceWebDownloader;
  readonly limits: WorkspaceCommandServiceLimits;
  readonly now: () => string;
}

export function resolveWorkspaceToolDependencies(
  options: WorkspaceCommandServiceOptions
): WorkspaceToolDependencies {
  const now = options.now ?? (() => new Date().toISOString());
  return {
    store: options.store,
    workspaces: createExecutionWorkspaceHandleResolver({
      store: options.store.executionWorkspaces,
      now
    }),
    commands: createWorkspaceCommandClient({
      stores: options.store,
      resultWaitMs: options.execResultWaitMs,
      resultPollIntervalMs: options.execResultPollIntervalMs,
      now
    }),
    fileStore: options.fileStore,
    objectStore: options.objectStore ?? options.fileStore,
    sourceFileReader: options.sourceFileReader,
    commandResults: options.commandResults,
    skills: options.skills,
    auditRecorder: options.auditRecorder,
    telemetry: options.telemetry,
    projectFolder: options.projectFolder,
    htmlPdf: options.htmlPdf,
    webDownload: options.webDownload,
    limits: {
      ...DEFAULT_LIMITS,
      ...options.limits
    },
    now
  };
}
