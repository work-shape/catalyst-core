import { createHash } from "node:crypto";
import yaml from "js-yaml";
import { z } from "zod";
import {
  AppError,
  DATA_STORE_MANIFEST_FILE,
  type AssetValidationIssue,
  type DataStoreAppliedMigration,
  type JsonObject
} from "@vivd-catalyst/core";

// What a Data Store's folder is read into: the definition a revision holds as its config.
// Everything here is checked and bounded before a statement is sent to a database.

/** The id of a store: what `store.yaml` calls `id`. It holds no dot, so an operation name reads. */
export const DATA_STORE_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
export const DATA_STORE_NAME_MAX_LENGTH = 63;
export const DATA_STORE_NAME_RULE =
  "lowercase letters and digits in words joined by '-', starting with a letter, at most 63 characters";
/** How long the name people read may be. */
const DATA_STORE_TITLE_MAX_CHARS = 120;
/** How long the description an agent reads may be. */
const DATA_STORE_DESCRIPTION_MAX_CHARS = 2_000;
/** The largest `store.yaml`. A manifest is a few lines; a larger file is refused unread. */
const DATA_STORE_MANIFEST_MAX_BYTES = 16_384;
/** How many migration files one store has at most. A write with more is refused. */
const DATA_STORE_MAX_MIGRATIONS = 500;
/** The largest migration file. A write with a larger one is refused. */
const DATA_STORE_MIGRATION_MAX_BYTES = 262_144;
/** The folder of the migration files and the folder of optional seed data, which is stored only. */
const MIGRATIONS_FOLDER = "migrations/";
const SEED_FOLDER = "seed/";
const MIGRATION_FILE = /^migrations\/(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/u;
const BYTES_PER_UNIT = { MB: 1024 ** 2, GB: 1024 ** 3 } as const;
const SIZE_LIMIT = /^([1-9]\d{0,5})(MB|GB)$/u;

const manifestSchema = z.strictObject({
  id: z.string(),
  name: z.string().min(1).max(DATA_STORE_TITLE_MAX_CHARS).optional(),
  description: z.string().max(DATA_STORE_DESCRIPTION_MAX_CHARS).optional(),
  sizeLimit: z
    .string()
    .regex(SIZE_LIMIT, "a whole number of MB or GB, such as 500MB or 2GB")
    .optional()
});

const migrationSchema = z.strictObject({
  number: z.number().int().positive(),
  name: z.string().min(1).max(100),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  sql: z.string().min(1).max(DATA_STORE_MIGRATION_MAX_BYTES)
});

/**
 * The definition of a Data Store as a revision holds it: the manifest's fields and the
 * migration files in the order they are applied, numbered from 1 without a gap.
 */
export const dataStoreDefinitionSchema = z
  .strictObject({
    name: z.string(),
    title: z.string().min(1).max(DATA_STORE_TITLE_MAX_CHARS),
    description: z.string().max(DATA_STORE_DESCRIPTION_MAX_CHARS).optional(),
    sizeLimitBytes: z.number().int().positive().optional(),
    migrations: z.array(migrationSchema).max(DATA_STORE_MAX_MIGRATIONS)
  })
  .superRefine((definition, context) => {
    definition.migrations.forEach((migration, index) => {
      if (migration.number !== index + 1) {
        context.addIssue({
          code: "custom",
          path: ["migrations", index, "number"],
          message: `Migrations are numbered from 0001 without a gap: expected ${fileNumber(index + 1)}, found ${fileNumber(migration.number)}`
        });
      }
    });
  });

export type DataStoreDefinition = z.infer<typeof dataStoreDefinitionSchema>;
export type DataStoreMigration = DataStoreDefinition["migrations"][number];

function fileNumber(number: number): string {
  return String(number).padStart(4, "0");
}

/** The file a migration was read from, as a refusal names it. */
export function migrationFileName(migration: Pick<DataStoreMigration, "number" | "name">): string {
  return `${MIGRATIONS_FOLDER}${fileNumber(migration.number)}_${migration.name}.sql`;
}

function refused(issues: AssetValidationIssue[]): AppError {
  return new AppError("VALIDATION_FAILED", "The files of the Data Store are not valid", {
    reason: "validation_failed",
    issues: issues.map(({ message, path }) => ({ message, path: path?.map(String) }))
  });
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

function readText(bytes: Uint8Array): string | undefined {
  try {
    const text = utf8.decode(bytes);
    return text.includes("\u0000") ? undefined : text;
  } catch {
    return undefined;
  }
}

/**
 * Reads the files of a Data Store's folder into its definition, or throws `VALIDATION_FAILED`
 * with every issue found. Each file is measured before it is read.
 */
export function readDataStoreFiles(
  files: readonly { path: string; bytes: Uint8Array }[]
): JsonObject {
  const issues: AssetValidationIssue[] = [];
  const migrations: DataStoreMigration[] = [];
  let manifest: z.infer<typeof manifestSchema> | undefined;
  for (const file of files) {
    if (file.path === DATA_STORE_MANIFEST_FILE) {
      manifest = readManifest(file.bytes, issues);
    } else if (file.path.startsWith(MIGRATIONS_FOLDER)) {
      const migration = readMigration(file, issues);
      if (migration) migrations.push(migration);
    } else if (!file.path.startsWith(SEED_FOLDER)) {
      issues.push({
        message: `'${file.path}' is no file of a Data Store: it holds '${DATA_STORE_MANIFEST_FILE}', '${MIGRATIONS_FOLDER}NNNN_name.sql' and files below '${SEED_FOLDER}'`,
        path: [file.path]
      });
    }
  }
  if (migrations.length > DATA_STORE_MAX_MIGRATIONS) {
    issues.push({
      message: `The store has ${migrations.length} migrations. It has at most ${DATA_STORE_MAX_MIGRATIONS} (DATA_STORE_MAX_MIGRATIONS).`,
      path: [MIGRATIONS_FOLDER]
    });
  }
  if (!manifest || issues.length > 0) throw refused(issues);
  const definition = dataStoreDefinitionSchema.safeParse({
    name: manifest.id,
    title: manifest.name ?? manifest.id,
    ...(manifest.description === undefined ? {} : { description: manifest.description }),
    ...(manifest.sizeLimit === undefined
      ? {}
      : { sizeLimitBytes: sizeLimitBytes(manifest.sizeLimit) }),
    migrations: migrations.sort((left, right) => left.number - right.number)
  });
  if (!definition.success) throw refused(definition.error.issues);
  return definition.data;
}

function readManifest(
  bytes: Uint8Array,
  issues: AssetValidationIssue[]
): z.infer<typeof manifestSchema> | undefined {
  const path = [DATA_STORE_MANIFEST_FILE];
  if (bytes.byteLength > DATA_STORE_MANIFEST_MAX_BYTES) {
    issues.push({
      message: `'${DATA_STORE_MANIFEST_FILE}' has ${bytes.byteLength} bytes. It has at most ${DATA_STORE_MANIFEST_MAX_BYTES} (DATA_STORE_MANIFEST_MAX_BYTES).`,
      path
    });
    return undefined;
  }
  const text = readText(bytes);
  let loaded: unknown;
  try {
    loaded = text === undefined ? undefined : yaml.load(text);
  } catch {
    loaded = undefined;
  }
  const parsed = manifestSchema.safeParse(loaded);
  if (!parsed.success) {
    issues.push(
      ...(loaded === undefined
        ? [{ message: `'${DATA_STORE_MANIFEST_FILE}' is not readable YAML`, path }]
        : parsed.error.issues.map((issue) => ({
            message: issue.message,
            path: [...path, ...issue.path]
          })))
    );
    return undefined;
  }
  return parsed.data;
}

function readMigration(
  file: { path: string; bytes: Uint8Array },
  issues: AssetValidationIssue[]
): DataStoreMigration | undefined {
  const named = MIGRATION_FILE.exec(file.path);
  if (!named) {
    issues.push({
      message: `'${file.path}' is not named as a migration: four digits, '_', lowercase words joined by '_', '.sql', such as '${MIGRATIONS_FOLDER}0001_init.sql'`,
      path: [file.path]
    });
    return undefined;
  }
  if (file.bytes.byteLength > DATA_STORE_MIGRATION_MAX_BYTES) {
    issues.push({
      message: `'${file.path}' has ${file.bytes.byteLength} bytes. A migration has at most ${DATA_STORE_MIGRATION_MAX_BYTES} (DATA_STORE_MIGRATION_MAX_BYTES).`,
      path: [file.path]
    });
    return undefined;
  }
  const sql = readText(file.bytes);
  if (sql === undefined || sql.trim() === "") {
    issues.push({ message: `'${file.path}' holds no SQL text`, path: [file.path] });
    return undefined;
  }
  return {
    number: Number(named[1]),
    name: named[2] ?? "",
    sha256: createHash("sha256").update(file.bytes).digest("hex"),
    sql
  };
}

function sizeLimitBytes(sizeLimit: string): number {
  const [, amount, unit] = SIZE_LIMIT.exec(sizeLimit) ?? [];
  return Number(amount) * BYTES_PER_UNIT[unit === "GB" ? "GB" : "MB"];
}

/**
 * Why a definition cannot follow what a store has applied, or nothing. Migrations are
 * forward-only: a file a database applied stays as it was, and the next one follows it.
 */
export function appliedMigrationIssue(
  applied: readonly DataStoreAppliedMigration[],
  definition: Pick<DataStoreDefinition, "migrations">
): string | undefined {
  for (const done of applied) {
    const file = migrationFileName(done);
    const now = definition.migrations.find((migration) => migration.number === done.number);
    if (!now) {
      return `The store has applied '${file}' and the revision does not hold it. An applied migration is never removed: add a new migration that changes what it made.`;
    }
    if (now.sha256 !== done.sha256 || now.name !== done.name) {
      return `The store has applied '${file}' and the revision holds '${migrationFileName(now)}' with other content. An applied migration is never changed: add a new migration instead.`;
    }
  }
  return undefined;
}
