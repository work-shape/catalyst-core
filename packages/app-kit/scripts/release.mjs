#!/usr/bin/env node
// Writes one released version of the App Kit: the files an instance serves under
// `/app-runtime/kit/<version>/`, into `packages/server/vendor/app-kit/<version>/`.
//
//   pnpm --dir platform kit:release            writes the version of KIT_VERSION below
//
// A released version is frozen: a Page names the version it was built with and keeps loading
// exactly these files. So the script never writes into a directory that exists. A change to
// the kit is a new version beside the old ones, added to `RELEASED_KIT_VERSIONS` of
// `packages/app-build/src/kit.ts` in the same change.
// File contents are stored once by hash in the sibling `app-kit-shared/`;
// the manifest still pins their exact bytes and Apps still load their versioned URLs.
//
// Every file is one ES module. They name each other by a relative address (`./react.js`), so
// a Page loads one React and one router however many of the files it imports, and no file
// names a host.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile, optimize } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import { build } from "esbuild";

const KIT_VERSION = "1.9.0";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const platformRoot = resolve(packageRoot, "../..");
const uiRoot = resolve(platformRoot, "packages/ui");
const outputRoot = resolve(platformRoot, "packages/server/vendor/app-kit", KIT_VERSION);
const sharedRoot = resolve(outputRoot, "../../app-kit-shared");
const require = createRequire(join(packageRoot, "package.json"));

/** The four names a Page imports React by. One file answers all of them. */
const REACT_MODULES = ["react", "react-dom", "react-dom/client", "react/jsx-runtime"];
const CHART_ENGINE = resolve(uiRoot, "src/data/chart-engine.ts");
const UI_ENTRY = resolve(uiRoot, "src/index.ts");
const UI_THEME_ENTRY = resolve(uiRoot, "src/theme/index.ts");

/**
 * The libraries a kit version is built from, for its manifest: name, version and licence. What
 * they bring along is named by the licence comments at the end of each file.
 */
const LIBRARIES = [
  "react",
  "react-dom",
  "@tanstack/react-router",
  "echarts",
  "radix-ui",
  "cmdk",
  "lucide-react",
  "class-variance-authority",
  "clsx",
  "tailwind-merge",
  "tailwindcss",
  "tw-animate-css"
];

// Refuse leftover content before building or writing a new release. Every retained manifest
// contributes references, including older versions whose files the current version no longer uses.
const referenced = new Set();
const retainedRoot = dirname(outputRoot);
if (existsSync(retainedRoot)) {
  for (const entry of readdirSync(retainedRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = JSON.parse(
      readFileSync(join(retainedRoot, entry.name, "manifest.json"), "utf8")
    );
    for (const file of manifest.files) referenced.add(file.sha256);
  }
}
const unreferenced = existsSync(sharedRoot)
  ? readdirSync(sharedRoot)
      .filter((name) => !referenced.has(name))
      .sort()
  : [];
if (unreferenced.length > 0) {
  throw new Error(
    `App Kit shared directory holds unreferenced files: ${unreferenced.join(", ")}. A released kit holds only files named by its manifests; restore the released files.`
  );
}

if (existsSync(outputRoot)) {
  console.error(
    `Kit version ${KIT_VERSION} is released: ${relative(platformRoot, outputRoot)} exists and is never rewritten. Raise KIT_VERSION in this script and add the version to RELEASED_KIT_VERSIONS.`
  );
  process.exit(1);
}

/**
 * The entry of `react.js`. The React packages are CommonJS, which has no static list of
 * exports, so the names are read from the packages and written out one by one.
 */
function reactEntry() {
  const lines = [];
  const seen = new Set(["default"]);
  REACT_MODULES.forEach((name, index) => {
    lines.push(`import module${index} from ${JSON.stringify(name)};`);
    for (const key of Object.keys(require(name))) {
      if (!seen.has(key) && /^[A-Za-z_$][\w$]*$/u.test(key)) {
        seen.add(key);
        lines.push(`export const ${key} = module${index}.${key};`);
      }
    }
  });
  lines.push("export default module0;");
  return lines.join("\n");
}

const files = [
  { file: "react.js", entry: { contents: reactEntry(), resolveDir: packageRoot, loader: "js" } },
  { file: "router.js", entry: resolve(packageRoot, "src/router-entry.ts") },
  { file: "charts.js", entry: CHART_ENGINE },
  { file: "ui.js", entry: UI_ENTRY },
  { file: "kit.js", entry: resolve(packageRoot, "src/index.ts") },
  // Stands alone: a plain Page loads it without React, the library or the rest of the kit.
  { file: "theme.js", entry: resolve(packageRoot, "src/theme-entry.ts") }
];

/**
 * Answers an import of what another kit file holds with that file's address. A CommonJS module
 * that requires React gets it through a small module of this build that re-exports the file,
 * because a `require` of an address would be left in the output as a call nothing answers.
 */
function kitFiles(current) {
  const external = (file) => (file === current ? undefined : { path: `./${file}`, external: true });
  return {
    name: "kit-files",
    // esbuild compiles a filter as a Go expression, which has no `u` flag.
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: new RegExp("^react(-dom)?(/.*)?$") }, (args) => {
        if (current === "react.js" || !REACT_MODULES.includes(args.path)) {
          return undefined;
        }
        return args.kind === "require-call"
          ? { path: "react", namespace: "kit-react" }
          : external("react.js");
      });
      pluginBuild.onLoad({ filter: new RegExp(".*"), namespace: "kit-react" }, () => ({
        contents: 'export * from "./react.js"; export { default } from "./react.js";',
        resolveDir: packageRoot,
        loader: "js"
      }));
      pluginBuild.onResolve({ filter: new RegExp("^\\./react\\.js$") }, () => external("react.js"));
      pluginBuild.onResolve({ filter: new RegExp("^@tanstack/react-router$") }, () =>
        external("router.js")
      );
      pluginBuild.onResolve({ filter: new RegExp("^@work-shape/catalyst-ui$") }, () =>
        current === "ui.js" ? { path: UI_ENTRY } : external("ui.js")
      );
      // The token mapping, from its source like the library itself, and inside the file that
      // imports it: it is a few lines, and `ui.js` would bring every component with it.
      pluginBuild.onResolve({ filter: new RegExp("^@work-shape/catalyst-ui/theme$") }, () => ({
        path: UI_THEME_ENTRY
      }));
      pluginBuild.onResolve({ filter: new RegExp("chart-engine$") }, (args) =>
        resolve(args.resolveDir, `${args.path}.ts`) === CHART_ENGINE
          ? external("charts.js")
          : undefined
      );
    }
  };
}

async function bundle({ file, entry }) {
  const result = await build({
    ...(typeof entry === "string" ? { entryPoints: [entry] } : { stdin: entry }),
    absWorkingDir: packageRoot,
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    minify: true,
    // The licence comments of what is bundled stay in the file, at its end.
    legalComments: "eof",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [kitFiles(file)],
    logLevel: "warning"
  });
  const [output] = result.outputFiles;
  if (!output || result.outputFiles.length !== 1) {
    throw new Error(`${file}: expected one output file`);
  }
  if (/\b__require\(/u.test(output.text) && /Dynamic require of/u.test(output.text)) {
    throw new Error(`${file}: a require() was left in the output; nothing in a browser answers it`);
  }
  return output.contents;
}

/** The rules of the flow canvas, which the library's stylesheet brings. */
const FLOW_STYLES = "@xyflow/react/dist/base.css";
/** What a stylesheet leaves out reads as this one, which holds no rule. */
const NO_RULES = resolve(packageRoot, "scripts/no-rules.css");

/**
 * One stylesheet of the kit. `utilities` says whether it holds the utility classes the library
 * and the kit use: the library's components need them, a plain Page must not get them. Nor
 * does a plain Page draw the flow canvas, so `canvas: false` leaves its rules out.
 */
async function stylesheet(file, { utilities, canvas }) {
  const entry = resolve(packageRoot, "src", file);
  const base = dirname(entry);
  const compiler = await compile(readFileSync(entry, "utf8"), {
    base,
    from: entry,
    onDependency() {},
    customCssResolver: (id) => Promise.resolve(!canvas && id === FLOW_STYLES ? NO_RULES : undefined)
  });
  const root =
    compiler.root === "none"
      ? []
      : compiler.root === null
        ? [{ base, pattern: "**/*", negated: false }]
        : [{ ...compiler.root, negated: false }];
  const classes = utilities ? new Scanner({ sources: [...root, ...compiler.sources] }).scan() : [];
  const css = optimize(compiler.build(classes), { minify: true }).code;
  if (/url\(\s*["']?(?:https?:)?\/\//iu.test(css) || /@import/iu.test(css)) {
    throw new Error(`${file} names an address outside the instance`);
  }
  return Buffer.from(css);
}

function libraryOf(name) {
  // Read from where the package manager linked the dependency: a stylesheet package has no
  // entry a resolver would find.
  for (const root of [packageRoot, uiRoot]) {
    const manifestPath = join(root, "node_modules", name, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      return { name, version: manifest.version, licence: manifest.license };
    }
  }
  throw new Error(`${name} is no dependency of the kit or of the UI library`);
}

const written = [];
for (const item of files) {
  written.push({ file: item.file, bytes: await bundle(item) });
}
written.push({
  file: "ui.css",
  bytes: await stylesheet("kit.css", { utilities: true, canvas: true })
});
written.push({
  file: "page.css",
  bytes: await stylesheet("page.css", { utilities: false, canvas: false })
});

// Font bytes and their licences are committed inputs; release never downloads them.
for (const file of readdirSync(resolve(packageRoot, "fonts"), { recursive: true })) {
  if (typeof file === "string" && statSync(resolve(packageRoot, "fonts", file)).isFile()) {
    written.push({
      file: `fonts/${file}`,
      bytes: readFileSync(resolve(packageRoot, "fonts", file))
    });
  }
}

const manifest = {
  version: KIT_VERSION,
  files: written
    .map(({ file, bytes }) => ({
      file,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex")
    }))
    .sort((left, right) => left.file.localeCompare(right.file)),
  libraries: LIBRARIES.map(libraryOf)
};
mkdirSync(outputRoot, { recursive: true });
mkdirSync(sharedRoot, { recursive: true });
for (const { bytes } of written) {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const path = join(sharedRoot, hash);
  if (existsSync(path)) {
    if (!readFileSync(path).equals(Buffer.from(bytes))) {
      throw new Error(`Shared App Kit file ${hash} differs from its content hash`);
    }
  } else {
    writeFileSync(path, bytes, { flag: "wx" });
  }
}
writeFileSync(join(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
  flag: "wx"
});

for (const { file, bytes } of manifest.files) {
  console.log(`${file.padEnd(12)} ${String(bytes).padStart(9)} bytes`);
}
console.log(`Kit ${KIT_VERSION} written to ${relative(platformRoot, outputRoot)}`);
