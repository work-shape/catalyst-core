import { renderRuntimeRules } from "@work-shape/catalyst-app-build";
import { posix as posixPath } from "node:path";
import { z } from "zod";
import {
  asUserId,
  getRuntimeSubjectUserId,
  isAppError,
  normalizePageName,
  PAGE_NAME_MAX_CHARS,
  requireFileSetWithinLimits,
  type PageBuildClient,
  type PageBuildIssue,
  type ToolExecutionContext,
  type ToolHandlerResult
} from "@work-shape/catalyst-core";
import { defineTool, toolSuccess, type AnyToolDefinition } from "@work-shape/catalyst-tool-sdk";
import { normalizeWorkspaceDirectory as normalizeWorkspacePath } from "./workspace-paths";
import { failed, normalizeWorkspaceDirectory } from "./workspace-tool-results";
import type { WorkspaceToolDependencies } from "./workspace-tools/dependencies";
import { resolveWorkspaceHandle } from "./workspace-tools/workspace";

// Opening a file or folder of the workspace in the preview panel. The tool takes the folder as
// it is now, by the objects its files are stored in, and hands that snapshot to the build,
// which stores it as a revision of the conversation's Page of that path: the unsaved folder,
// which no member sees by that name. It reads no file itself and runs none, and it writes no
// asset and no App: keeping it is `app.save`.

export const WORKSPACE_OPEN_TOOL_NAME = "workspace.open";
/** The manifest of an App's folder. A folder without it opens only as plain HTML. */
const APP_MANIFEST_FILE = "app.yaml";
/** What a folder without a manifest opens. */
const DEFAULT_HTML_ENTRY = "index.html";
const HTML_FILE = /\.html?$/iu;

export interface WorkspaceOpenToolOptions {
  /** What the workspace tools of the instance work with: the same workspace, the same limits. */
  workspace: WorkspaceToolDependencies;
  builds: PageBuildClient;
}

/**
 * The Page an open of `path` stores its revisions under, and that `app.save` of the same path
 * keeps: one per path, named by the path as the workspace normalizes it.
 */
export function openedPageName(path: string): { name: string } | { refusal: string } {
  const normalized = normalizeWorkspacePath(path, { maxPathLength: PAGE_NAME_MAX_CHARS });
  if (normalized.status === "failed") return { refusal: normalized.message };
  try {
    return { name: normalizePageName(normalized.value) };
  } catch (error) {
    return { refusal: isAppError(error) ? error.message : "The path is invalid" };
  }
}

const workspaceOpenInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(PAGE_NAME_MAX_CHARS)
    .describe(
      "The HTML file or the folder of the execution workspace to show. A folder holds app.yaml directly inside it, or an index.html."
    )
});

const pageBuildIssueSchema = z.object({
  file: z.string(),
  line: z.number().int().optional(),
  column: z.number().int().optional(),
  message: z.string(),
  code: z.string().optional(),
  element: z.string().optional(),
  rule: z.string().max(64).optional(),
  sentence: z.string().max(512).optional(),
  fix: z.string().max(512).optional(),
  attribute: z.string().optional()
});

const workspaceOpenOutputSchema = z.union([
  z.object({
    pageId: z.string(),
    number: z.number().int(),
    fileSetId: z.string(),
    title: z.string().optional()
  }),
  z.object({ errors: z.array(pageBuildIssueSchema) })
]);

type WorkspaceOpenOutput = z.infer<typeof workspaceOpenOutputSchema>;

export function createWorkspaceOpenTool(options: WorkspaceOpenToolOptions): AnyToolDefinition {
  return defineTool({
    name: WORKSPACE_OPEN_TOOL_NAME,
    title: { en: "Open in preview", de: "In der Vorschau öffnen" },
    summary: {
      en: "Shows an HTML file or an App's folder beside the chat, built as it is now.",
      de: "Zeigt eine HTML-Datei oder den Ordner einer App neben dem Chat, gebaut wie er jetzt ist."
    },
    group: "results",
    icon: "app",
    // The built folder outlives the call and shows beside the conversation.
    effect: "changing",
    description: [
      "Show an HTML file or a folder of the execution workspace in the preview panel beside the conversation. It only shows: it keeps nothing and creates no App; keeping it is app.save.",
      "For an app, a dashboard or a tool, write its folder with the workspace file tools and open it, never a loose HTML file. Hard-coded data is fine for a quick one; live data comes through actions once it is kept as an App.",
      "When to use a View, an App or a Workflow: references/apps/app-or-workflow.md in 'platform-docs'.",
      "A folder opens with app.yaml (id, name, kit: an exact kit version, which is 1.8.0 for a new App, optional entry); without app.yaml it opens its index.html. A React App has TanStack Router file routes under src/routes/ (__root.tsx, index.tsx) and imports only its own files, react, react-dom, @tanstack/react-router and @work-shape/catalyst-app-kit; nothing is installed. A plain HTML App names 'entry: index.html' and adds listeners in a script: inline handlers such as onclick are refused.",
      renderRuntimeRules(),
      "Sandbox: allow-scripts allow-forms allow-downloads without allow-same-origin; handle submit with preventDefault, since form-action 'none' blocks navigation. Use the kit's storage.get/set (1.6.0) for small preferences, catch storage errors such as SecurityError, and keep shared records in Data Stores through named actions. Network reaches only the manifest's reviewed hosts on a published App; use named actions for platform calls.",
      "Put fonts and libraries in the App's folder or use the kit's; an outside address (Google Fonts, Adobe Fonts or a CDN) will not load.",
      "Plain elements get the interface's look in light and dark from kit 1.2.0; colour your own rules with var(--background), var(--foreground), var(--muted-foreground), var(--border) or var(--primary), never fixed colours.",
      "Before writing an action, read its page of 'platform-docs': references/apps/connection-actions.md, data-store-actions.md or workflow-actions.md; examples.md has whole Apps, sandbox.md the styling and storage rules, troubleshooting.md a failed save or call.",
      "Returns the revision shown and its name, or the build errors with file and line: fix the files and open them again."
    ].join(" "),
    inputSchema: workspaceOpenInputSchema,
    outputSchema: workspaceOpenOutputSchema,
    // Runs on the agent's own call, like the workspace tools that wrote the folder. Without a
    // mode the instance default for changes would apply.
    permission: { mode: "allow" },
    execute(input, context) {
      return openInPreview(options, input, context);
    }
  });
}

async function openInPreview(
  options: WorkspaceOpenToolOptions,
  input: z.infer<typeof workspaceOpenInputSchema>,
  context: ToolExecutionContext
): Promise<ToolHandlerResult<WorkspaceOpenOutput>> {
  const { workspace: deps } = options;
  const target = normalizeWorkspaceDirectory(input.path, deps.limits);
  if (target.status === "failed") {
    return target.result;
  }
  const page = openedPageName(target.value);
  if ("refusal" in page) {
    return failed("validation_failed", page.refusal);
  }
  const workspace = await resolveWorkspaceHandle(deps, context);
  if (workspace.status === "failed") {
    return workspace.result;
  }
  const stored = await deps.store.executionWorkspaces.listWorkspaceFiles({
    clientInstanceId: context.clientInstanceId,
    workspaceId: workspace.value.handle.id
  });
  const refuse = (errors: PageBuildIssue[]) =>
    toolSuccess<WorkspaceOpenOutput>(
      { errors },
      {
        auditSummary: {
          action: WORKSPACE_OPEN_TOOL_NAME,
          subject: workspace.value.handle.id,
          metadata: { opened: false, errorCount: errors.length }
        }
      }
    );
  // A file opens with the folder it lies in; a path that is no file names a folder.
  const openedFile = stored.some((file) => file.path === target.value);
  if (openedFile && !HTML_FILE.test(target.value)) {
    return refuse([
      {
        file: target.value,
        code: "file_invalid",
        message: `'${input.path}' is no HTML file. Open an HTML file, or a folder with app.yaml or index.html.`
      }
    ]);
  }
  const directory = openedFile ? posixPath.dirname(target.value) : target.value;
  const prefix = directory === "." ? "" : `${directory}/`;
  const files = stored
    .filter((file) => file.path.startsWith(prefix))
    .map((file) => ({
      path: file.path.slice(prefix.length),
      objectKey: file.objectKey,
      byteSize: file.byteSize,
      checksum: file.checksum
    }));
  const hasManifest = files.some((file) => file.path === APP_MANIFEST_FILE);
  // Without a manifest the build gives the HTML file the manifest of plain HTML.
  const entry = hasManifest
    ? undefined
    : openedFile
      ? posixPath.basename(target.value)
      : files.some((file) => file.path === DEFAULT_HTML_ENTRY)
        ? DEFAULT_HTML_ENTRY
        : undefined;
  if (!hasManifest && entry === undefined) {
    return refuse([
      {
        file: APP_MANIFEST_FILE,
        code: "manifest_invalid",
        message: `The folder '${input.path}' has no app.yaml and no index.html${files.length === 0 ? "; it holds no file at all" : ""}. Open an HTML file, or a folder with one of them directly inside it.`
      }
    ]);
  }
  try {
    // The limits of a file set, on the source files alone: a folder over them cannot become
    // one, so no build is queued for it. The built files are counted when the set is stored.
    requireFileSetWithinLimits(
      files.map((file) => ({ part: "src" as const, path: file.path, bytes: file.byteSize }))
    );
  } catch (error) {
    if (!isAppError(error) || error.code !== "VALIDATION_FAILED") {
      throw error;
    }
    const details = isRecord(error.details) ? error.details : {};
    return refuse([
      {
        file: typeof details.file === "string" ? details.file : APP_MANIFEST_FILE,
        message: error.message,
        ...(typeof details.reason === "string" ? { code: details.reason } : {})
      }
    ]);
  }
  const outcome = await options.builds.build({
    clientInstanceId: context.clientInstanceId,
    conversationId: workspace.value.conversationId,
    request: {
      pageName: page.name,
      directory,
      files,
      ...(entry === undefined ? {} : { entry }),
      requestedByUserId: asUserId(getRuntimeSubjectUserId(context))
    },
    signal: context.signal,
    deadline: context.deadline
  });
  if (outcome.status === "failed") {
    return failed("handler_failed", outcome.message);
  }
  if (outcome.status === "errors") {
    return refuse(outcome.errors);
  }
  return toolSuccess<WorkspaceOpenOutput>(
    {
      pageId: outcome.pageId,
      number: outcome.number,
      fileSetId: outcome.fileSetId,
      ...(outcome.title === undefined ? {} : { title: outcome.title })
    },
    {
      auditSummary: {
        action: WORKSPACE_OPEN_TOOL_NAME,
        subject: outcome.pageId,
        metadata: {
          opened: true,
          fileSetId: outcome.fileSetId,
          number: outcome.number,
          sourceFileCount: files.length
        }
      }
    }
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
