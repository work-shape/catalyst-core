#!/usr/bin/env node
// Single source for the publish metadata every platform package shares. Checks that the
// package manifests match it; `--write` applies it. The registry is one line here; licence
// and access are set per package group.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Licence and registry access are set per package group. A package in no group is private
// product code: no licence, and only people of the organisation may install it.
const DEFAULT_GROUP = { license: "UNLICENSED", access: "restricted" };
export const PUBLIC_PACKAGE_DIRS = ["config-cli", "asset-schemas", "api-contract", "api-client"];

export function isCapabilities(root) {
  return (
    JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).name ===
    "vivd-catalyst-capabilities"
  );
}

/** The licence and the registry access of one package folder. */
export function packageGroup(dir, root = repoRoot) {
  return !isCapabilities(root) && PUBLIC_PACKAGE_DIRS.includes(dir)
    ? { license: "MIT", access: "public" }
    : DEFAULT_GROUP;
}

const REGISTRY = "https://registry.npmjs.org/";
const NODE_ENGINE = ">=22";

// Packages under packages/ that are not published, with the reason.
export const UNPUBLISHED = {
  "app-kit":
    "Source of the App Kit; a Page never installs it, the instance serves its released files from server",
  "quality-config":
    "Check tooling for this repository and capabilities, used from the platform checkout"
};

// Everything else under packages/ is published with `files: ["dist"]` and
// `sideEffects: false` unless listed here.
const OVERRIDES = {
  // The static site is installed and deployed as files; it has no module entry.
  docs: { assetsOnly: true },
  // The OpenAPI document of the release, for consumers that are not written in TypeScript.
  "api-contract": { files: ["dist", "openapi.json"] },
  // Tailwind scans dist/ in published packages. Keep only the unbuilt stylesheet and Vite
  // entry with its helpers; workspace development still resolves the full local source.
  // Imports CSS and Univer facades for their side effects.
  "chat-ui": {
    files: [
      "dist",
      "src/styles.css",
      "src/vite.js",
      "src/vite.d.ts",
      "src/content-policy.js",
      "src/env.js"
    ],
    sideEffects: undefined
  },
  // Ships src/ for the same Tailwind scanning and for its `./styles.css` export. Its
  // JavaScript imports no CSS and has no side effects.
  ui: { files: ["dist", "src"] },
  // The entry runs the CLI when executed as `catalyst`. `catalyst setup` writes the skill it
  // ships, read at runtime from ../skills relative to dist/.
  "config-cli": { files: ["dist", "skills"], sideEffects: undefined },
  // Ships the pinned view runtime it serves, read at runtime from ../vendor relative to dist/.
  server: { files: ["dist", "vendor"] },
  // Migrations are read at runtime from ../migrations relative to dist/. The
  // `./migration-statements` export is plain JavaScript with a declaration file, so the
  // migration checks can import it without a build.
  "postgres-store": {
    files: ["dist", "migrations", "src/migration-statements.js", "src/migration-statements.d.ts"]
  },
  // Shell scripts, host files and Node checks, shipped as they are: nothing is built.
  "artifact-helpers": { files: ["dist", "skills"], sideEffects: undefined },
  // Its capability reads the skill it ships at runtime from ../skills relative to dist/.
  "outside-forms": { files: ["dist", "skills"] },
  "deployment-kit": {
    files: ["bin", "lib", "host", "verify", "dev", "docker"],
    sideEffects: undefined,
    assetsOnly: true
  }
};

const KEY_ORDER = [
  "name",
  "version",
  "private",
  "license",
  "repository",
  "type",
  "sideEffects",
  "engines",
  "files",
  "main",
  "types",
  "bin",
  "exports",
  "publishConfig"
];

export function listPackages(root = repoRoot) {
  return readdirSync(resolve(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const manifestPath = resolve(root, "packages", entry.name, "package.json");
      return {
        dir: entry.name,
        root: dirname(manifestPath),
        manifestPath,
        manifest: JSON.parse(readFileSync(manifestPath, "utf8")),
        publishable: isCapabilities(root) || !(entry.name in UNPUBLISHED),
        group: packageGroup(entry.name, root),
        assetsOnly: OVERRIDES[entry.name]?.assetsOnly === true
      };
    })
    .sort((left, right) => left.dir.localeCompare(right.dir));
}

// The `development` condition points at src/ for workspace HMR. Published tarballs do not
// carry src/ (and must not resolve to it where they do), so the published export map drops it.
export function publishedExports(exports) {
  if (typeof exports !== "object" || exports === null) {
    return exports;
  }
  return Object.fromEntries(
    Object.entries(exports)
      .filter(([condition]) => condition !== "development")
      .map(([key, value]) => [key, publishedExports(value)])
      .filter(
        ([, value]) => typeof value !== "object" || value === null || Object.keys(value).length > 0
      )
  );
}

export function withPublishMetadata(dir, manifest, root = repoRoot) {
  const override = OVERRIDES[dir] ?? {};
  const group = packageGroup(dir, root);
  const repository =
    group.access === "public"
      ? "catalyst"
      : isCapabilities(root)
        ? "catalyst-capabilities"
        : "catalyst-core";
  const next = {
    ...manifest,
    license: group.license,
    repository: {
      type: "git",
      url: `https://github.com/work-shape/${repository}`,
      directory: `packages/${dir}`
    },
    sideEffects: "sideEffects" in override ? override.sideEffects : false,
    engines: { node: NODE_ENGINE },
    files: override.files ?? ["dist"],
    publishConfig: {
      access: group.access,
      registry: REGISTRY,
      exports: publishedExports(manifest.exports)
    }
  };
  delete next.private;

  const ordered = {};
  for (const key of [...KEY_ORDER, ...Object.keys(next)]) {
    if (next[key] !== undefined && !(key in ordered)) {
      ordered[key] = next[key];
    }
  }
  return ordered;
}

function serialize(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

// Returns the directories whose manifest differs from the shared metadata.
export function findMetadataDrift({ write = false, root = repoRoot } = {}) {
  const drifted = [];
  for (const pkg of listPackages(root)) {
    if (!pkg.publishable) {
      continue;
    }
    const expected = serialize(withPublishMetadata(pkg.dir, pkg.manifest, root));
    if (expected === serialize(pkg.manifest)) {
      continue;
    }
    drifted.push(pkg.dir);
    if (write) {
      writeFileSync(pkg.manifestPath, expected);
    }
  }
  return drifted;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const write = process.argv.includes("--write");
  const rootIndex = process.argv.indexOf("--root");
  if (rootIndex !== -1 && !process.argv[rootIndex + 1]) throw new Error("--root needs a directory");
  const root = rootIndex === -1 ? repoRoot : resolve(process.argv[rootIndex + 1]);
  const drifted = findMetadataDrift({ write, root });
  if (drifted.length === 0) {
    console.log("package-metadata: all publishable manifests match");
  } else if (write) {
    console.log(`package-metadata: updated ${drifted.join(", ")}`);
  } else {
    console.error(
      `package-metadata: out of date in ${drifted.join(", ")}; run pnpm release:metadata`
    );
    process.exitCode = 1;
  }
}
