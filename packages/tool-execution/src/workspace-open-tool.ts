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
      "Show an HTML file or a folder of the execution workspace in the preview panel beside the conversation. It shows and does nothing more: it keeps nothing, creates no App and changes no draft. Keeping it is app.save.",
      "When the person asks for an app, a dashboard or a tool, write its folder with the workspace file tools and open it; never hand over a loose HTML file instead. Hard-coded data is fine for a quick one, and live data through actions is for when the person asks to keep it as an App.",
      "Choosing a View, an App or a Workflow: references/apps/app-or-workflow.md in 'platform-docs'.",
      "An HTML file opens as it is. A folder opens with app.yaml (id, name, kit: an exact kit version, which is 1.8.0 for a new App, optional entry) and its files; a folder without app.yaml opens its index.html.",
      "A React App has its routes under src/routes/ (TanStack Router file routes, src/routes/__root.tsx and src/routes/index.tsx) and imports only its own files, react, react-dom, @tanstack/react-router and @work-shape/catalyst-app-kit; nothing is installed.",
      "An App that reads from a Connection names kit 1.1.0 or later, lists the Connection under 'connections' in app.yaml and has one file actions/<name>.action.yaml per call (connection, operation, effect: reading or changing, optional input with a JSON 'schema' of the parameters and a 'mapping' whose \"{{parameter}}\" values stand for them). Its code calls actions.call(name, params) from the kit and gets { runId, status, result }; the call runs with the rights of whoever looks at it. A changing call also passes { idempotencyKey } and is carried out only once the App is published: the preview refuses it, and the App's draft answers { status: 'dry_run', message, result } with what it would have done, unless the person switched on 'Run live once' for that action. A call that is refused or fails rejects with an AppCallError: show its message as it is, since it is the platform's sentence in the viewer's language, and offer no button to try again when its retryable is false.",
      "An App that keeps data in a Data Store lists it under 'dataStores' in app.yaml and has one file actions/<name>.sql per statement: lines '-- @param <name> <type> [optional]', then one SELECT or WITH naming each parameter as $name, or one INSERT of parameters. Each statement also needs a line { name, file, effect } under 'actions' in app.yaml.",
      "An App that starts a Workflow names kit 1.3.0 or later and has one file actions/<name>.action.yaml with 'workflow: <Workflow id>' in place of connection, operation and effect, and an optional input whose 'mapping' makes the input the Workflow declares from the parameters of the 'schema'. The call starts the published Workflow as whoever looks at the App, who needs only the right to use the App, since publishing the App needs the right to use the Workflow; it answers { runId, status, result } with the Workflow Run in result: pass result.id to useWorkflowRun from the kit, which reads the run's status, output and error every second until it is over, or in plain HTML call workflowRuns.get(result.id). In the preview nothing is started: the call answers { status: 'dry_run', message, result } with the platform's sentence of what it would have started with which input; show the message as it is. In an App's draft the call starts a test run of the Workflow, of its draft for a person who may write it, so App and Workflow are tried together before either is published; the run's changing steps are simulated, and the run carries mode 'test', workflowRevision and simulatedSteps (kit 1.8.0).",
      "Sandbox: allow-scripts allow-forms allow-downloads without allow-same-origin. Handle form submit with preventDefault; form-action 'none' blocks form navigation. In saved Apps window.localStorage is a per-person shim; prefer kit 1.6.0 storage.get/set for small JSON preferences, and named actions on Data Stores for shared business records. An unsaved preview keeps temporary in-memory storage until saved; catch storage errors (including SecurityError when running outside the App runtime) and keep the App rendering. Network reaches only reviewed manifest hosts on a published App; use named actions for Connections, never a direct platform fetch.",
      "Put fonts and libraries in the App's folder or use the kit's; an outside address (Google Fonts, Adobe Fonts or a CDN) will not load.",
      "A plain HTML App names 'entry: index.html'; inline scripts and styles are allowed, inline event handler attributes such as onclick are not: add listeners in a script.",
      "With kit 1.2.0 or later plain HTML is given the look of the platform without asking for it, also when its script imports the kit to call an action: room around the body, the font and type sizes, the colours of the interface in light and dark, and styles for headings, text, links, lists, code, tables, buttons and form fields. Write plain elements and set no page margin, font or colour unless the App needs a look of its own. The App's class names are its own: the platform's stylesheet for plain HTML defines no class. A rule of the App's own wins when it stands outside any @layer or in a layer the App names itself; do not write the App's rules into @layer base or @layer components. An App that sets a background sets the text colour with it. For a colour use the custom properties --background, --foreground, --muted, --muted-foreground, --border, --primary and --accent-foreground, which follow light and dark; a fixed colour does not. Which stylesheet an HTML file gets is decided per file by what its scripts import: a file with a script that imports react, react/jsx-runtime, react-dom, react-dom/client, @work-shape/catalyst-app-kit/ui, @work-shape/catalyst-app-kit/router or @tanstack/react-router gets the kit's component stylesheet and none of these styles for plain elements, so build such an App with React unless it must be HTML; every other HTML file gets the styles for plain elements, also one whose script imports @work-shape/catalyst-app-kit for actions or the context, or drawChart from @work-shape/catalyst-app-kit/charts.",
      "The App guide of 'platform-docs' has one page per task; read only the one the task needs, when you need it: references/apps/build.md (folder and manifest), references/apps/connection-actions.md, references/apps/data-store-actions.md and references/apps/workflow-actions.md (one per kind of action), references/apps/examples.md (whole Apps), references/apps/troubleshooting.md (a failed save or call).",
      "Returns the revision shown with the name the folder gives itself (its app.yaml name or its HTML title), or the build errors with file and line. Fix the files and open them again; a failed build shows nothing new."
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
