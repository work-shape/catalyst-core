import {
  apiOperations,
  VIEW_RUNTIME,
  VIEW_SHELL,
  VIEW_SHELL_MESSAGES
} from "@vivd-catalyst/api-client";
import { createThemeTokens, DEFAULT_THEME_INPUTS } from "@vivd-catalyst/ui/theme";
import { sha256Base64 } from "./sha256";
import { writeStaticViewBody } from "./static-view-html";

// The document a generated view runs in. A stored view is the model's HTML and nothing else;
// its head, with the content policy, the default theme, the view runtime and the bootstrap
// scripts, is composed here each time the view is shown. A view saved under an earlier policy
// is therefore shown under the instance's policy of today.

/** A private-data view holds query results the model never saw and runs no library at all. */
export type ViewDisplayKind = "html.rendered" | "private_hydrated_view";

/**
 * Whether a view that holds private rows runs scripts. It does not, because a script can send
 * packets to any host over WebRTC and no browser lets a document forbid that. Without scripts
 * such a view is static: its body is written anew from an allowlist of elements and
 * attributes (`static-view-html.ts`), and the frame keeps a fixed height and scrolls, since
 * nothing in it can report its height. Set to true, these views run their inline scripts
 * again and their stored HTML is shown as it is. The tool that makes such views then has to
 * stop escaping the rows it places.
 */
const PRIVATE_ROW_VIEWS_RUN_SCRIPTS: boolean = false;

export function viewRunsScripts(kind: ViewDisplayKind): boolean {
  return kind === "html.rendered" || PRIVATE_ROW_VIEWS_RUN_SCRIPTS;
}

export interface ViewRuntimeAddress {
  /** The one directory a view may load scripts from on the instance. Ends with a slash. */
  directoryUrl: string;
  tailwindUrl: string;
  lucideUrl: string;
}

export interface ViewDocumentInput {
  /** The stored HTML of the view: a fragment or a whole document. */
  html: string;
  kind: ViewDisplayKind;
  runtime: ViewRuntimeAddress;
  /** `views.allowedScriptSrc` of the instance: script hosts besides the instance itself. */
  allowedScriptSrc: readonly string[];
}

/**
 * Where the instance serves the view runtime, as absolute addresses. The frame of a view has
 * no address of its own, so a relative one would not resolve. `apiBaseUrl` is the address the
 * interface already calls: empty or a path when both share an origin, an origin otherwise.
 */
export function viewRuntimeAddress(apiBaseUrl: string, pageUrl: string): ViewRuntimeAddress {
  const fileUrl = (file: string) =>
    new URL(
      `${apiBaseUrl.replace(/\/$/u, "")}${apiOperations["view_runtime.files.get"].buildPath({
        params: { version: VIEW_RUNTIME.version, file }
      })}`,
      pageUrl
    ).href;
  const tailwindUrl = fileUrl(VIEW_RUNTIME.tailwindFile);
  return {
    directoryUrl: new URL(".", tailwindUrl).href,
    tailwindUrl,
    lucideUrl: fileUrl(VIEW_RUNTIME.lucideFile)
  };
}

/**
 * Where the instance serves the shell document every view is framed in. Absolute for the
 * reason the runtime's addresses are, and on the API's origin like them.
 */
export function viewShellUrl(apiBaseUrl: string, pageUrl: string): string {
  return new URL(
    `${apiBaseUrl.replace(/\/$/u, "")}${apiOperations["view_shell.files.get"].buildPath({
      params: { version: VIEW_SHELL.version, file: VIEW_SHELL.documentFile }
    })}`,
    pageUrl
  ).href;
}

/**
 * The composed head always comes first, before any byte of the stored HTML, so the content
 * policy governs everything the model wrote. The stored HTML is never searched for a place to
 * put it: a tag name inside a comment, an attribute or a title would be found too, and a
 * script before it would run under no policy. A later `<html>`, `<head>` or `<body>` of the
 * stored HTML is merged by the parser.
 */
export function composeViewDocument(input: ViewDocumentInput): string {
  if (!viewRunsScripts(input.kind)) {
    return `<!doctype html><html><head>${createStaticHead()}</head>\n<body>${writeStaticViewBody(input.html)}</body></html>`;
  }
  const html = stripLegacyRuntimeTags(stripContentSecurityPolicyMeta(input.html));
  const head = createHead(input, collectInlineScriptHashSources(html));
  return `<!doctype html><html><head>${head}</head>\n${html}`;
}

const THEME_COLOR_NAMES = [
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
  "success",
  "warning",
  "info",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
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

// The compiler reads `tailwind.config` when it first builds. Wrapped in a function so that it
// declares nothing a saved view's own copy of this script declares again.
const TAILWIND_THEME_SCRIPT = [
  "(()=>{",
  "function themeColor(name){return function({opacityValue}){if(opacityValue===undefined){return `var(${name})`}const value=Number(opacityValue);return Number.isFinite(value)?`color-mix(in srgb, var(${name}) ${value*100}%, transparent)`:`var(${name})`}}",
  `const names=${JSON.stringify(THEME_COLOR_NAMES)};`,
  'const colors=Object.fromEntries(names.map((name)=>[name,themeColor("--"+name)]));',
  'tailwind.config={theme:{extend:{colors,borderRadius:{lg:"var(--radius)",md:"calc(var(--radius) - 2px)",sm:"calc(var(--radius) - 4px)"}}}};',
  "})();"
].join("");
const LUCIDE_SCRIPT =
  'document.addEventListener("DOMContentLoaded",function(){if(window.lucide){window.lucide.createIcons();}});';
const DISPLAY_HEIGHT_SCRIPT = `(()=>{const t="${VIEW_SHELL_MESSAGES.height}";let e=0;function n(){const t=document.documentElement,n=document.body;return Math.ceil(Math.max(t?.scrollHeight??0,t?.offsetHeight??0,n?.scrollHeight??0,n?.offsetHeight??0))}function o(){const o=n();o>0&&Math.abs(o-e)>1&&(e=o,parent.postMessage({type:t,height:o},"*"))}document.addEventListener("DOMContentLoaded",()=>{o();if("ResizeObserver"in window&&document.body){window.__vivdCatalystResizeObserver=new ResizeObserver(o);window.__vivdCatalystResizeObserver.observe(document.body)}setTimeout(o,50);setTimeout(o,250);setTimeout(o,1000)});window.addEventListener("load",o)})();`;
// Hardening, not a boundary. WebRTC sends packets to a host a script names, and no content
// policy or sandbox flag of today's browsers forbids it. This takes the constructors away
// before any script of the view runs, which stops a script that reaches for them by name. A
// script that wants them gets them back from a new window: it writes a `srcdoc` frame of its
// own that holds a copy of itself, which passes this policy by the same hash and runs where
// nothing was removed (`e2e/view-exits.spec.ts` does exactly that). The boundary is that a
// view holding private rows runs no script at all.
const WEBRTC_REMOVAL_SCRIPT =
  'for(const name of ["RTCPeerConnection","webkitRTCPeerConnection","mozRTCPeerConnection"]){try{delete window[name]}catch{}}';
// Hardening, not a boundary. A link in a view leads nowhere: the shell refuses the address.
// But a click with a modifier key or the middle button opens the address in a new tab or
// downloads it, outside the frame, and the request leaves. So a link, an image map area and
// an SVG link lose their address as soon as they are in the document, whoever put them
// there, and a click on one that still has an address is cancelled before the browser acts
// on it. Every address goes, `#fragment` too: in a `srcdoc` frame the browser resolves it
// against the address of the shell, and the shell's refusal replaces the view. A script of
// the view can undo all of this, for example in a frame it writes itself.
const LINK_REMOVAL_SCRIPT =
  '(()=>{const names=["href","xlink:href","ping"];function isLink(node){return node.nodeType===1&&(node.localName==="a"||node.localName==="area")}function strip(node){if(isLink(node)){for(const name of names){node.removeAttribute(name)}}}function sweep(node){strip(node);if(node.nodeType===1){for(const link of node.querySelectorAll("a,area")){strip(link)}}}new MutationObserver((records)=>{for(const record of records){if(record.type==="attributes"){if(record.target.hasAttribute(record.attributeName)){strip(record.target)}}else{for(const node of record.addedNodes){sweep(node)}}}}).observe(document,{subtree:true,childList:true,attributes:true,attributeFilter:names});function cancel(event){if(event.composedPath().some((node)=>isLink(node)&&names.some((name)=>node.hasAttribute(name)))){event.preventDefault()}}window.addEventListener("click",cancel,true);window.addEventListener("auxclick",cancel,true)})();';
// Tells the host that the content policy refused a script file, so it can say so above the
// frame. Inline handlers and data addresses are refused silently, as before.
const BLOCKED_SCRIPT_REPORT_SCRIPT = `document.addEventListener("securitypolicyviolation",function(event){if(event.effectiveDirective==="script-src-elem"&&/^https?:/.test(event.blockedURI)){parent.postMessage({type:"${VIEW_SHELL_MESSAGES.blocked}"},"*")}});`;
const THEME_HELPER_SCRIPT = `(()=>{function color(name,fallback){const key=name.startsWith("--")?name:"--"+name;const value=getComputedStyle(document.documentElement).getPropertyValue(key).trim();return value||fallback||""}function chartColors(){return{background:color("background"),foreground:color("foreground"),card:color("card"),cardForeground:color("card-foreground"),mutedForeground:color("muted-foreground"),border:color("border"),primary:color("primary"),accent:color("accent"),destructive:color("destructive"),success:color("success"),warning:color("warning"),info:color("info")}}function chartPalette(){return[color("chart-1"),color("chart-2"),color("chart-3"),color("chart-4"),color("chart-5")]}window.vivdCatalystTheme={color,chartColors,chartPalette}})();`;
// The light default theme for a view shown outside a themed chat: what the shared UI library
// derives from the default inputs, so no colour is held here.
const DEFAULT_THEME_DECLARATIONS = Object.entries(
  createThemeTokens(DEFAULT_THEME_INPUTS.light, "light")
)
  .map(([name, value]) => `  ${name}: ${value};`)
  .join("\n");
const DEFAULT_THEME_STYLE = `<style id="vivd-catalyst-default-theme">
:root {
  --radius: 0.5rem;
${DEFAULT_THEME_DECLARATIONS}
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
  padding: 0;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
*,
::before,
::after {
  border-color: var(--border);
}
</style>`;

// The two script tags every view stored before the runtime moved onto the instance carries in
// its head, named by the hash of the whole tag. Those addresses are no longer loaded: the
// tags are taken out wherever they appear and the runtime below takes their place.
const LEGACY_RUNTIME_TAG_HASHES: ReadonlySet<string> = new Set([
  "EB6aBgKgPdQSalLyxGBVVY+2xxgSwHcYJq1dv+yD4Zs=",
  "N/SjJOqUVPEPeXWi7UdBrwQ2fk7f6PcZBCrHwD0ADhw="
]);

// What a view may load besides scripts: nothing from any host. That a view cannot move its
// own frame to another address is not said here, because no browser lets a document say it of
// itself. The shell that frames the view says it, see `view-shell.ts` of the chat server.
const CLOSED_DIRECTIVES = [
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
];

const HEAD_OPENING = [
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  DEFAULT_THEME_STYLE
];

/** The head of a view that runs no script. Its frame runs none; the policy says so again. */
function createStaticHead(): string {
  const policy = ["default-src 'none'", "script-src 'none'", ...CLOSED_DIRECTIVES].join("; ");
  return [`<meta http-equiv="Content-Security-Policy" content="${policy}">`, ...HEAD_OPENING].join(
    "\n"
  );
}

function createHead(input: ViewDocumentInput, inlineScriptHashSources: string[]): string {
  const runtime = input.kind === "html.rendered" ? input.runtime : undefined;
  const scripts = [
    WEBRTC_REMOVAL_SCRIPT,
    LINK_REMOVAL_SCRIPT,
    BLOCKED_SCRIPT_REPORT_SCRIPT,
    ...(runtime ? [TAILWIND_THEME_SCRIPT, LUCIDE_SCRIPT] : []),
    THEME_HELPER_SCRIPT,
    DISPLAY_HEIGHT_SCRIPT
  ];
  const scriptHosts = runtime ? [runtime.directoryUrl, ...input.allowedScriptSrc] : [];
  const scriptSources = runtime ? [...scriptHosts, "'unsafe-eval'"] : [];
  const scriptHashes = [...scripts.map(scriptHashSource), ...inlineScriptHashSources];
  const policy = [
    "default-src 'none'",
    `script-src ${Array.from(new Set([...scriptSources, ...scriptHashes])).join(" ")}`,
    ...CLOSED_DIRECTIVES
  ].join("; ");
  // A hash in a policy also admits a script file of any host whose integrity attribute
  // carries that hash. A script must pass every policy of its document, so a second one
  // without hashes holds script files to the hosts above, and the first one keeps holding
  // inline scripts to the hashed ones. It names script-src alone and so changes nothing else.
  const scriptFilePolicy = `script-src ${Array.from(
    new Set([...scriptHosts, "'unsafe-inline'", ...(runtime ? ["'unsafe-eval'"] : [])])
  ).join(" ")}`;
  return [
    // The policies are the first elements of the document: nothing is parsed before they apply.
    `<meta http-equiv="Content-Security-Policy" content="${policy}">`,
    `<meta http-equiv="Content-Security-Policy" content="${scriptFilePolicy}">`,
    ...HEAD_OPENING,
    `<script>${WEBRTC_REMOVAL_SCRIPT}</script>`,
    `<script>${LINK_REMOVAL_SCRIPT}</script>`,
    `<script>${BLOCKED_SCRIPT_REPORT_SCRIPT}</script>`,
    ...(runtime
      ? [
          `<script src="${runtime.tailwindUrl}"></script>`,
          `<script>${TAILWIND_THEME_SCRIPT}</script>`,
          `<script src="${runtime.lucideUrl}"></script>`,
          `<script>${LUCIDE_SCRIPT}</script>`
        ]
      : []),
    `<script>${THEME_HELPER_SCRIPT}</script>`,
    `<script>${DISPLAY_HEIGHT_SCRIPT}</script>`
  ].join("\n");
}

function stripContentSecurityPolicyMeta(html: string): string {
  return html.replace(
    /<meta\b(?=[^>]*\bhttp-equiv\s*=\s*(?:"content-security-policy"|'content-security-policy'|content-security-policy))[^>]*>/giu,
    ""
  );
}

function stripLegacyRuntimeTags(html: string): string {
  return html.replace(/<script src="[^"]*"><\/script>/gu, (tag) =>
    LEGACY_RUNTIME_TAG_HASHES.has(sha256Base64(tag)) ? "" : tag
  );
}

/**
 * The browser hashes the text of a script as its parser read it, not the bytes between the
 * tags: line ends are normalised, a comment or a textarea holds no script, and an end tag may
 * carry a space. So the scripts are read with the browser's own parser. The parsed document
 * is inert; nothing in it runs or loads.
 */
function collectInlineScriptHashSources(html: string): string[] {
  const scripts = new DOMParser().parseFromString(html, "text/html").querySelectorAll("script");
  return Array.from(scripts)
    .filter((script) => !script.hasAttribute("src") && script.text.trim() !== "")
    .map((script) => scriptHashSource(script.text));
}

function scriptHashSource(source: string): string {
  return `'sha256-${sha256Base64(source)}'`;
}
