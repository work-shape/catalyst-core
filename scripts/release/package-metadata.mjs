#!/usr/bin/env node
// Single source for the publish metadata every platform package shares. Checks that the
// package manifests match it; `--write` applies it. Licence, registry and access are each
// one line here.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const LICENSE = "UNLICENSED";
const ACCESS = "restricted";
const REGISTRY = "https://registry.npmjs.org/";
const REPOSITORY_URL = "git+https://github.com/vivd-solutions/vivd-catalyst.git";
const NODE_ENGINE = ">=22";

// Packages under packages/ that are not published, with the reason.
export const UNPUBLISHED = {
  "chat-standalone": "Vite application, not a library; deployments build their own UI entry",
  docs: "Astro documentation site",
  "registry-canary": "GitHub Packages canary from the superseded registry decision"
};

// Everything else under packages/ is published with `files: ["dist"]` and
// `sideEffects: false` unless listed here.
const OVERRIDES = {
  // Ships src/ so Tailwind `@source` scanning and the `./vite` and `./styles.css` exports
  // work from node_modules. Imports CSS and Univer facades for their side effects.
  "chat-ui": { files: ["dist", "src"], sideEffects: undefined },
  // The entry runs the CLI when executed as `catalyst`.
  "config-cli": { sideEffects: undefined },
  // Migrations are read at runtime from ../migrations relative to dist/.
  "postgres-store": { files: ["dist", "migrations"] },
  // Shell scripts, host files and Node checks, shipped as they are: nothing is built.
  // Deployments use it from the platform checkout until it can be published; deleting
  // `heldBack` is the whole switch.
  "deployment-kit": {
    files: ["bin", "lib", "host", "verify", "dev"],
    sideEffects: undefined,
    assetsOnly: true,
    heldBack: true
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

export function listPackages() {
  return readdirSync(resolve(repoRoot, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const manifestPath = resolve(repoRoot, "packages", entry.name, "package.json");
      return {
        dir: entry.name,
        root: dirname(manifestPath),
        manifestPath,
        manifest: JSON.parse(readFileSync(manifestPath, "utf8")),
        publishable: !(entry.name in UNPUBLISHED),
        assetsOnly: OVERRIDES[entry.name]?.assetsOnly === true,
        heldBack: OVERRIDES[entry.name]?.heldBack === true
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
  );
}

export function withPublishMetadata(dir, manifest) {
  const override = OVERRIDES[dir] ?? {};
  const next = {
    ...manifest,
    license: LICENSE,
    repository: { type: "git", url: REPOSITORY_URL, directory: `packages/${dir}` },
    sideEffects: "sideEffects" in override ? override.sideEffects : false,
    engines: { node: NODE_ENGINE },
    files: override.files ?? ["dist"],
    publishConfig: {
      access: ACCESS,
      registry: REGISTRY,
      exports: publishedExports(manifest.exports)
    }
  };
  if (override.heldBack) {
    next.private = true;
  } else {
    delete next.private;
  }

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
export function findMetadataDrift({ write = false } = {}) {
  const drifted = [];
  for (const pkg of listPackages()) {
    if (!pkg.publishable) {
      continue;
    }
    const expected = serialize(withPublishMetadata(pkg.dir, pkg.manifest));
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
  const drifted = findMetadataDrift({ write });
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
