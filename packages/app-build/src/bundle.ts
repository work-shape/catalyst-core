import { context, transform, type Loader, type Message, type Plugin } from "esbuild";
import { fileSetPathIssue } from "@work-shape/catalyst-core";
import type { CompiledAppAction } from "./action-input";
import { compileActions } from "./actions";
import { resolveReference, rewriteHtml, withHeadStart } from "./html";
import {
  APP_KIT_PACKAGE,
  KIT_IMPORT_NAMES,
  KIT_RUNTIME_PATH,
  KIT_STYLESHEET_FILE,
  htmlPageHead,
  kitFilePath,
  kitImportPath,
  kitStylesPlainPages,
  rendersKitComponents
} from "./kit";
import {
  PAGE_BUILD_MAX_ERRORS,
  PAGE_BUILD_MAX_MESSAGE_CHARS,
  PAGE_BUILD_MAX_OUTPUT_BYTES
} from "./limits";
import { PAGE_MANIFEST_FILE, parsePageManifest, type PageManifest } from "./manifest";
import { generateRouteTree, PAGE_ROUTE_TREE_FILE } from "./routes";
import type { PageBuildError, PageBuildResult, PageFile, PageRoute } from "./types";

// The build of one Page: a transform from the files an author wrote to the files a browser is
// given. It reads the author's files as text and bytes and never as a program: nothing here
// imports, requires, evaluates or spawns one of them.
//
// esbuild is given every file from memory. Its plugin below answers every import esbuild asks
// about, so esbuild's own resolver, which looks on disk and in `node_modules`, is never reached.
// An import is one of three things: a file of the Page, a name the kit provides, which stays an
// import of a path on the instance, or an error.

const NAMESPACE = "page";
// esbuild compiles a filter as a Go expression, which has no `u` flag.
const EVERY_PATH = new RegExp(".*");
const OUT_DIRECTORY = "/page-build-out";
/** The entry of a React Page. No file of an author can have this path: the folder is reserved. */
const REACT_ENTRY_FILE = "__catalyst/entry.tsx";
const DEFAULT_ENTRY = "index.html";
/** Folders of a Page that hold what runs on the server. Nothing in them is given to a browser. */
const SERVER_DIRECTORIES = ["actions/", "schemas/"];

const SOURCE_LOADERS: ReadonlyMap<string, Loader> = new Map<string, Loader>([
  ["tsx", "tsx"],
  ["ts", "ts"],
  ["jsx", "jsx"],
  // An agent writes JSX into a `.js` file often enough, and plain JavaScript parses the same.
  ["js", "jsx"],
  ["mjs", "js"]
]);
const OTHER_LOADERS: ReadonlyMap<string, Loader> = new Map<string, Loader>([
  ["css", "css"],
  ["json", "json"],
  ["txt", "text"],
  ...["svg", "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "woff", "woff2"].map(
    (extension): [string, Loader] => [extension, "file"]
  )
]);
/** What is copied into the built files as it is, when a Page holds it outside its sources. */
const STATIC_EXTENSIONS = new Set([
  "css",
  "js",
  "mjs",
  "json",
  "txt",
  "csv",
  "svg",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "ico",
  "woff",
  "woff2"
]);
const RESOLVE_EXTENSIONS = ["tsx", "ts", "jsx", "js", "mjs", "css", "json"];

/**
 * Builds a Page from its files. Returns the built files with the manifest, or the errors an
 * author has to fix. It throws only when the build itself fails, not for anything in a file.
 */
export async function buildPage(input: {
  files: readonly PageFile[];
  signal?: AbortSignal;
}): Promise<PageBuildResult> {
  const sources = new Map<string, Uint8Array>();
  const pathErrors: PageBuildError[] = [];
  for (const file of input.files) {
    const issue = fileSetPathIssue(file.path);
    if (issue) {
      pathErrors.push({
        file: file.path,
        code: "file_invalid",
        message: `The file cannot be part of a Page: ${issue}.`
      });
    }
    sources.set(file.path, file.bytes);
  }
  if (pathErrors.length > 0) {
    return failed(pathErrors);
  }
  const manifestBytes = sources.get(PAGE_MANIFEST_FILE);
  if (!manifestBytes) {
    return failed([
      {
        file: PAGE_MANIFEST_FILE,
        code: "manifest_invalid",
        message: "The folder has no app.yaml. A Page has a manifest with at least id, name and kit."
      }
    ]);
  }
  const parsed = parsePageManifest(manifestBytes);
  if (parsed.status === "errors") {
    return failed(parsed.errors);
  }
  const { manifest } = parsed;
  const compiled = compileActions(manifest, input.files);
  if (compiled.status === "errors") {
    return failed(compiled.errors);
  }
  const syntaxErrors = await checkSyntax(input.files);
  if (syntaxErrors.length > 0) {
    return failed(syntaxErrors);
  }
  const built =
    manifest.entry === undefined
      ? await buildReactPage(manifest, input.files, sources, input.signal)
      : await buildHtmlPage(manifest, manifest.entry, input.files, sources, input.signal);
  return built.status === "built" ? withActions(built, compiled.actions) : built;
}

/**
 * The built Page with its actions as they were compiled. A manifest lists the actions of its
 * files and nothing an author wrote under `actions` by hand.
 */
function withActions(
  built: Extract<PageBuildResult, { status: "built" }>,
  actions: CompiledAppAction[]
): PageBuildResult {
  return actions.length > 0 ? { ...built, manifest: { ...built.manifest, actions } } : built;
}

async function buildReactPage(
  manifest: PageManifest,
  files: readonly PageFile[],
  sources: Map<string, Uint8Array>,
  signal: AbortSignal | undefined
): Promise<PageBuildResult> {
  const routes = await generateRouteTree(files);
  if (routes.status === "errors") {
    return failed(routes.errors);
  }
  const encoder = new TextEncoder();
  for (const [path, text] of routes.files) {
    sources.set(path, encoder.encode(text));
  }
  sources.set(
    REACT_ENTRY_FILE,
    encoder.encode(
      [
        `import { mountApp } from ${JSON.stringify(APP_KIT_PACKAGE)};`,
        `import { routeTree } from ${JSON.stringify(`../${PAGE_ROUTE_TREE_FILE.replace(/\.ts$/u, "")}`)};`,
        "mountApp({ routeTree });",
        ""
      ].join("\n")
    )
  );
  const bundle = await bundleEntries({
    kitVersion: manifest.kit,
    sources,
    entries: [{ in: REACT_ENTRY_FILE, out: "app" }],
    signal
  });
  if (bundle.status === "errors") {
    return failed(bundle.errors);
  }
  const built = new Map(bundle.files.map((file) => [file.path, file.bytes]));
  for (const file of files) {
    if (file.path.startsWith("assets/") && isStaticFile(file.path) && !built.has(file.path)) {
      built.set(file.path, file.bytes);
    }
  }
  built.set(
    DEFAULT_ENTRY,
    encoder.encode(reactDocument(manifest, { withStyles: built.has("app.css") }))
  );
  return finish(manifest, built, routes.pages);
}

async function buildHtmlPage(
  manifest: PageManifest,
  entry: string,
  files: readonly PageFile[],
  sources: Map<string, Uint8Array>,
  signal: AbortSignal | undefined
): Promise<PageBuildResult> {
  if (!sources.has(entry)) {
    return failed([
      {
        file: PAGE_MANIFEST_FILE,
        code: "manifest_invalid",
        message: `'entry' names '${entry}', which is not a file of the Page.`
      }
    ]);
  }
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const built = new Map<string, Uint8Array>();
  const errors: PageBuildError[] = [];
  const entries = new Map<string, string>();
  /** Per HTML file, its text and the module scripts it loads. */
  const documents = new Map<string, { html: string; modules: string[] }>();
  // An inline block that became a file, for errors that are reported against that file.
  const inlineOrigins = new Map<string, { file: string; line: number }>();

  for (const file of files) {
    if (!/\.html?$/iu.test(file.path) || isServerFile(file.path)) {
      continue;
    }
    const rewritten = rewriteHtml({
      path: file.path,
      kitVersion: manifest.kit,
      html: decoder.decode(file.bytes),
      exists: (path) => sources.has(path)
    });
    errors.push(...rewritten.errors);
    built.set(file.path, encoder.encode(rewritten.html));
    const modules = rewritten.moduleScripts.map((script) => script.source);
    documents.set(file.path, { html: rewritten.html, modules });
    for (const source of modules) {
      entries.set(source, withoutExtension(source));
    }
    for (const block of rewritten.extracted) {
      inlineOrigins.set(block.path, { file: file.path, line: block.line });
      const bytes = encoder.encode(block.text);
      if (block.kind === "module_script") {
        sources.set(block.path, bytes);
        entries.set(block.path, withoutExtension(block.path));
        modules.push(block.path);
        continue;
      }
      built.set(block.path, bytes);
      if (block.kind === "classic_script") {
        errors.push(
          ...(await syntaxErrorsOf(block.text, "js")).map((message) =>
            buildError(message, block.path, inlineOrigins)
          )
        );
      }
    }
  }
  if (errors.length > 0) {
    return failed(errors);
  }
  const bundled = new Set<string>();
  const componentEntries = new Set<string>();
  if (entries.size > 0) {
    const bundle = await bundleEntries({
      kitVersion: manifest.kit,
      sources,
      entries: [...entries].map(([source, out]) => ({ in: source, out })),
      inlineOrigins,
      signal
    });
    if (bundle.status === "errors") {
      return failed(bundle.errors);
    }
    for (const file of bundle.files) {
      built.set(file.path, file.bytes);
    }
    bundle.inputs.forEach((path) => bundled.add(path));
    bundle.componentEntries.forEach((path) => componentEntries.add(path));
  }
  if (kitStylesPlainPages(manifest.kit)) {
    // The build supplies the base look and theme; an author may also link the kit's fonts.
    for (const [path, { html, modules }] of documents) {
      const look = modules.some((source) => componentEntries.has(source)) ? "components" : "plain";
      built.set(path, encoder.encode(withHeadStart(html, htmlPageHead(manifest.kit, look))));
    }
  }
  for (const file of files) {
    if (
      isStaticFile(file.path) &&
      !isServerFile(file.path) &&
      !bundled.has(file.path) &&
      !built.has(file.path)
    ) {
      built.set(file.path, file.bytes);
    }
  }
  return finish(manifest, built, undefined);
}

function finish(
  manifest: PageManifest,
  built: Map<string, Uint8Array>,
  pages: PageRoute[] | undefined
): PageBuildResult {
  let total = 0;
  for (const bytes of built.values()) {
    total += bytes.byteLength;
  }
  if (total > PAGE_BUILD_MAX_OUTPUT_BYTES) {
    return failed([
      {
        file: PAGE_MANIFEST_FILE,
        code: "output_too_large",
        message: `The built Page has ${total} bytes. A build produces at most ${PAGE_BUILD_MAX_OUTPUT_BYTES} (PAGE_BUILD_MAX_OUTPUT_BYTES).`
      }
    ]);
  }
  // What an author wrote under `actions` is a declaration. The compiled actions take its place.
  const { actions: _declared, ...authored } = manifest;
  return {
    status: "built",
    kitVersion: manifest.kit,
    manifest: {
      ...authored,
      entry: manifest.entry ?? DEFAULT_ENTRY,
      ...(pages ? { pages } : {})
    },
    files: [...built].map(([path, bytes]) => ({ path, bytes }))
  };
}

type Bundle =
  | {
      status: "bundled";
      files: PageFile[];
      inputs: string[];
      /** The entries whose script renders components of the kit. */
      componentEntries: string[];
    }
  | { status: "errors"; errors: PageBuildError[] };

/** One script per entry, with the kit left as imports of paths on the instance. */
async function bundleEntries(input: {
  kitVersion: string;
  sources: ReadonlyMap<string, Uint8Array>;
  entries: { in: string; out: string }[];
  inlineOrigins?: ReadonlyMap<string, { file: string; line: number }>;
  signal: AbortSignal | undefined;
}): Promise<Bundle> {
  const build = await context({
    entryPoints: input.entries,
    bundle: true,
    write: false,
    outdir: OUT_DIRECTORY,
    format: "esm",
    // One script per entry: a Page has no chunk a browser would fetch later.
    splitting: false,
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    minify: true,
    sourcemap: false,
    legalComments: "none",
    metafile: true,
    logLevel: "silent",
    assetNames: "assets/[name]-[hash]",
    define: { "process.env.NODE_ENV": '"production"' },
    // Given here so that no `tsconfig.json` is looked for.
    tsconfigRaw: {},
    plugins: [pageFilesPlugin(input.sources, input.kitVersion)]
  });
  const cancel = () => {
    build.cancel().catch(() => undefined);
  };
  input.signal?.addEventListener("abort", cancel, { once: true });
  try {
    if (input.signal?.aborted) {
      throw new Error("The build was stopped");
    }
    const result = await build.rebuild();
    return {
      status: "bundled",
      files: (result.outputFiles ?? []).map((file) => ({
        path: file.path.slice(OUT_DIRECTORY.length + 1).replaceAll("\\", "/"),
        bytes: file.contents
      })),
      inputs: Object.keys(result.metafile?.inputs ?? {}).map(withoutNamespace),
      componentEntries: Object.values(result.metafile?.outputs ?? {}).flatMap((output) =>
        output.entryPoint !== undefined &&
        output.imports.some((imported) => rendersKitComponents(imported.path))
          ? [withoutNamespace(output.entryPoint)]
          : []
      )
    };
  } catch (error) {
    const messages = buildMessages(error);
    if (!messages || input.signal?.aborted) {
      throw error;
    }
    return {
      status: "errors",
      errors: messages.map((message) => buildError(message, undefined, input.inlineOrigins))
    };
  } finally {
    input.signal?.removeEventListener("abort", cancel);
    await build.dispose();
  }
}

/**
 * Answers every import and every load from the files in memory. No `onResolve` call returns
 * without a result, so esbuild never resolves a path by itself.
 */
function pageFilesPlugin(sources: ReadonlyMap<string, Uint8Array>, kitVersion: string): Plugin {
  return {
    name: "page-files",
    setup(build) {
      build.onResolve({ filter: EVERY_PATH }, (args) => {
        if (args.kind === "entry-point") {
          return { path: args.path, namespace: NAMESPACE };
        }
        const kit = kitImportPath(kitVersion, args.path);
        if (kit !== undefined) {
          return { path: kit, external: true };
        }
        // CSS loads versioned kit assets from this instance at runtime, just as HTML does.
        // Whole file segments keep the exception inside the kit; scripts still use kit names.
        const kitAsset = args.path.slice(KIT_RUNTIME_PATH.length + 1).replace(/[?#].*$/u, "");
        if (
          (args.kind === "import-rule" || args.kind === "url-token") &&
          args.path.startsWith(`${KIT_RUNTIME_PATH}/`) &&
          /^\d+\.\d+\.\d+\//u.test(kitAsset) &&
          fileSetPathIssue(kitAsset) === undefined
        ) {
          return { path: args.path, external: true };
        }
        if (args.path.startsWith("data:")) {
          return { path: args.path, external: true };
        }
        if (args.path.startsWith("./") || args.path.startsWith("../")) {
          const directory = args.importer.includes("/")
            ? args.importer.slice(0, args.importer.lastIndexOf("/") + 1)
            : "";
          const target = resolveReference(directory, args.path.replace(/[?#].*$/u, ""));
          const found = target === undefined ? undefined : findSource(sources, target);
          return found === undefined
            ? { errors: [{ text: `'${args.path}' names no file of the Page.` }] }
            : { path: found, namespace: NAMESPACE };
        }
        return {
          errors: [
            {
              text: `'${args.path}' cannot be imported. A Page imports its own files by a relative path, and from the kit: ${KIT_IMPORT_NAMES.join(", ")}. Nothing is installed or fetched.`
            }
          ]
        };
      });
      build.onLoad({ filter: EVERY_PATH, namespace: NAMESPACE }, (args) => {
        const contents = sources.get(args.path);
        const loader = loaderOf(args.path);
        if (contents === undefined || loader === undefined) {
          return {
            errors: [{ text: `'${args.path}' is not a kind of file a Page's script can import.` }]
          };
        }
        return { contents, loader };
      });
    }
  };
}

function findSource(sources: ReadonlyMap<string, Uint8Array>, target: string): string | undefined {
  if (sources.has(target)) {
    return target;
  }
  for (const extension of RESOLVE_EXTENSIONS) {
    if (sources.has(`${target}.${extension}`)) return `${target}.${extension}`;
  }
  for (const extension of RESOLVE_EXTENSIONS) {
    if (sources.has(`${target}/index.${extension}`)) return `${target}/index.${extension}`;
  }
  return undefined;
}

/** Parses every script source of the Page, so that a file no route imports is checked too. */
async function checkSyntax(files: readonly PageFile[]): Promise<PageBuildError[]> {
  const decoder = new TextDecoder();
  const errors: PageBuildError[] = [];
  for (const file of files) {
    const loader = SOURCE_LOADERS.get(extensionOf(file.path));
    if (loader === undefined || isServerFile(file.path)) {
      continue;
    }
    const messages = await syntaxErrorsOf(decoder.decode(file.bytes), loader);
    errors.push(...messages.map((message) => buildError(message, file.path)));
    if (errors.length >= PAGE_BUILD_MAX_ERRORS) {
      break;
    }
  }
  return errors;
}

async function syntaxErrorsOf(text: string, loader: Loader): Promise<Message[]> {
  try {
    await transform(text, { loader, jsx: "automatic", logLevel: "silent", tsconfigRaw: {} });
    return [];
  } catch (error) {
    const messages = buildMessages(error);
    if (!messages) {
      throw error;
    }
    return messages;
  }
}

function buildMessages(error: unknown): Message[] | undefined {
  if (typeof error !== "object" || error === null || !("errors" in error)) {
    return undefined;
  }
  const { errors } = error;
  return Array.isArray(errors) ? errors.filter(isMessage) : undefined;
}

function isMessage(value: unknown): value is Message {
  return typeof value === "object" && value !== null && "text" in value;
}

/**
 * An esbuild message as an error of the Page. `file` is given for a message about a text that
 * has no file name of its own. A message about an inline block is reported against the HTML
 * file the block was in, at the line it has there.
 */
function buildError(
  message: Message,
  file?: string,
  inlineOrigins?: ReadonlyMap<string, { file: string; line: number }>
): PageBuildError {
  const location = message.location;
  const path = file ?? (location ? withoutNamespace(location.file) : PAGE_MANIFEST_FILE);
  const origin = inlineOrigins?.get(path);
  const unresolved = /cannot be imported|names no file of the Page/u.test(message.text);
  return {
    file: origin?.file ?? path,
    ...(location
      ? {
          line: location.line + (origin ? origin.line - 1 : 0),
          // esbuild counts columns from 0.
          ...(origin && location.line === 1 ? {} : { column: location.column + 1 })
        }
      : {}),
    code: unresolved ? "import_unavailable" : "syntax",
    message: message.text
  };
}

function failed(errors: PageBuildError[]): PageBuildResult {
  return {
    status: "errors",
    errors: errors.slice(0, PAGE_BUILD_MAX_ERRORS).map((error) => ({
      ...error,
      message:
        error.message.length > PAGE_BUILD_MAX_MESSAGE_CHARS
          ? `${error.message.slice(0, PAGE_BUILD_MAX_MESSAGE_CHARS)}...`
          : error.message
    }))
  };
}

/** The document of a React Page. Its script and styles are files of the revision. */
function reactDocument(manifest: PageManifest, options: { withStyles: boolean }): string {
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeText(manifest.name)}</title>`,
    `<link rel="stylesheet" href="${kitFilePath(manifest.kit, KIT_STYLESHEET_FILE)}">`,
    ...(options.withStyles ? ['<link rel="stylesheet" href="./app.css">'] : []),
    '</head><body><div id="root"></div>',
    '<script type="module" src="./app.js"></script>',
    "</body></html>",
    ""
  ].join("\n");
}

function escapeText(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function extensionOf(path: string): string {
  return /\.([A-Za-z0-9]+)$/u.exec(path)?.[1]?.toLowerCase() ?? "";
}

function loaderOf(path: string): Loader | undefined {
  const extension = extensionOf(path);
  return SOURCE_LOADERS.get(extension) ?? OTHER_LOADERS.get(extension);
}

function isStaticFile(path: string): boolean {
  return STATIC_EXTENSIONS.has(extensionOf(path));
}

function isServerFile(path: string): boolean {
  return SERVER_DIRECTORIES.some((directory) => path.startsWith(directory));
}

function withoutExtension(path: string): string {
  return path.replace(/\.[A-Za-z0-9]+$/u, "");
}

function withoutNamespace(path: string): string {
  return path.startsWith(`${NAMESPACE}:`) ? path.slice(NAMESPACE.length + 1) : path;
}
