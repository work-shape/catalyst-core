import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

const migrationsDirectory = resolve("packages/postgres-store/migrations");
const journalSchema = z
  .object({ entries: z.array(z.object({ tag: z.string() }).passthrough()) })
  .passthrough();

/**
 * A copy of the migrations whose journal ends before, or with, the migration of one name. The
 * name is the tag without its number, so a test keeps working when the migration is renumbered
 * at landing. Migrating with the copy and then with the real directory applies the rest.
 */
export function migrationsUntil(input: { name: string; including: boolean }): {
  directory: string;
  /** The tag of the named migration. */
  tag: string;
  remove(): void;
} {
  const journal = journalSchema.parse(
    JSON.parse(readFileSync(join(migrationsDirectory, "meta/_journal.json"), "utf8"))
  );
  const index = journal.entries.findIndex(
    (entry) => entry.tag.replace(/^\d+_/u, "") === input.name
  );
  const named = journal.entries[index];
  if (named === undefined) throw new Error(`No migration is named ${input.name}`);
  const directory = mkdtempSync(join(tmpdir(), `catalyst-migrations-${input.name}-`));
  cpSync(migrationsDirectory, directory, { recursive: true });
  writeFileSync(
    join(directory, "meta/_journal.json"),
    JSON.stringify({
      ...journal,
      entries: journal.entries.slice(0, input.including ? index + 1 : index)
    })
  );
  return {
    directory,
    tag: named.tag,
    remove: () => rmSync(directory, { recursive: true, force: true })
  };
}
