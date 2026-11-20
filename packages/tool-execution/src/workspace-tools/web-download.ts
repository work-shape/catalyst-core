import { z } from "zod";
import {
  isJsonObject,
  type JsonObject,
  type ToolExecutionContext,
  type ToolHandlerResult
} from "@work-shape/catalyst-core";
import { defineTool, toolSuccess } from "@work-shape/catalyst-tool-sdk";
import { WEB_DOWNLOAD_TOOL_NAME, WebFetchFailure } from "@work-shape/catalyst-web-access";
import { failed, workspacePathFromFilename } from "../workspace-tool-results";
import type { WorkspaceToolDependencies, WorkspaceWebDownloader } from "./dependencies";
import {
  checkPathFitsWorkspace,
  checkWorkspaceRoom,
  resolveTextFilePath,
  storeTextFile
} from "./stored-text-file";

// One file from a public address into the conversation's execution workspace (web_download).
// The bytes go only there: the agent reads them with the workspace and document tools, and a
// person sees them only once the agent promotes a result. The audit names the host, the media
// type and the size; never the address's path or query, the file's name or its bytes.

export { WEB_DOWNLOAD_TOOL_NAME };

const webDownloadInputSchema = z
  .object({
    url: z.string().url().describe("Public http or https address of the file."),
    path: z
      .string()
      .min(1)
      .max(1024)
      .describe(
        "Where the file is written in /workspace, such as inputs/report.pdf. Omit it for inputs/ and the file's own name."
      )
      .optional()
  })
  .strict();

const webDownloadOutputSchema = z.object({
  path: z.string(),
  finalUrl: z.string(),
  mediaType: z.string(),
  byteSize: z.number().int(),
  checksum: z.string()
});

export function workspaceWebDownloadTool(
  deps: WorkspaceToolDependencies & { webDownload: WorkspaceWebDownloader }
) {
  return defineTool({
    name: WEB_DOWNLOAD_TOOL_NAME,
    title: { en: "Download file from the web", de: "Datei aus dem Web laden" },
    summary: {
      en: "Saves a file from a public address in the conversation's files, to work on it.",
      de: "Speichert eine Datei von einer öffentlichen Adresse in den Dateien der Unterhaltung, um damit zu arbeiten."
    },
    group: "web",
    icon: "web",
    effect: "changing",
    // Runs on the agent's own call, like workspace.import_files: it writes only the workspace.
    permission: { mode: "allow" },
    description: [
      "Download one file from a public http or https address into /workspace, such as a PDF, an image, a CSV or an Excel workbook linked from a page or a message. Then read or analyse it with workspace.exec, workspace.read_file, workspace.preview_images and the artifact helpers, using the returned path exactly.",
      "Use web_fetch to read a web page as text; use this tool for a file. It cannot reach localhost, private networks or pages behind a sign-in, and it runs no JavaScript.",
      "Only the media types this instance allows are taken, and a file above its size limit is refused, not cut. An existing file at the path is replaced."
    ].join(" "),
    inputSchema: webDownloadInputSchema,
    outputSchema: webDownloadOutputSchema,
    execute(input, context) {
      return downloadIntoWorkspace(deps, input, context);
    }
  });
}

async function downloadIntoWorkspace(
  deps: WorkspaceToolDependencies & { webDownload: WorkspaceWebDownloader },
  input: z.infer<typeof webDownloadInputSchema>,
  context: ToolExecutionContext
): Promise<ToolHandlerResult<z.infer<typeof webDownloadOutputSchema>>> {
  const { fileStore } = deps;
  if (!fileStore) {
    return failed(
      "handler_failed",
      `This instance has no storage for workspace files, so ${WEB_DOWNLOAD_TOOL_NAME} cannot run. Tell the person this is a problem of the platform, not of their input.`
    );
  }
  // A path the agent named is checked before anything is fetched.
  const namedPath = input.path ? resolveTextFilePath(input.path, deps.limits) : undefined;
  if (namedPath?.status === "failed") return namedPath.result;
  const workspace = await deps.workspaces.resolveWorkspaceHandle(context);
  if (!workspace) return failed("handler_failed", "Workspace tools require an active tool request");
  const listFiles = () =>
    deps.store.executionWorkspaces.listWorkspaceFiles({
      clientInstanceId: context.clientInstanceId,
      workspaceId: workspace.handle.id
    });

  // The file may take at most the room the workspace has left, so a file that cannot be kept is
  // not read: a larger declared size is refused unread, a longer body is cut off and refused.
  const before = await listFiles();
  const otherBytes = before
    .filter((existing) => existing.path !== namedPath?.value)
    .reduce((total, existing) => total + existing.byteSize, 0);
  const roomBytes = deps.limits.maxWorkspaceBytes - otherBytes;
  if (roomBytes < 1) {
    const full = checkWorkspaceRoom(deps, before, namedPath?.value ?? "", 1);
    if (full.status === "failed") return full.result;
  }

  let file;
  try {
    file = await deps.webDownload.download(
      { url: input.url, maxBytes: roomBytes },
      { deadline: context.deadline, signal: context.signal }
    );
  } catch (error) {
    if (error instanceof WebFetchFailure) {
      const noRoom = error.metadata.reason === "too_large" && error.metadata.maxBytes === roomBytes;
      return {
        status: error.resultStatus,
        error: {
          code: error.code,
          message: noRoom
            ? `The file is larger than the ${roomBytes} bytes the workspace has room for (maxWorkspaceBytes), so nothing was saved. Remove files that are no longer needed with workspace.exec, then call again.`
            : error.message
        },
        auditSummary: {
          action: WEB_DOWNLOAD_TOOL_NAME,
          ...hostSubject(error.subject),
          metadata: minimizedFailure(error.metadata, error.subject)
        }
      };
    }
    throw error;
  }

  const files = await listFiles();
  // A name the server or the address gives never replaces a file, such as an imported
  // attachment of the same name: it gets the next free name. A path the agent named does.
  const target =
    namedPath ??
    resolveTextFilePath(
      freePath(
        files,
        withExtension(
          workspacePathFromFilename(file.filename ?? filenameOf(file.finalUrl), "download"),
          file.mediaType
        )
      ),
      deps.limits
    );
  if (target.status === "failed") return target.result;
  const fits = checkPathFitsWorkspace(files, target.value);
  if (fits.status === "failed") return fits.result;
  const room = checkWorkspaceRoom(deps, files, target.value, file.bytes.byteLength);
  if (room.status === "failed") return room.result;
  const stored = await storeTextFile({ ...deps, fileStore }, context, {
    toolName: WEB_DOWNLOAD_TOOL_NAME,
    workspace,
    path: target.value,
    bytes: file.bytes,
    // A replaced file keeps nothing of what it was, such as the upload it came from.
    existing: undefined,
    mimeType: file.mediaType
  });
  const host = hostOf(file.finalUrl);
  return toolSuccess(
    {
      path: stored.path,
      finalUrl: file.finalUrl,
      mediaType: file.mediaType,
      byteSize: stored.byteSize,
      checksum: stored.checksum
    },
    {
      auditSummary: {
        action: WEB_DOWNLOAD_TOOL_NAME,
        ...(host ? { subject: host } : {}),
        metadata: {
          status: "success",
          ...(host ? { host } : {}),
          contentType: file.mediaType,
          byteSize: stored.byteSize,
          redirectCount: file.redirectCount
        }
      }
    }
  );
}

/** The fields of a failure the audit keeps: why, and how much. No address, path or name. */
const FAILURE_AUDIT_KEYS = [
  "status",
  "reason",
  "httpStatus",
  "contentEncoding",
  "bytes",
  "maxBytes",
  "redirectCount"
] as const;

function minimizedFailure(metadata: JsonObject, subject: string): JsonObject {
  const kept: JsonObject = {};
  for (const key of FAILURE_AUDIT_KEYS) {
    const value = metadata[key];
    if (value !== undefined && !isJsonObject(value) && !Array.isArray(value)) kept[key] = value;
  }
  const contentType = metadata.contentType;
  if (typeof contentType === "string") {
    const mediaType = contentType.split(";")[0]?.trim().toLowerCase();
    if (mediaType) kept.contentType = mediaType;
  }
  const host = hostOf(subject);
  if (host) kept.host = host;
  return kept;
}

function hostSubject(url: string): { subject?: string } {
  const host = hostOf(url);
  return host ? { subject: host } : {};
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

/** The last segment of the address's path, as the name of a file with no name of its own. */
function filenameOf(url: string): string {
  try {
    const segment = new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "";
    return decodeURIComponent(segment) || "download";
  } catch {
    return "download";
  }
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/tiff": ".tiff",
  "image/heic": ".heic",
  "text/csv": ".csv",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/tab-separated-values": ".tsv",
  "application/json": ".json",
  "application/xml": ".xml",
  "text/xml": ".xml",
  "application/zip": ".zip",
  "application/msword": ".doc",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx"
};

/** `path`, or the first of `name-1.ext`, `name-2.ext` ... that no file or folder takes. */
function freePath(files: readonly { path: string }[], path: string): string {
  const taken = (candidate: string) =>
    files.some((file) => file.path === candidate || file.path.startsWith(`${candidate}/`));
  if (!taken(path)) return path;
  const name = path.split("/").at(-1) ?? path;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot) : "";
  const stem = path.slice(0, path.length - extension.length);
  for (let next = 1; ; next += 1) {
    const candidate = `${stem}-${next}${extension}`;
    if (!taken(candidate)) return candidate;
  }
}

/** A name with no extension gets the one of its media type, so the helpers recognise it. */
function withExtension(path: string, mediaType: string): string {
  const name = path.split("/").at(-1) ?? path;
  if (/\.[a-z0-9]{1,16}$/iu.test(name)) return path;
  return `${path}${EXTENSIONS[mediaType] ?? ""}`;
}
