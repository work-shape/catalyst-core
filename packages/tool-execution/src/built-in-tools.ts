import { z } from "zod";
import { createPlatformId } from "@vivd-catalyst/core";
import {
  defineTool,
  toolSuccess,
  type AnyToolDefinition,
  type ToolAssemblyDefinition
} from "@vivd-catalyst/tool-sdk";

/** The part of the instance's `views` config the tool tells the agent about. */
export interface ShowViewPolicy {
  /** Script hosts a view may load from besides the instance's own view runtime. */
  allowedScriptSrc: readonly string[];
}

const showViewColorGuidance =
  "Use theme tokens for structure/layout: bg-background text-foreground, bg-card text-card-foreground border-border, text-muted-foreground, bg-primary text-primary-foreground. Use semantic tokens for status/severity/priority: text-success, text-warning, text-destructive, text-info, including translucent fills/borders like bg-success/10 border-success/30. Example: <span class=\"rounded-md border border-warning/30 bg-warning/10 px-2 py-1 text-warning\">needs review</span>. Do not make the view monochrome when status, severity, or priority matters. Never use color as the only signal -- pair it with labels or icons. Do not hard-code surfaces/text with bg-white, text-gray-*/text-slate-*, #fff, #ffffff, #111827, fixed dark backgrounds, or !important color overrides. For categorical or series data, use the ordered palette window.vivdCatalystTheme.chartPalette() (an array) or Tailwind classes text-chart-1 through text-chart-5 / bg-chart-2/20; window.vivdCatalystTheme.chartColors() returns a named object of theme colors, so never index it like an array. For canvas or Chart.js charts, read colors from window.vivdCatalystTheme.chartColors() (includes success, warning, info) or window.vivdCatalystTheme.color('foreground') for text, grid, and borders.";

const showViewLayoutGuidance =
  "The view is embedded flush in the chat, so it must not frame itself: its content must touch the left and right edges of the view. Put no padding or margin (p-*/px-*/py-*/m-*, including responsive variants such as md:p-6) on the outermost element, on any wrapper around the whole view, or on top-level sections and grids; no max-width wrapper, no centering container, and no heading that repeats the title. Only bordered cards carry their own inner padding; separate top-level blocks with gap-* or space-y-*. Start directly with the content and let it span the full width. The view grows to its full content height and never scrolls inside itself, so do not set h-screen, min-h-screen, fixed heights, or overflow-y-auto on the outermost element.";

function createShowViewInputSchema(scriptSourceHint: string) {
  return z.object({
    html: z
      .string()
      .min(1)
      .max(200_000)
      .describe(
        `Complete standalone HTML fragment or document to render for the user. ${showViewLayoutGuidance} ${showViewColorGuidance} Lucide icons are available with elements such as <i data-lucide="chart-column"></i>. ${scriptSourceHint}`
      ),
    mode: z
      .enum(["inline", "side_panel", "fullscreen"])
      .default("inline")
      .describe(
        "How prominently the user interface should render the HTML. Use side_panel when the user should keep chatting while the view opens in the right preview panel."
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

export function createBuiltInToolDefinitions(
  views: ShowViewPolicy = { allowedScriptSrc: [] }
): ToolAssemblyDefinition[] {
  return [createShowViewTool(views)];
}

export const showViewTool = createShowViewTool();

export function createShowViewTool(
  views: ShowViewPolicy = { allowedScriptSrc: [] }
): AnyToolDefinition {
  const scriptSourceHint = viewScriptSourceHint(views.allowedScriptSrc);
  const inputSchema = createShowViewInputSchema(scriptSourceHint);
  return defineTool({
    name: "show_view",
    description: [
      "Show model-authored HTML to the user as a visual view. Use this when a table, widget, chart, dashboard, or richer visual explanation would help.",
      "Tailwind CSS, Lucide icons, Chart.js-compatible inline scripts, and shadcn-style app theme classes are available in the rendered iframe.",
      showViewLayoutGuidance,
      showViewColorGuidance,
      scriptSourceHint
    ].join(" "),
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
