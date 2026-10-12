import { z } from "zod";
import { createPlatformId } from "@vivd-catalyst/core";
import {
  defineTool,
  toolSuccess,
  type AnyToolDefinition,
  type ToolAssemblyDefinition
} from "@vivd-catalyst/tool-sdk";
import { createPageSaveTool, type PageSaveToolOptions } from "./page-save-tool";

/** The part of the instance's `views` config the tool tells the agent about. */
export interface ShowViewPolicy {
  /** Script hosts a view may load from besides the instance's own view runtime. */
  allowedScriptSrc: readonly string[];
}

/**
 * The layout and colour rules of a view. They are sent once, in the tool description; the
 * `html` parameter points there instead of repeating them.
 */
const showViewLayoutGuidance =
  "Layout: the view is embedded flush in the chat and must not frame itself; its content touches the left and right edges. Put no padding or margin (p-*/px-*/py-*/m-*, including responsive variants such as md:p-6) on the outermost element, on a wrapper around the whole view, or on top-level sections and grids. Start directly with the content: no introductory heading or preamble, no heading that repeats the title, and no max-width or centering container. Only bordered cards carry inner padding; separate top-level blocks with gap-* or space-y-*. The view grows to its content height and never scrolls inside itself: set no h-screen, min-h-screen, fixed height, or overflow-y-auto on the outermost element.";

const showViewColorGuidance =
  "Color: the app's shadcn-style theme classes are available. Use theme tokens for structure: bg-background text-foreground, bg-card text-card-foreground border-border, text-muted-foreground, bg-primary text-primary-foreground. Use semantic tokens for status, severity, and priority: text-success, text-warning, text-destructive, text-info, with translucent fills and borders such as bg-success/10 border-success/30. Example: <span class=\"rounded-md border border-warning/30 bg-warning/10 px-2 py-1 text-warning\">needs review</span>. Do not make the view monochrome when status, severity, or priority matters. Never use color as the only signal: pair it with a label or an icon. Do not hard-code surface or text colors: no bg-white, text-gray-*/text-slate-*, hex values such as #fff or #111827, fixed dark backgrounds, or !important color overrides. For categorical or series data use window.vivdCatalystTheme.chartPalette() (an ordered array) or the classes text-chart-1 through text-chart-5 and fills such as bg-chart-2/20. window.vivdCatalystTheme.chartColors() returns a named object of theme colors (includes success, warning, info), so never index it like an array; canvas and Chart.js charts read it, or window.vivdCatalystTheme.color('foreground'), for text, grid, and borders.";

const showViewIconGuidance =
  'Icons: Lucide icons render from elements such as <i data-lucide="chart-column"></i>.';

function createShowViewInputSchema() {
  return z.object({
    html: z
      .string()
      .min(1)
      .max(200_000)
      .describe(
        "Complete standalone HTML fragment or document to render for the user. Follow the layout, color, icon, and script rules in the tool description."
      ),
    mode: z
      .enum(["inline", "side_panel", "fullscreen"])
      .default("inline")
      .describe(
        "Where the widget renders. Keep inline, the default, so it sits inside your answer."
      ),
    title: z
      .string()
      .min(1)
      .max(160)
      .describe("Optional short title for the rendered display.")
      .optional()
  });
}

const showViewOutputSchema = z.object({
  displayed: z.literal(true),
  displayId: z.string(),
  mode: z.enum(["inline", "side_panel", "fullscreen"])
});

/** What the built-in tools of a module need. A module whose entry is missing adds no tool. */
export interface BuiltInModuleTools {
  /** The `apps` module: saving a Page. */
  apps?: PageSaveToolOptions;
}

export function createBuiltInToolDefinitions(
  views: ShowViewPolicy = { allowedScriptSrc: [] },
  modules: BuiltInModuleTools = {}
): ToolAssemblyDefinition[] {
  return [createShowViewTool(views), ...(modules.apps ? [createPageSaveTool(modules.apps)] : [])];
}

export const showViewTool = createShowViewTool();

export function createShowViewTool(
  views: ShowViewPolicy = { allowedScriptSrc: [] }
): AnyToolDefinition {
  const inputSchema = createShowViewInputSchema();
  return defineTool({
    name: "show_view",
    effect: "reading",
    description: [
      "Show a small HTML widget inline in your answer: a table, chart, or compact visual that belongs to this one reply. For a standalone visualization, dashboard, or tool, save a Page with page.save instead when you have that tool.",
      showViewLayoutGuidance,
      showViewColorGuidance,
      showViewIconGuidance,
      `Scripts: ${viewScriptSourceHint(views.allowedScriptSrc)}`
    ].join("\n\n"),
    inputSchema,
    outputSchema: showViewOutputSchema,
    async execute(input) {
      const displayId = createPlatformId<"ToolDisplayId">("display");
      const output = {
        displayed: true as const,
        displayId,
        mode: input.mode
      };
      return toolSuccess(output, {
        // Version 2 stores the model's HTML alone. The interface composes the head, the
        // content policy and the runtime each time the view is shown.
        display: {
          kind: "html.rendered",
          version: 2,
          mode: input.mode,
          displayId,
          ...(input.title ? { title: input.title } : {}),
          data: {
            html: prepareVisualizationHtml(input.html),
            ...(input.title ? { title: input.title } : {})
          }
        },
        auditSummary: {
          action: "show_view",
          subject: displayId,
          metadata: {
            mode: input.mode,
            htmlLength: input.html.length
          }
        }
      });
    }
  });
}

/**
 * What a tool stores of the HTML a model wrote for a view: the HTML without any content
 * policy of its own. The policy that holds is the one the interface composes when it shows
 * the view.
 */
export function prepareVisualizationHtml(html: string): string {
  return html.replace(
    /<meta\b(?=[^>]*\bhttp-equiv\s*=\s*(?:"content-security-policy"|'content-security-policy'|content-security-policy))[^>]*>/giu,
    ""
  );
}

function viewScriptSourceHint(allowedScriptSrc: readonly string[]): string {
  const provided =
    "Tailwind CSS and Lucide are loaded from the instance; do not add script tags for them.";
  const blocked = "Network fetches and external images are blocked.";
  if (allowedScriptSrc.length === 0) {
    return `${provided} No other script file can be loaded: for charts, use inline SVG, CSS, or canvas drawn by an inline script, without external libraries. ${blocked}`;
  }
  if (allowedScriptSrc.includes("https:")) {
    return `${provided} Other script files can be loaded from any HTTPS host. ${blocked}`;
  }
  return `${provided} Other script files can be loaded only from: ${allowedScriptSrc.join(", ")}. ${blocked}`;
}
