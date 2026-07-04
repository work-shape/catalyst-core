import { createHash } from "node:crypto";
import { z } from "zod";
import { createPlatformId, type JsonObject } from "@vivd-catalyst/core";
import {
  defineConfiguredTool,
  defineTool,
  toolSuccess,
  type AnyToolDefinition,
  type ToolAssemblyDefinition
} from "@vivd-catalyst/tool-sdk";

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
const visualizationThemeHelperScript = `(()=>{function color(name,fallback){const key=name.startsWith("--")?name:"--"+name;const value=getComputedStyle(document.documentElement).getPropertyValue(key).trim();return value||fallback||""}function chartColors(){return{background:color("background"),foreground:color("foreground"),card:color("card"),cardForeground:color("card-foreground"),mutedForeground:color("muted-foreground"),border:color("border"),primary:color("primary"),accent:color("accent"),destructive:color("destructive")}}window.vivdCatalystTheme={color,chartColors}})();`;
const defaultVisualizationScriptSources = ["https://cdn.tailwindcss.com", "https://unpkg.com"];
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

const showViewScriptSourceSchema = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    if (!normalizeVisualizationScriptSource(value)) {
      context.addIssue({
        code: "custom",
        message:
          'Script sources must be "*" for all HTTPS scripts, or HTTPS origins/paths without credentials, query strings, fragments, whitespace, quotes, semicolons, or wildcards.'
      });
    }
  })
  .transform((value) => normalizeVisualizationScriptSource(value) ?? value);

const showViewConfigSchema = z.object({
  allowedScriptSrc: z.array(showViewScriptSourceSchema).default(["*"])
});

export type ShowViewToolConfig = z.infer<typeof showViewConfigSchema>;

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

export function createBuiltInToolDefinitions(): ToolAssemblyDefinition[] {
  return [showViewToolDefinition];
}

export const showViewToolDefinition = defineConfiguredTool({
  name: "show_view",
  configSchema: showViewConfigSchema,
  create(config) {
    return createShowViewTool(config);
  }
});

export const showViewTool = createShowViewTool();

export function createShowViewTool(config: ShowViewToolConfig = showViewConfigSchema.parse({})): AnyToolDefinition {
  const parsedConfig = showViewConfigSchema.parse(config);
  const allowedScriptSrc = uniqueScriptSources(parsedConfig.allowedScriptSrc);
  const scriptSourceHint = externalScriptSourceHint(allowedScriptSrc);
  return defineTool({
    name: "show_view",
    description: [
      "Show model-authored HTML to the user as a visual view. Use this when a table, widget, chart, dashboard, or richer visual explanation would help.",
      "Tailwind CSS, Lucide icons, Chart.js-compatible inline scripts, and shadcn-style app theme classes are available in the rendered iframe.",
      "Use theme classes and CSS variables for the whole view: bg-background text-foreground, bg-card text-card-foreground border-border, text-muted-foreground, bg-primary text-primary-foreground, or var(--card) / var(--foreground).",
      "Do not hard-code page/card/text colors such as bg-white, text-gray/text-slate, #fff, #ffffff, #111827, fixed dark backgrounds, or !important color overrides unless a color is genuinely data-semantic.",
      "For canvas or Chart.js charts, read colors from window.vivdCatalystTheme.chartColors() or window.vivdCatalystTheme.color('foreground') and set chart text, grid, and border colors from those values.",
      scriptSourceHint
    ].join(" "),
    inputSchema: showViewInputSchema,
    outputSchema: showViewOutputSchema,
    inputJsonSchema: createShowViewInputJsonSchema(scriptSourceHint),
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
            html: prepareVisualizationHtml(input.html, { allowedScriptSrc }),
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

function createShowViewInputJsonSchema(scriptSourceHint: string): JsonObject {
  return {
    type: "object",
    additionalProperties: false,
    required: ["html"],
    properties: {
      html: {
        type: "string",
        minLength: 1,
        maxLength: 200000,
        description:
          `Complete standalone HTML fragment or document to render for the user. Use Tailwind utility classes with shadcn-style theme classes such as bg-background, bg-card, text-foreground, text-muted-foreground, border-border, bg-primary, and text-primary-foreground. Do not hard-code white cards, gray/slate text, fixed dark backgrounds, or !important color overrides. Chart/canvas colors should come from window.vivdCatalystTheme.chartColors() or CSS variables such as var(--foreground), var(--border), and var(--primary). Lucide icons are available with elements such as <i data-lucide="chart-column"></i>. ${scriptSourceHint}`
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
  };
}

export function prepareVisualizationHtml(html: string, config: ShowViewToolConfig = showViewConfigSchema.parse({})): string {
  const parsedConfig = showViewConfigSchema.parse(config);
  const sanitizedHtml = stripVisualizationContentSecurityPolicyMeta(html);
  const visualizationRuntimeHead = createVisualizationRuntimeHead(parsedConfig, collectInlineScriptHashSources(sanitizedHtml));
  if (/<html(?:\s|>)/iu.test(sanitizedHtml)) {
    if (/<head(?:\s|>)/iu.test(sanitizedHtml)) {
      return sanitizedHtml.replace(/<head([^>]*)>/iu, `<head$1>\n${visualizationRuntimeHead}`);
    }
    return sanitizedHtml.replace(/<html([^>]*)>/iu, `<html$1><head>${visualizationRuntimeHead}</head>`);
  }
  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    visualizationRuntimeHead,
    "</head>",
    '<body class="bg-background text-foreground antialiased">',
    sanitizedHtml,
    "</body>",
    "</html>"
  ].join("\n");
}

function createVisualizationRuntimeHead(config: ShowViewToolConfig, inlineScriptHashSources: string[]): string {
  return [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${createVisualizationContentSecurityPolicy(config, inlineScriptHashSources)}">`,
    visualizationDefaultThemeStyle,
    '<script src="https://cdn.tailwindcss.com"></script>',
    `<script>${tailwindThemeBootstrapScript}</script>`,
    '<script src="https://unpkg.com/lucide@latest/dist/umd/lucide.min.js"></script>',
    `<script>${lucideBootstrapScript}</script>`,
    `<script>${visualizationThemeHelperScript}</script>`,
    `<script>${displayHeightBootstrapScript}</script>`
  ].join("\n");
}

function createVisualizationContentSecurityPolicy(config: ShowViewToolConfig, inlineScriptHashSources: string[]): string {
  const scriptSources = uniqueScriptSources([...defaultVisualizationScriptSources, ...config.allowedScriptSrc]);
  const scriptHashes = uniqueScriptHashes([
    scriptHashSource(tailwindThemeBootstrapScript),
    scriptHashSource(lucideBootstrapScript),
    scriptHashSource(visualizationThemeHelperScript),
    scriptHashSource(displayHeightBootstrapScript),
    ...inlineScriptHashSources
  ]);
  return [
    "default-src 'none'",
    `script-src ${scriptSources.join(" ")} 'unsafe-eval' ${scriptHashes.join(" ")}`,
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join("; ");
}

function uniqueScriptSources(sources: string[]): string[] {
  return Array.from(new Set(sources.map((source) => normalizeVisualizationScriptSource(source)).filter(isString)));
}

function uniqueScriptHashes(sources: string[]): string[] {
  return Array.from(new Set(sources));
}

function externalScriptSourceHint(allowedScriptSrc: string[]): string {
  if (allowedScriptSrc.length === 0) {
    return "No additional charting CDNs are configured; for charts, use inline SVG, CSS, or canvas without external libraries.";
  }

  if (allowedScriptSrc.includes("https:")) {
    return "External HTTPS script sources are configured. Network fetches and external images remain blocked.";
  }

  return `Additional configured script sources are available: ${allowedScriptSrc.join(", ")}. Network fetches and external images remain blocked.`;
}

function normalizeVisualizationScriptSource(value: string): string | undefined {
  const trimmedValue = value.trim();
  if (trimmedValue === "*" || trimmedValue === "https:") {
    return "https:";
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return undefined;
  }

  const source = url.pathname === "/" ? url.origin : `${url.origin}${url.pathname}`;
  return /[\s"'`;*<>{}]/u.test(source) ? undefined : source;
}

function isString(value: string | undefined): value is string {
  return typeof value === "string";
}

function stripVisualizationContentSecurityPolicyMeta(html: string): string {
  return html.replace(
    /<meta\b(?=[^>]*\bhttp-equiv\s*=\s*(?:"content-security-policy"|'content-security-policy'|content-security-policy))[^>]*>/giu,
    ""
  );
}

function collectInlineScriptHashSources(html: string): string[] {
  const hashes: string[] = [];
  const scriptPattern = /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/giu;
  let match: RegExpExecArray | null;
  while ((match = scriptPattern.exec(html)) !== null) {
    const source = match[1] ?? "";
    if (source.trim()) {
      hashes.push(scriptHashSource(source));
    }
  }
  return uniqueScriptHashes(hashes);
}

function scriptHashSource(source: string): string {
  return `'sha256-${createHash("sha256").update(source).digest("base64")}'`;
}
