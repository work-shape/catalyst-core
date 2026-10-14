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
const PACKAGE_GROUPS = [
  // The public command line tool. Its tarball is checked by check-public-tarball.mjs.
  { license: "MIT", access: "public", dirs: ["config-cli"] },
  // The source the public tool is bundled from. It is MIT with the tool. Publishing these
  // as packages of their own is a later decision, so the registry access stays restricted.
  {
    license: "MIT",
    access: "restricted",
    dirs: ["asset-schemas", "api-contract", "api-client"]
  }
];

/** The licence and the registry access of one package folder. */
export function packageGroup(dir) {
  const group = PACKAGE_GROUPS.find(({ dirs }) => dirs.includes(dir)) ?? DEFAULT_GROUP;
  return { license: group.license, access: group.access };
}

/** The package folders that carry an MIT licence, and so a LICENSE file. */
export const MIT_PACKAGE_DIRS = PACKAGE_GROUPS.filter(({ license }) => license === "MIT").flatMap(
  ({ dirs }) => dirs
);
const REGISTRY = "https://registry.npmjs.org/";
const REPOSITORY_URL = "git+https://github.com/vivd-solutions/vivd-catalyst.git";
const NODE_ENGINE = ">=22";

// Packages under packages/ that are not published, with the reason.
export const UNPUBLISHED = {
  "app-kit":
    "Source of the App Kit; a Page never installs it, the instance serves its released files from chat-server",
  "chat-standalone": "Vite application, not a library; deployments build their own UI entry",
  docs: "Astro documentation site",
  "quality-config":
    "Check tooling for this repository and capabilities, used from the platform checkout",
  "registry-canary": "GitHub Packages canary from the superseded registry decision"
};

// Everything else under packages/ is published with `files: ["dist"]` and
// `sideEffects: false` unless listed here.
const OVERRIDES = {
  // The OpenAPI document of the release, for consumers that are not written in TypeScript.
  "api-contract": { files: ["dist", "openapi.json"] },
  // Ships src/ so Tailwind `@source` scanning and the `./vite` and `./styles.css` exports
  // work from node_modules. Imports CSS and Univer facades for their side effects.
  "chat-ui": { files: ["dist", "src"], sideEffects: undefined },
  // Ships src/ for the same Tailwind scanning and for its `./styles.css` export. Its
  // JavaScript imports no CSS and has no side effects.
  ui: { files: ["dist", "src"] },
  // The entry runs the CLI when executed as `catalyst`. `catalyst setup` writes the skill it
  // ships, read at runtime from ../skills relative to dist/.
  "config-cli": { files: ["dist", "skills"], sideEffects: undefined },
  // Ships the pinned view runtime it serves, read at runtime from ../vendor relative to dist/.
  "chat-server": { files: ["dist", "vendor"] },
  // Migrations are read at runtime from ../migrations relative to dist/. The
  // `./migration-statements` export is plain JavaScript with a declaration file, so the
  // migration checks can import it without a build.
  "postgres-store": {
    files: ["dist", "migrations", "src/migration-statements.js", "src/migration-statements.d.ts"]
  },
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
        group: packageGroup(entry.name),
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
  const group = packageGroup(dir);
  const next = {
    ...manifest,
    license: group.license,
    repository: { type: "git", url: REPOSITORY_URL, directory: `packages/${dir}` },
    sideEffects: "sideEffects" in override ? override.sideEffects : false,
    engines: { node: NODE_ENGINE },
    files: override.files ?? ["dist"],
    publishConfig: {
      access: group.access,
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
