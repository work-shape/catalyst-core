import { createHash } from "node:crypto";
import { z } from "zod";
import { createPlatformId } from "@vivd-catalyst/core";
import { defineTool, toolSuccess, type AnyToolDefinition } from "@vivd-catalyst/tool-sdk";

const visualizationThemeColorNames = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "border",
  "input",
  "ring",
  "sidebar",
  "sidebar-foreground",
  "sidebar-primary",
  "sidebar-primary-foreground",
  "sidebar-accent",
  "sidebar-accent-foreground",
  "sidebar-border",
  "sidebar-ring"
] as const;
const lucideBootstrapScript =
  'document.addEventListener("DOMContentLoaded",function(){if(window.lucide){window.lucide.createIcons();}});';
const tailwindThemeBootstrapScript = [
  "function vcThemeColor(name){return function({opacityValue}){if(opacityValue===undefined){return `var(${name})`}const value=Number(opacityValue);return Number.isFinite(value)?`color-mix(in srgb, var(${name}) ${value*100}%, transparent)`:`var(${name})`}}",
  `const vcThemeColorNames=${JSON.stringify(visualizationThemeColorNames)};`,
  'const vcThemeColors=Object.fromEntries(vcThemeColorNames.map((name)=>[name,vcThemeColor("--"+name)]));',
  'tailwind.config={theme:{extend:{colors:vcThemeColors,borderRadius:{lg:"var(--radius)",md:"calc(var(--radius) - 2px)",sm:"calc(var(--radius) - 4px)"}}}};'
].join("");
const displayHeightBootstrapScript = `(()=>{const t="vivd-catalyst:display-height";let e=0;function n(){const t=document.documentElement,n=document.body;return Math.ceil(Math.max(t?.scrollHeight??0,t?.offsetHeight??0,n?.scrollHeight??0,n?.offsetHeight??0))}function o(){const o=n();o>0&&Math.abs(o-e)>1&&(e=o,parent.postMessage({type:t,height:o},"*"))}document.addEventListener("DOMContentLoaded",()=>{o();if("ResizeObserver"in window&&document.body){window.__vivdCatalystResizeObserver=new ResizeObserver(o);window.__vivdCatalystResizeObserver.observe(document.body)}setTimeout(o,50);setTimeout(o,250);setTimeout(o,1000)});window.addEventListener("load",o)})();`;
const visualizationDefaultThemeStyle = `<style id="vivd-catalyst-default-theme">
:root {
  --radius: 0.5rem;
  --background: #fffdfa;
  --foreground: #17201d;
  --card: #fffdfa;
  --card-foreground: #17201d;
  --popover: #fffdfa;
  --popover-foreground: #17201d;
  --primary: #0f766e;
  --primary-foreground: #ffffff;
  --secondary: #ebe7dc;
  --secondary-foreground: #17201d;
  --muted: #ebe7dc;
  --muted-foreground: #68746f;
  --accent: #e5f3ef;
  --accent-foreground: #0b5f59;
  --destructive: #b42318;
  --border: #d8d3c7;
  --input: #d8d3c7;
  --ring: #0f766e;
  --sidebar: #f4f1e8;
  --sidebar-foreground: #17201d;
  --sidebar-primary: #0f766e;
  --sidebar-primary-foreground: #ffffff;
  --sidebar-accent: #e5f3ef;
  --sidebar-accent-foreground: #0b5f59;
  --sidebar-border: #d8d3c7;
  --sidebar-ring: #0f766e;
}
html,
body {
  min-height: 100%;
  background: var(--background);
  color: var(--foreground);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
body {
  margin: 0;
}
*,
::before,
::after {
  border-color: var(--border);
}
</style>`;
const visualizationContentSecurityPolicy = [
  "default-src 'none'",
  `script-src https://cdn.tailwindcss.com https://unpkg.com 'unsafe-eval' ${scriptHashSource(tailwindThemeBootstrapScript)} ${scriptHashSource(lucideBootstrapScript)} ${scriptHashSource(displayHeightBootstrapScript)}`,
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join("; ");
const visualizationRuntimeHead = [
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  `<meta http-equiv="Content-Security-Policy" content="${visualizationContentSecurityPolicy}">`,
  visualizationDefaultThemeStyle,
  '<script src="https://cdn.tailwindcss.com"></script>',
  `<script>${tailwindThemeBootstrapScript}</script>`,
  '<script src="https://unpkg.com/lucide@latest/dist/umd/lucide.min.js"></script>',
  `<script>${lucideBootstrapScript}</script>`,
  `<script>${displayHeightBootstrapScript}</script>`
].join("\n");

const showViewInputSchema = z.object({
  html: z.string().min(1).max(200_000),
  mode: z.enum(["inline", "side_panel", "fullscreen"]).default("inline"),
  title: z.string().min(1).max(160).optional()
});

const showViewOutputSchema = z.object({
  displayed: z.literal(true),
  displayId: z.string(),
  mode: z.enum(["inline", "side_panel", "fullscreen"])
});

export function createBuiltInToolDefinitions(): AnyToolDefinition[] {
  return [showViewTool];
}

export const showViewTool = defineTool({
  name: "show_view",
  description:
    "Show model-authored HTML to the user as a visual view. Use this when a table, widget, chart, dashboard, or richer visual explanation would help. Tailwind CSS, Lucide icons, and shadcn-style app theme classes are available in the rendered iframe. Prefer theme classes such as bg-background text-foreground, bg-card border-border, text-muted-foreground, and bg-primary text-primary-foreground over hard-coded color palettes.",
  inputSchema: showViewInputSchema,
  outputSchema: showViewOutputSchema,
  inputJsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["html"],
    properties: {
      html: {
        type: "string",
        minLength: 1,
        maxLength: 200000,
        description:
          'Complete standalone HTML fragment or document to render for the user. Use Tailwind utility classes with shadcn-style theme classes such as bg-background, bg-card, text-foreground, text-muted-foreground, border-border, bg-primary, and text-primary-foreground. Lucide icons are available with elements such as <i data-lucide="chart-column"></i>.'
      },
      mode: {
        type: "string",
        enum: ["inline", "side_panel", "fullscreen"],
        default: "inline",
        description:
          "How prominently the user interface should render the HTML. Use side_panel when the user should keep chatting while the view opens in the right preview panel."
      },
      title: {
        type: "string",
        minLength: 1,
        maxLength: 160,
        description: "Optional short title for the rendered display."
      }
    }
  },
  async execute(input) {
    const displayId = createPlatformId<"ToolDisplayId">("display");
    const output = {
      displayed: true as const,
      displayId,
      mode: input.mode
    };
    return toolSuccess(output, {
      display: {
        kind: "html.rendered",
        version: 1,
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

export function prepareVisualizationHtml(html: string): string {
  if (/<html(?:\s|>)/iu.test(html)) {
    if (/<\/head>/iu.test(html)) {
      return html.replace(/<\/head>/iu, `${visualizationRuntimeHead}\n</head>`);
    }
    return html.replace(/<html([^>]*)>/iu, `<html$1><head>${visualizationRuntimeHead}</head>`);
  }
  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    visualizationRuntimeHead,
    "</head>",
    '<body class="bg-background text-foreground antialiased">',
    html,
    "</body>",
    "</html>"
  ].join("\n");
}

function scriptHashSource(source: string): string {
  return `'sha256-${createHash("sha256").update(source).digest("base64")}'`;
}
