import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError, readYamlData } from "@work-shape/catalyst-core";
import { catalogueEntrySchema, type CatalogueEntry } from "./entry";

// Reads the catalogue entries of one directory: one folder per entry, named as the entry's
// id, holding `entry.yaml` and, for an official logo, its file. A release passes the
// directories it ships; nothing else adds an entry, and no file of an entry is run.

/** The file that holds an entry. */
export const CATALOGUE_ENTRY_FILE = "entry.yaml";
/** The largest logo file: it travels with every list of the dialog. */
export const CATALOGUE_LOGO_MAX_BYTES = 64 * 1024;

const LOGO_TYPES: Record<string, string> = { ".svg": "image/svg+xml", ".png": "image/png" };

function refuse(file: string, message: string): never {
  throw new AppError("VALIDATION_FAILED", `Catalogue entry ${file}: ${message}`);
}

/** Reads and checks one entry from its text. `folder` is where its logo file lies. */
export function parseCatalogueEntry(text: string, file: string, folder?: string): CatalogueEntry {
  const read = readYamlData(text, file);
  if (!read.ok) refuse(file, read.issue.message);
  const parsed = catalogueEntrySchema.safeParse(read.value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(entry)"}: ${issue.message}`)
      .join("; ");
    refuse(file, issues);
  }
  const { mark, ...entry } = parsed.data;
  if (!("logo" in mark)) return { ...entry, mark };
  if (folder === undefined) refuse(file, "a logo is read from the folder of the entry");
  const path = join(folder, mark.logo);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    refuse(file, `the logo '${mark.logo}' is not next to the entry`);
  }
  if (bytes.byteLength > CATALOGUE_LOGO_MAX_BYTES) {
    refuse(file, `the logo '${mark.logo}' is larger than ${CATALOGUE_LOGO_MAX_BYTES} bytes`);
  }
  const type = LOGO_TYPES[extname(mark.logo)];
  if (type === undefined) refuse(file, `the logo '${mark.logo}' is no .svg or .png`);
  return {
    ...entry,
    mark: { logo: `data:${type};base64,${bytes.toString("base64")}`, rights: mark.rights }
  };
}

/**
 * The entries of a directory, sorted by id. A folder without `entry.yaml` is refused, as is an
 * entry whose id is not its folder's name: one entry is one folder.
 */
export function loadCatalogueEntries(directory: string | URL): CatalogueEntry[] {
  const root = typeof directory === "string" ? directory : fileURLToPath(directory);
  return readdirSync(root)
    .filter((name) => !name.startsWith(".") && statSync(join(root, name)).isDirectory())
    .sort()
    .map((name) => {
      const folder = join(root, name);
      const file = join(folder, CATALOGUE_ENTRY_FILE);
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        refuse(file, `the folder '${name}' holds no ${CATALOGUE_ENTRY_FILE}`);
      }
      const entry = parseCatalogueEntry(text, file, folder);
      if (entry.id !== name)
        refuse(file, `the id '${entry.id}' is not its folder's name '${name}'`);
      return entry;
    });
}
