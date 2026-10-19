import {
  AppError,
  ASSET_ADDRESS_MAX_LENGTH,
  ASSET_ADDRESS_PATTERN,
  ASSET_OWNER_KINDS,
  DATA_STORE_MANIFEST_FILE,
  DATA_STORE_RESERVED_SCHEMA,
  dataStoreRecordsRuleSchema,
  readYamlData,
  type AssetValidationIssue,
  type DataStoreAppliedMigration,
  type JsonObject
} from "@work-shape/catalyst-core";
import { scopedTablesSchema } from "./scoped-tables";
import { createHash } from "node:crypto";
import { z } from "zod";

// What a Data Store's folder is read into: the definition a revision holds as its config.
// Everything here is checked and bounded before a statement is sent to a database.

/** The id of a store: what `store.yaml` calls `id`. It holds no dot, so an operation name reads. */
export const DATA_STORE_NAME_PATTERN = ASSET_ADDRESS_PATTERN;
export const DATA_STORE_NAME_MAX_LENGTH = ASSET_ADDRESS_MAX_LENGTH;
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

/** Who owns a store, as `store.yaml` may say it. The owner itself is the asset's. */
const scopeSchema = z.enum(ASSET_OWNER_KINDS);

// Strict: a key the manifest does not know is refused, never ignored.
const manifestSchema = z.strictObject({
  id: z.string(),
  records: z.array(dataStoreRecordsRuleSchema).optional(),
  scope: scopeSchema.optional(),
  tables: scopedTablesSchema.optional(),
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
    /** Checked against the owner of the asset when the revision is published. */
    scope: scopeSchema.optional(),
    sizeLimitBytes: z.number().int().positive().optional(),
    records: z.array(dataStoreRecordsRuleSchema).optional(),
    tables: scopedTablesSchema.optional(),
    migrations: z.array(migrationSchema).max(DATA_STORE_MAX_MIGRATIONS)
  })
  .superRefine((definition, context) => {
    const tables = new Set<string>();
    definition.records?.forEach((rule, index) => {
      if (tables.has(rule.table))
        context.addIssue({
          code: "custom",
          path: ["records", index, "table"],
          message: `records names table '${rule.table}' twice`
        });
      tables.add(rule.table);
    });
    definition.migrations.forEach((migration, index) => {
      if (migration.number !== index + 1) {
        context.addIssue({
          code: "custom",
          path: ["migrations", index, "number"],
          message: `Migrations are numbered from 0001 without a gap: expected ${fileNumber(index + 1)}, found ${fileNumber(migration.number)}`
        });
      }
      for (const refusal of migrationTextRefusals(migration.sql)) {
        context.addIssue({
          code: "custom",
          path: ["migrations", index, "sql"],
          message: `'${migrationFileName(migration)}' ${refusal}`
        });
      }
    });
  });

export type DataStoreDefinition = z.infer<typeof dataStoreDefinitionSchema>;
export type DataStoreMigration = DataStoreDefinition["migrations"][number];

/**
 * A statement that opens, ends or splits a transaction, by how it starts. A column or a table
 * may carry such a word as its name, so only the start of a statement is read. `end` is left
 * to the database: it also closes a block of a function.
 */
const TRANSACTION_STATEMENT =
  /^(?:(?:commit|rollback|abort|savepoint|release)\b|begin(?:\s+(?:transaction|work|isolation\s+level|read\s+(?:only|write)|(?:not\s+)?deferrable)\b(?!\s*:=)|$)|start\s+transaction\b|prepare\s+transaction\b)/iu;
/**
 * A statement that creates, changes or drops a role, or makes the session another one, by how
 * it starts. `create user mapping` is none of them.
 */
const ROLE_STATEMENT =
  /^(?:(?:create|alter|drop)\s+(?:role|group|user(?!\s+mapping))\b|(?:set|reset)\s+(?:(?:local|session)\s+)?(?:role|session\s+authorization)\b)/iu;

/**
 * Why the text of a migration is refused, as the end of a sentence that starts with its file.
 * A comment and a quoted value are no statement; the body of a function and of a `do` block
 * is. This is the refusal an author
 * reads early. A statement that is put together when it runs is not read here: the runner
 * holds a migration in its transaction and to its role whatever its text says.
 */
/** A dollar-quoted text is run where it is the body of a block or of a function: after `do` or `as`. */
const BODY_FOLLOWS = /\b(?:do|as)(?:\s+language\s+[A-Za-z_]+)?\s*$/iu;

/**
 * The text of a migration with what is no statement taken out: a comment, a quoted value, and
 * a dollar-quoted value. A dollar-quoted text that is run, the body of a `do` block or of a
 * function, stays, set off as statements of its own.
 */
function statementsOf(sql: string): string {
  return sql.replace(
    /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|(\$[A-Za-z_]*\$)([\s\S]*?)\1/gu,
    (_match, mark: string | undefined, body: string | undefined, offset: number) =>
      mark !== undefined && body !== undefined && BODY_FOLLOWS.test(sql.slice(0, offset))
        ? ` ; ${statementsOf(body)} ; `
        : " "
  );
}

function migrationTextRefusals(sql: string): string[] {
  const code = statementsOf(sql);
  const refusals: string[] = [];
  let namesSchema = false;
  // Read at the start of a statement only: a column may be named `role` or `commit`, and a
  // table may be dropped `on commit`.
  const statements = code.split(";").map((statement) => statement.trim());
  const endsTransaction = statements.some((statement) => TRANSACTION_STATEMENT.test(statement));
  for (const [, quoted, bare] of code.matchAll(/"((?:[^"]|"")*)"|([A-Za-z_][A-Za-z0-9_$]*)/gu)) {
    const word = bare?.toLowerCase();
    namesSchema ||= quoted === DATA_STORE_RESERVED_SCHEMA || word === DATA_STORE_RESERVED_SCHEMA;
  }
  if (namesSchema) {
    refusals.push(
      `names the schema '${DATA_STORE_RESERVED_SCHEMA}', which the platform keeps for itself in every store (DATA_STORE_RESERVED_SCHEMA). A migration creates and changes objects in other schemas.`
    );
  }
  if (endsTransaction) {
    refusals.push(
      "holds transaction control. A migration runs in one transaction, which the platform opens and ends: take 'begin', 'commit', 'rollback' and 'savepoint' out of it."
    );
  }
  if (statements.some((statement) => ROLE_STATEMENT.test(statement))) {
    refusals.push(
      "creates, changes or takes a role. A migration runs as the migration role of its store and leaves every role as it is."
    );
  }
  return refusals;
}

function fileNumber(number: number): string {
  return String(number).padStart(4, "0");
}

/** The file a migration was read from, as a refusal names it. */
export function migrationFileName(migration: { number: number; name: string }): string {
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
    ...(manifest.tables ? { tables: manifest.tables } : {}),
    ...(manifest.records === undefined ? {} : { records: manifest.records }),
    title: manifest.name ?? manifest.id,
    ...(manifest.description === undefined ? {} : { description: manifest.description }),
    ...(manifest.scope === undefined ? {} : { scope: manifest.scope }),
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
  if (text === undefined) {
    issues.push({ message: `'${DATA_STORE_MANIFEST_FILE}' is not UTF-8 text`, path });
    return undefined;
  }
  const read = readYamlData(text, DATA_STORE_MANIFEST_FILE, { refuseAliases: true });
  if (!read.ok) {
    issues.push({ message: read.issue.message, path });
    return undefined;
  }
  const parsed = manifestSchema.safeParse(read.value);
  if (!parsed.success) {
    issues.push(
      ...parsed.error.issues.map((issue) => ({
        // The key is named in the sentence: a reader of the refusal sees no path.
        message: `${issue.path.length > 0 ? `'${issue.path.join(".")}': ` : ""}${issue.message}`,
        path: [...path, ...issue.path]
      }))
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

/** The bytes of a size as `store.yaml` and release config write it, such as `500MB`. */
export function sizeLimitBytes(sizeLimit: string): number {
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
