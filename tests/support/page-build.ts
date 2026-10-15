import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { z } from "zod";
import type { PageFile } from "@work-shape/catalyst-app-build";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../packages/app-build");

let command: Promise<string> | undefined;

/**
 * The build command as shell text, bundled from the sources as they are now. The package ships
 * `dist/cli.js`; a test that used it would test the last build of the package. The file lies
 * inside the package so that it finds the package's own dependencies; the workspace packages
 * are bundled from their sources, with the dependencies the package does not have itself.
 */
export function pageBuildCommandFromSource(): Promise<string> {
  command ??= (async () => {
    const outfile = resolve(packageRoot, `.tmp/cli-${process.pid}.mjs`);
    await mkdir(dirname(outfile), { recursive: true });
    const manifest = z
      .object({ dependencies: z.record(z.string(), z.string()) })
      .parse(JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")));
    await build({
      entryPoints: [resolve(packageRoot, "src/cli.ts")],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      external: Object.keys(manifest.dependencies).filter(
        (name) => !name.startsWith("@work-shape/catalyst-")
      ),
      logLevel: "silent"
    });
    return `'${process.execPath}' '${outfile}'`;
  })();
  return command;
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
