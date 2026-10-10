import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { PageFile } from "@vivd-catalyst/app-build";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../packages/app-build");

let processEntry: Promise<string> | undefined;

/**
 * The script of the Page build process, bundled from the sources as they are now. The package
 * ships `dist/build-process.js`; a test that used it would test the last build of the package.
 * The file lies inside the package so that it finds the package's dependencies.
 */
export function pageBuildProcessEntryFromSource(): Promise<string> {
  processEntry ??= (async () => {
    const outfile = resolve(packageRoot, `.tmp/build-process-${process.pid}.mjs`);
    await mkdir(dirname(outfile), { recursive: true });
    await build({
      entryPoints: [resolve(packageRoot, "src/build-process.ts")],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      logLevel: "silent"
    });
    return outfile;
  })();
  return processEntry;
}

/** The files of a Page from texts by path. */
export function pageFiles(files: Record<string, string | Uint8Array>): PageFile[] {
  return Object.entries(files).map(([path, content]) => ({
    path,
    bytes: typeof content === "string" ? new TextEncoder().encode(content) : content
  }));
}

export const reactManifest = "id: demo-page\nname: Demo Page\nkit: 1.0.0\n";
export const htmlManifest = "id: demo-page\nname: Demo Page\nkit: 1.0.0\nentry: index.html\n";

export const rootRoute = `import { createRootRoute, Outlet } from "@tanstack/react-router";
export const Route = createRootRoute({ component: () => <Outlet /> });
`;

export function fileRoute(path: string, body = "<p>Hello</p>"): string {
  return `import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("${path}")({ component: () => ${body} });
`;
}
