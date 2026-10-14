import { z } from "zod";
import {
  asUserId,
  getRuntimeSubjectUserId,
  isAppError,
  normalizePageName,
  PAGE_NAME_MAX_CHARS,
  requireFileSetWithinLimits,
  type ConversationId,
  type PageBuildClient,
  type PageBuildIssue,
  type ToolExecutionContext,
  type ToolHandlerResult
} from "@vivd-catalyst/core";
import { defineTool, toolSuccess, type AnyToolDefinition } from "@vivd-catalyst/tool-sdk";
import type { PageAppCalls } from "./page-app-tool";
import { failed, normalizeWorkspaceDirectory } from "./workspace-tool-results";
import type { WorkspaceToolDependencies } from "./workspace-tools/dependencies";
import { resolveWorkspaceHandle } from "./workspace-tools/workspace";

// Saving a Page: the folder an agent wrote with its file tools becomes a revision. The tool
// takes the folder as it is now, by the objects its files are stored in, and hands that
// snapshot to the build. It reads no file itself and runs none.

export const PAGE_SAVE_TOOL_NAME = "page.save";
/** The manifest every Page has. A folder without it is refused before a build is queued. */
const PAGE_MANIFEST_FILE = "app.yaml";

export interface PageSaveToolOptions {
  /** What the workspace tools of the instance work with: the same workspace, the same limits. */
  workspace: WorkspaceToolDependencies;
  builds: PageBuildClient;
  /**
   * Where a save also writes the App the conversation is about, when that App's draft is the
   * Page's, and what an administrator set for that write. Without it a save writes the Page
   * alone.
   */
  apps?: Pick<PageAppCalls, "saveIntoSubjectApp" | "pageAppPolicyFloor">;
}

const pageSaveInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(PAGE_NAME_MAX_CHARS)
    .describe(
      "The name of the Page in this conversation. Saving under the name of an existing Page adds a revision to it; a new name is a new Page."
    ),
  directory: z
    .string()
    .min(1)
    .describe(
      "The folder of the execution workspace that holds the Page, with app.yaml directly inside it."
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

const pageSaveIntoAppSchema = z.union([
  z.object({
    name: z.string(),
    title: z.string(),
    saved: z.literal(true),
    revision: z.number().int(),
    warnings: z.array(z.string()).optional()
  }),
  z.object({ name: z.string(), title: z.string(), saved: z.literal(false), message: z.string() })
]);

const pageSaveOutputSchema = z.union([
  z.object({
    pageId: z.string(),
    number: z.number().int(),
    fileSetId: z.string(),
    app: pageSaveIntoAppSchema.optional()
  }),
  z.object({ errors: z.array(pageBuildIssueSchema) })
]);

type PageSaveOutput = z.infer<typeof pageSaveOutputSchema>;

export function createPageSaveTool(options: PageSaveToolOptions): AnyToolDefinition {
  const { apps } = options;
  return defineTool({
    name: PAGE_SAVE_TOOL_NAME,
    // A saved revision outlives the call and shows beside the conversation.
    effect: "changing",
    description: [
      "A Page is the way to show a standalone HTML visualization, dashboard or tool beside the conversation. When the person asks for an app, a dashboard or a tool, build a Page; never hand over a loose HTML file instead. Hard-coded data is fine for a quick one, and live data through actions is for when the person asks to keep it as an App, which page.save_as_app makes of the Page.",
      "Save a folder of the execution workspace as a revision of a Page and build it. The Page then shows beside the conversation.",
      "The folder holds app.yaml (id, name, kit: an exact kit version, which is 1.3.0 for a new Page, optional entry) and the Page's files.",
      "A React Page has its routes under src/routes/ (TanStack Router file routes, src/routes/__root.tsx and src/routes/index.tsx) and imports only its own files, react, react-dom, @tanstack/react-router and @work-shape/catalyst-app-kit; nothing is installed.",
      "A Page that reads from a Connection names kit 1.1.0 or later, lists the Connection under 'connections' in app.yaml and has one file actions/<name>.action.yaml per call (connection, operation, effect: reading or changing, optional input with a JSON 'schema' of the parameters and a 'mapping' whose \"{{parameter}}\" values stand for them). Its code calls actions.call(name, params) from the kit and gets { runId, status, result }; the call runs with the rights of whoever looks at the Page. A changing action is carried out only once the Page is published as an App. A call that is refused or fails rejects with an AppCallError: show its message as it is, since it is the platform's sentence in the viewer's language, and offer no button to try again when its retryable is false.",
      "A Page that starts a Workflow names kit 1.3.0 or later and has one file actions/<name>.action.yaml with 'workflow: <Workflow id>' in place of connection, operation and effect, and an optional input whose 'mapping' makes the input the Workflow declares from the parameters of the 'schema'. The call starts the published Workflow as whoever looks at the Page, who needs the right to use that Workflow, and answers { runId, status, result } with the Workflow Run in result: pass result.id to useWorkflowRun from the kit, which reads the run's status, output and error every second until it is over, or in a plain HTML Page call workflowRuns.get(result.id). In a draft or a Page nothing is started: the call answers { status: 'dry_run', message, result } with the platform's sentence of what it would have started with which input; show the message as it is.",
      "A plain HTML Page names 'entry: index.html'; inline scripts and styles are allowed, inline event handler attributes such as onclick are not: add listeners in a script.",
      "With kit 1.2.0 or later a plain HTML Page is given the look of the platform without asking for it, also when its script imports the kit to call an action: room around the body, the font and type sizes, the colours of the interface in light and dark, and styles for headings, text, links, lists, code, tables, buttons and form fields. Write plain elements and set no page margin, font or colour unless the Page needs a look of its own. The Page's class names are its own: the platform's stylesheet for a plain Page defines no class. A rule of the Page's own wins when it stands outside any @layer or in a layer the Page names itself; do not write the Page's rules into @layer base or @layer components. A Page that sets a background sets the text colour with it. For a colour use the custom properties --background, --foreground, --muted, --muted-foreground, --border, --primary and --accent-foreground, which follow light and dark; a fixed colour does not. Which stylesheet an HTML file gets is decided per file by what its scripts import: a file with a script that imports react, react/jsx-runtime, react-dom, react-dom/client, @work-shape/catalyst-app-kit/ui, @work-shape/catalyst-app-kit/router or @tanstack/react-router gets the kit's component stylesheet and none of these styles for plain elements, so build such a Page as a React Page unless it must be HTML; every other HTML file gets the styles for plain elements, also one whose script imports @work-shape/catalyst-app-kit for actions or the context, or drawChart from @work-shape/catalyst-app-kit/charts.",
      "Returns the Page and its revision number, or the build errors with file and line. Fix the files and save again; a failed build stores nothing.",
      "Where the Page became an App in this conversation (page.save_as_app), the save also writes the App's draft and answers it under 'app'; nothing is published. Tell the person each of the app's 'warnings', as it says."
    ].join(" "),
    inputSchema: pageSaveInputSchema,
    outputSchema: pageSaveOutputSchema,
    // Runs on the agent's own call, like the workspace tools that wrote the folder. Without a
    // mode the instance default for changes would apply.
    permission: { mode: "allow" },
    // In a conversation about an App the save writes that App's draft: a setting on the
    // operations that write it holds for the save too.
    ...(apps
      ? {
          policyFloor: ({ conversationId }: { conversationId: ConversationId }) =>
            apps.pageAppPolicyFloor(conversationId, "draft")
        }
      : {}),
    execute(input, context) {
      return savePage(options, input, context);
    }
  });
}

async function savePage(
  options: PageSaveToolOptions,
  input: z.infer<typeof pageSaveInputSchema>,
  context: ToolExecutionContext
): Promise<ToolHandlerResult<PageSaveOutput>> {
  const { workspace: deps } = options;
  const directory = normalizeWorkspaceDirectory(input.directory, deps.limits);
  if (directory.status === "failed") {
    return directory.result;
  }
  let pageName: string;
  try {
    pageName = normalizePageName(input.name);
  } catch (error) {
    return failed("validation_failed", isAppError(error) ? error.message : "The name is invalid");
  }
  const workspace = await resolveWorkspaceHandle(deps, context);
  if (workspace.status === "failed") {
    return workspace.result;
  }
  const prefix = directory.value === "." ? "" : `${directory.value}/`;
  const files = (
    await deps.store.executionWorkspaces.listWorkspaceFiles({
      clientInstanceId: context.clientInstanceId,
      workspaceId: workspace.value.handle.id
    })
  )
    .filter((file) => file.path.startsWith(prefix))
    .map((file) => ({
      path: file.path.slice(prefix.length),
      objectKey: file.objectKey,
      byteSize: file.byteSize,
      checksum: file.checksum
    }));
  const refuse = (errors: PageBuildIssue[]) =>
    toolSuccess<PageSaveOutput>(
      { errors },
      {
        auditSummary: {
          action: PAGE_SAVE_TOOL_NAME,
          subject: workspace.value.handle.id,
          metadata: { saved: false, errorCount: errors.length }
        }
      }
    );
  if (!files.some((file) => file.path === PAGE_MANIFEST_FILE)) {
    return refuse([
      {
        file: PAGE_MANIFEST_FILE,
        code: "manifest_invalid",
        message: `The folder '${input.directory}' has no app.yaml. A Page's folder holds its manifest directly inside it${files.length === 0 ? "; the folder holds no file at all" : ""}.`
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
        file: typeof details.file === "string" ? details.file : PAGE_MANIFEST_FILE,
        message: error.message,
        ...(typeof details.reason === "string" ? { code: details.reason } : {})
      }
    ]);
  }
  const outcome = await options.builds.build({
    clientInstanceId: context.clientInstanceId,
    conversationId: workspace.value.conversationId,
    request: {
      pageName,
      directory: directory.value,
      files,
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
  // Once the Page is the App of this conversation, the save is the App's next draft.
  const app = await options.apps?.saveIntoSubjectApp(context, {
    pageId: outcome.pageId,
    fileSetId: outcome.fileSetId
  });
  return toolSuccess<PageSaveOutput>(
    {
      pageId: outcome.pageId,
      number: outcome.number,
      fileSetId: outcome.fileSetId,
      ...(app === undefined ? {} : { app })
    },
    {
      auditSummary: {
        action: PAGE_SAVE_TOOL_NAME,
        subject: outcome.pageId,
        metadata: {
          saved: true,
          fileSetId: outcome.fileSetId,
          number: outcome.number,
          sourceFileCount: files.length,
          ...(app?.saved === true ? { app: app.name, appRevision: app.revision } : {})
        }
      }
    }
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
