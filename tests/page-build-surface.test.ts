import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildPage, ROUTE_GENERATOR_EXECUTED_FILE } from "@work-shape/catalyst-app-build/build";
import { fileRoute, htmlManifest, pageFiles, reactManifest, rootRoute } from "./support/page-build";

// The build hands author files to two libraries: the route generator and the bundler. What
// either of them loads as code was read once, in the versions named here. This file holds them
// to what was read: a new version, or a new place where the generator loads a file as code,
// fails here before it reaches a Page.
//
// To raise a version: read what the new version executes (every finding below that changed),
// change `routes.ts` and `bundle.ts` to refuse or avoid it, then change the versions and the
// lists in this file in the same commit. The versions in `packages/app-build/package.json` are
// exact, and the build runs in the sandbox either way.

const REVIEWED_ROUTER_GENERATOR = "1.167.41";
// 0.28.1 changelog/diff: plugins, sandbox file/network access and our build options are unchanged.
const REVIEWED_ESBUILD = "0.28.1";

const packageRoot = resolve(process.cwd(), "packages/app-build");
const requireFromPackage = createRequire(join(packageRoot, "package.json"));
const packageJsonSchema = z.looseObject({
  name: z.string(),
  version: z.string(),
  dependencies: z.record(z.string(), z.string()).optional()
});

function readPackageJson(file: string) {
  return packageJsonSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

/** The folder of a dependency of the build package, as that package resolves it. */
function dependencyRoot(name: string): string {
  let directory = dirname(requireFromPackage.resolve(name));
  for (;;) {
    const file = join(directory, "package.json");
    if (existsSync(file) && readPackageJson(file).name === name) {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(`The package ${name} was not found`);
    }
    directory = parent;
  }
}

function scripts(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) return scripts(file);
    return entry.isFile() && entry.name.endsWith(".js") ? [file] : [];
  });
}

// Every way a module of the generator could load or run another file as code.
const CODE_LOADING =
  /\bcreateJiti\b|\bcreateRequire\b|\brequire\s*\(|\bimport\s*\(|node:child_process|node:vm|node:worker_threads|\beval\s*\(|new Function\b|resolveConfig|pathToFileURL|loadConfigFile\(/gu;

describe("the versions the build was read in", () => {
  const declared = readPackageJson(join(packageRoot, "package.json")).dependencies ?? {};

  it("pins the route generator and the bundler exactly, and installs those versions", () => {
    expect(declared["@tanstack/router-generator"]).toBe(REVIEWED_ROUTER_GENERATOR);
    expect(declared.esbuild).toBe(REVIEWED_ESBUILD);
    expect(
      readPackageJson(join(dependencyRoot("@tanstack/router-generator"), "package.json")).version
    ).toBe(REVIEWED_ROUTER_GENERATOR);
    expect(readPackageJson(join(dependencyRoot("esbuild"), "package.json")).version).toBe(
      REVIEWED_ESBUILD
    );
  });

  it("knows what the route generator depends on", () => {
    // `jiti` runs a file as code and `prettier` loads configuration: the build reaches neither.
    expect(
      readPackageJson(join(dependencyRoot("@tanstack/router-generator"), "package.json"))
        .dependencies
    ).toEqual({
      "@babel/types": "^7.29.8",
      jiti: "^2.7.0",
      "magic-string": "^0.30.21",
      prettier: "^3.9.6",
      zod: "^4.5.4",
      "@tanstack/router-core": "1.171.35",
      "@tanstack/router-utils": "1.162.3",
      "@tanstack/virtual-file-routes": "1.162.0"
    });
  });
});

describe("where the route generator loads a file as code", () => {
  const root = dependencyRoot("@tanstack/router-generator");
  const modules = join(root, "dist/esm");

  it("does so in the places that were read, and nowhere else", () => {
    const found: Record<string, string[]> = {};
    for (const file of scripts(modules)) {
      const matches = [...new Set(readFileSync(file, "utf8").match(CODE_LOADING) ?? [])].sort();
      if (matches.length > 0) {
        found[relative(modules, file)] = matches;
      }
    }

    expect(found).toEqual({
      // Reads `tsr.config.json` as JSON. The build makes its config itself and never calls it.
      "config.js": ["resolveConfig"],
      "index.js": ["resolveConfig"],
      // Imports a file named by the generator's pattern below: refused by `routes.ts`.
      "filesystem/physical/getRouteNodes.js": ["loadConfigFile("],
      // Imports the file the config key `virtualRouteConfig` names: the build never sets it.
      "filesystem/virtual/getRouteNodes.js": ["loadConfigFile("],
      // The one loader: jiti imports the file it is given.
      "filesystem/virtual/loadConfigFile.js": ["createJiti", "import(", "loadConfigFile("],
      // Text of the route tree it writes, not a call.
      "generator.js": ["import("]
    });
  });

  it("names the files it imports with the pattern the build refuses", () => {
    const source = readFileSync(join(modules, "filesystem/physical/getRouteNodes.js"), "utf8");
    const pattern = /virtualConfigFileRegExp = \/(.+)\/;/u.exec(source)?.[1];

    expect(pattern).toBe(ROUTE_GENERATOR_EXECUTED_FILE.source);
    // The generator tests the end of a file name, so the refusal tests the end of a path.
    expect(ROUTE_GENERATOR_EXECUTED_FILE.test("src/routes/sub/a__virtual.js")).toBe(true);
    expect(ROUTE_GENERATOR_EXECUTED_FILE.test("a__virtual.js")).toBe(true);
  });

  it("has the config keys that were read", async () => {
    const { configSchema } = await import(
      requireFromPackage.resolve("@tanstack/router-generator")
    ).then((loaded: unknown) =>
      z
        .object({ configSchema: z.object({ shape: z.record(z.string(), z.unknown()) }) })
        .parse(loaded)
    );

    // `virtualRouteConfig` and `plugins` are the keys that bring code; the build sets neither.
    expect(Object.keys(configSchema.shape).sort()).toEqual([
      "addExtensions",
      "autoCodeSplitting",
      "customScaffolding",
      "disableLogging",
      "disableTypes",
      "enableRouteTreeFormatting",
      "experimental",
      "generatedRouteTree",
      "importRoutesUsingAbsolutePaths",
      "indexToken",
      "pathParamsAllowedCharacters",
      "plugins",
      "quoteStyle",
      "routeFileIgnorePattern",
      "routeFileIgnorePrefix",
      "routeFilePrefix",
      "routeToken",
      "routeTreeFileFooter",
      "routeTreeFileHeader",
      "routesDirectory",
      "semicolons",
      "target",
      "tmpDir",
      "virtualRouteConfig"
    ]);
    const buildConfig = readFileSync(join(packageRoot, "src/routes.ts"), "utf8");
    expect(buildConfig).not.toMatch(/virtualRouteConfig\s*:|plugins\s*:/u);
  });
});

describe("the configuration files a tool would run", () => {
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "page-build-surface-test-"));
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  // Every name a bundler, a transpiler, a formatter or the generator is known to load from a
  // project, each with code that would leave a file behind if it ran.
  const CONFIG_FILES = [
    "esbuild.config.js",
    "esbuild.config.mjs",
    "tsr.config.js",
    "jiti.config.js",
    "vite.config.ts",
    "vite.config.js",
    "rollup.config.js",
    "webpack.config.js",
    "babel.config.js",
    ".babelrc.js",
    "postcss.config.js",
    "tailwind.config.js",
    "prettier.config.js",
    ".prettierrc.js",
    ".eslintrc.js",
    "eslint.config.js",
    "tsup.config.ts"
  ];
  const DATA_FILES: Record<string, string> = {
    "tsconfig.json": JSON.stringify({
      extends: "../../../../outside/tsconfig.json",
      compilerOptions: { plugins: [{ name: "../../outside" }], jsxImportSource: "../../outside" }
    }),
    "package.json": JSON.stringify({
      type: "commonjs",
      main: "../../outside.js",
      browser: { react: "../../outside.js" },
      scripts: { preinstall: "touch ran", build: "touch ran" }
    }),
    "tsr.config.json": JSON.stringify({ virtualRouteConfig: "./routes.js", plugins: ["./p.js"] }),
    ".prettierrc": JSON.stringify({ plugins: ["./plugin.js"] }),
    ".babelrc": JSON.stringify({ plugins: ["./plugin.js"] })
  };

  const hostile = (folder: string, marker: string): Record<string, string> => ({
    ...Object.fromEntries(
      CONFIG_FILES.map((name) => [
        `${folder}${name}`,
        `globalThis.process.getBuiltinModule("node:fs").writeFileSync(${JSON.stringify(marker)}, ${JSON.stringify(name)});\nexport default {};\n`
      ])
    ),
    ...Object.fromEntries(
      Object.entries(DATA_FILES).map(([name, text]) => [`${folder}${name}`, text])
    )
  });

  it("are files like any other in a React Page: none is run, in the folder, in src or among the routes", async () => {
    const marker = join(directory, "marker-react");
    const result = await buildPage({
      files: pageFiles({
        "app.yaml": reactManifest,
        "src/routes/__root.tsx": rootRoute,
        "src/routes/index.tsx": fileRoute("/"),
        ...hostile("", marker),
        ...hostile("src/", marker),
        ...hostile("src/routes/-config/", marker)
      })
    });

    expect(result.status === "errors" ? result.errors : []).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });

  it("are files like any other in an HTML Page", async () => {
    const marker = join(directory, "marker-html");
    const result = await buildPage({
      files: pageFiles({
        "app.yaml": htmlManifest,
        "index.html": `<!doctype html><script type="module" src="./main.ts"></script>`,
        "main.ts": `document.title = "ready";\n`,
        ...hostile("", marker)
      })
    });

    expect(result.status === "errors" ? result.errors : []).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });
});
