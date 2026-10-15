import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KIT_PLAIN_PAGE_FILES, kitStylesPlainPages } from "@work-shape/catalyst-app-build";
import { z } from "zod";

// The App Kit a Page loads from the instance: one frozen directory per released version under
// `vendor/app-kit/<version>/`, written by `pnpm kit:release`. A Page names the version it was
// built with and loads exactly these files for as long as it exists, so a directory is never
// edited and never removed. Each has a manifest with the hash of every file.

const appKitRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../vendor/app-kit");

/** The files every kit version has. A Page's bundle names them by these names. */
const APP_KIT_FILES: readonly string[] = [
  "kit.js",
  "react.js",
  "router.js",
  "ui.js",
  "ui.css",
  "charts.js"
];

/** The files of one kit version: those of every version, and what a later version added. */
export function appKitFilesOf(version: string): readonly string[] {
  return kitStylesPlainPages(version) ? [...APP_KIT_FILES, ...KIT_PLAIN_PAGE_FILES] : APP_KIT_FILES;
}

const APP_KIT_MANIFEST_FILE = "manifest.json";

const manifestSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/u),
  files: z.array(
    z.object({
      file: z.string().min(1),
      bytes: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/u)
    })
  ),
  libraries: z.array(
    z.object({ name: z.string().min(1), version: z.string().min(1), licence: z.string().min(1) })
  )
});

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

interface AppKitFile {
  bytes: Buffer;
  contentType: string;
}

/** Every file of every released version, read once: version, then file name. */
type AppKitFiles = ReadonlyMap<string, ReadonlyMap<string, AppKitFile>>;

/**
 * Reads the released kit versions at startup and refuses to start when a version is not what
 * its manifest records: a file with another hash, a file the manifest does not name, or a
 * missing file. A Page would otherwise run code that is not the released kit.
 */
export function loadAppKitFiles(root: string = appKitRoot): AppKitFiles {
  const versions = new Map<string, ReadonlyMap<string, AppKitFile>>();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const directory = join(root, entry.name);
    const manifestBytes = readFileSync(join(directory, APP_KIT_MANIFEST_FILE));
    const manifest = manifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
    if (manifest.version !== entry.name) {
      throw new Error(`App Kit manifest in '${entry.name}' names version '${manifest.version}'`);
    }
    const pinned = manifest.files.map((file) => file.file).sort();
    const expected = [...appKitFilesOf(manifest.version)].sort();
    if (pinned.join("\n") !== expected.join("\n")) {
      throw new Error(
        `App Kit version '${manifest.version}' pins the files ${pinned.join(", ")}. A kit version has ${expected.join(", ")}.`
      );
    }
    const present = readdirSync(directory).sort();
    const accounted = [...expected, APP_KIT_MANIFEST_FILE].sort();
    if (present.join("\n") !== accounted.join("\n")) {
      throw new Error(
        `App Kit directory '${manifest.version}' holds ${present.join(", ")}. A released version holds ${accounted.join(", ")} and nothing else.`
      );
    }
    const files = new Map<string, AppKitFile>();
    for (const file of manifest.files) {
      const bytes = readFileSync(join(directory, file.file));
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (sha256 !== file.sha256) {
        throw new Error(
          `App Kit file '${manifest.version}/${file.file}' has SHA-256 ${sha256}, its manifest pins ${file.sha256}. The file was changed or damaged; restore the released file.`
        );
      }
      files.set(file.file, { bytes, contentType: contentTypeOf(file.file) });
    }
    files.set(APP_KIT_MANIFEST_FILE, {
      bytes: manifestBytes,
      contentType: contentTypeOf(APP_KIT_MANIFEST_FILE)
    });
    versions.set(manifest.version, files);
  }
  return versions;
}

function contentTypeOf(name: string): string {
  const contentType = CONTENT_TYPES[extname(name)];
  if (!contentType) {
    throw new Error(`App Kit file '${name}' has no served content type`);
  }
  return contentType;
}
