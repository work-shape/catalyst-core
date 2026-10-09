import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// The runtime a generated view loads from the instance: pinned third-party files under
// `vendor/view-runtime/<version>/`, each directory with a manifest that records where every
// file came from, its hash and its licence. A directory is never edited; a change to a file
// is a new version beside it, and the previous one stays for one release.

const viewRuntimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../vendor/view-runtime");

const manifestSchema = z.object({
  version: z.string().min(1),
  files: z.array(
    z.object({
      file: z.string().min(1),
      library: z.string().min(1),
      libraryVersion: z.string().min(1),
      source: z.url(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/u),
      licence: z.string().min(1),
      licenceFile: z.string().min(1),
      licenceSource: z.url()
    })
  )
});

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

interface ViewRuntimeFile {
  bytes: Buffer;
  contentType: string;
}

/** Every file the manifests name, read once: version, then file name. */
type ViewRuntimeFiles = ReadonlyMap<string, ReadonlyMap<string, ViewRuntimeFile>>;

/**
 * Reads the runtime at startup and refuses to start when a file is not the one its manifest
 * pins: a view would otherwise run code nobody reviewed, with nothing to show for it.
 */
export function loadViewRuntimeFiles(root: string = viewRuntimeRoot): ViewRuntimeFiles {
  const versions = new Map<string, ReadonlyMap<string, ViewRuntimeFile>>();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const directory = join(root, entry.name);
    const manifest = manifestSchema.parse(
      JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"))
    );
    if (manifest.version !== entry.name) {
      throw new Error(
        `View runtime manifest in '${entry.name}' names version '${manifest.version}'`
      );
    }
    const files = new Map<string, ViewRuntimeFile>();
    for (const pinned of manifest.files) {
      const file = readRuntimeFile(directory, pinned.file);
      const sha256 = createHash("sha256").update(file.bytes).digest("hex");
      if (sha256 !== pinned.sha256) {
        throw new Error(
          `View runtime file '${manifest.version}/${pinned.file}' has SHA-256 ${sha256}, its manifest pins ${pinned.sha256}. The file was changed or damaged; restore the released file.`
        );
      }
      files.set(pinned.file, file);
      files.set(pinned.licenceFile, readRuntimeFile(directory, pinned.licenceFile));
    }
    versions.set(manifest.version, files);
  }
  return versions;
}

function readRuntimeFile(directory: string, name: string): ViewRuntimeFile {
  const contentType = CONTENT_TYPES[extname(name)];
  if (!contentType) {
    throw new Error(`View runtime file '${name}' has no served content type`);
  }
  return { bytes: readFileSync(join(directory, name)), contentType };
}
