import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { configSchema, Generator } from "@tanstack/router-generator";
import type { PageBuildError, PageFile, PageRoute } from "./types";

// The route tree of a React Page is made by TanStack Router's generator from the files under
// `src/routes/`. The generator works on a directory, so the route files are written into a new
// temporary directory, the generator runs there, and what it wrote is read back.
//
// What the generator does with a route file was read in its source (version pinned in this
// package's dependencies): it lists the directory, reads each file as text, rewrites the route
// path in the text and writes the route tree. It opens no socket. It executes a file in exactly
// one case: a file whose name ends in `__virtual.ts` (or `.js`, `.mjs`, `.cjs`, `.mts`, `.cts`),
// in the routes directory or any folder below it, is a "virtual route config" and is imported.
// The generator tests the end of the name only, so `a__virtual.js` is such a file too. A Page
// with a path that ends this way is refused below before anything is written. The generator's
// formatter is turned off, and no config file is read: the config is built here.
//
// This refusal is a second line. The build runs in the sandbox, where a file of the Page that
// did run would reach nothing: `tests/page-build-surface.test.ts` holds the generator to the
// version and the loading code that were read.

export const PAGE_ROUTES_DIRECTORY = "src/routes";
/** The route tree the generator writes, as a file of the Page beside its sources. */
export const PAGE_ROUTE_TREE_FILE = "src/routeTree.gen.ts";

/** The files the generator reads as routes. Nothing else is written to its directory. */
const ROUTE_FILE = /\.(?:tsx|ts|jsx|js)$/u;
/**
 * The names the generator would import and run: its own pattern, as written in its source
 * (`virtualConfigFileRegExp`). It is tested against the end of a path, as the generator tests
 * the end of a file name.
 */
export const ROUTE_GENERATOR_EXECUTED_FILE = /__virtual\.[mc]?[jt]s$/u;

export type GeneratedRoutes =
  | {
      status: "generated";
      /** The route tree and the route files as the generator left them, by path in the Page. */
      files: Map<string, string>;
      pages: PageRoute[];
    }
  | { status: "errors"; errors: PageBuildError[] };

/**
 * Whether a path of a Page ends like a file the route generator would execute. Asked of every
 * file of the Page, not only of its routes: no file of a Page has such a name.
 */
export function isVirtualRouteConfig(path: string): boolean {
  return ROUTE_GENERATOR_EXECUTED_FILE.test(path);
}

/**
 * Generates the route tree of a Page. `files` are the files of the Page; only its route files
 * are used. Their paths were checked by the caller: relative, without `.` or `..` segments.
 */
export async function generateRouteTree(files: readonly PageFile[]): Promise<GeneratedRoutes> {
  const routeFiles = files.filter(
    (file) => file.path.startsWith(`${PAGE_ROUTES_DIRECTORY}/`) && ROUTE_FILE.test(file.path)
  );
  const virtual = files.filter((file) => isVirtualRouteConfig(file.path));
  if (virtual.length > 0) {
    return {
      status: "errors",
      errors: virtual.map((file) => ({
        file: file.path,
        code: "routes_invalid" as const,
        message:
          "A file whose name ends in '__virtual' with a script extension is a route config the generator would run. A Page declares its routes with files only; rename the file."
      }))
    };
  }
  if (routeFiles.length === 0) {
    return {
      status: "errors",
      errors: [
        {
          file: PAGE_ROUTES_DIRECTORY,
          code: "routes_invalid",
          message:
            "The Page has no route file. A React Page has its routes under src/routes/, such as src/routes/index.tsx. A plain HTML Page names 'entry: index.html' in app.yaml."
        }
      ]
    };
  }
  const root = await mkdtemp(join(tmpdir(), "catalyst-page-routes-"));
  try {
    for (const file of routeFiles) {
      const target = join(root, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.bytes, { flag: "wx" });
    }
    const generator = new Generator({
      root,
      config: configSchema.parse({
        target: "react",
        routesDirectory: join(root, PAGE_ROUTES_DIRECTORY),
        generatedRouteTree: join(root, PAGE_ROUTE_TREE_FILE),
        tmpDir: join(root, ".generator"),
        disableLogging: true,
        enableRouteTreeFormatting: false
      })
    });
    try {
      await generator.run();
    } catch (error) {
      return {
        status: "errors",
        errors: [
          {
            file: PAGE_ROUTES_DIRECTORY,
            code: "routes_invalid",
            message: `The routes could not be read: ${error instanceof Error ? error.message.replaceAll(root, "") : "unknown error"}`
          }
        ]
      };
    }
    const generated = new Map<string, string>();
    for (const path of await listFiles(root, PAGE_ROUTES_DIRECTORY)) {
      generated.set(path, await readFile(join(root, path), "utf8"));
    }
    const routeTree = await readFile(join(root, PAGE_ROUTE_TREE_FILE), "utf8");
    generated.set(PAGE_ROUTE_TREE_FILE, routeTree);
    return { status: "generated", files: generated, pages: readPages(routeTree) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** The regular files below a directory of the temporary root, as paths of the Page. */
async function listFiles(root: string, directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...(await listFiles(root, path)));
    } else if (entry.isFile()) {
      found.push(path);
    }
  }
  return found;
}

/**
 * The pages of a route tree: the full paths the generator lists in the interface
 * `FileRoutesByFullPath`. A layout route has no path of its own and is not a page.
 */
function readPages(routeTree: string): PageRoute[] {
  const block = /interface FileRoutesByFullPath\s*\{([^}]*)\}/u.exec(routeTree)?.[1] ?? "";
  const paths = new Set<string>();
  for (const match of block.matchAll(/['"]([^'"]*)['"]\s*:/gu)) {
    const path = match[1];
    if (path !== undefined && path !== "") {
      paths.add(path);
    }
  }
  return [...paths].sort().map((path) => ({ path }));
}
