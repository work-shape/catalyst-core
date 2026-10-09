// The expand-and-contract rules for platform migrations: what a new migration may contain, that
// committed migrations never change, and which release a schema change must still serve.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseMigration,
  qualifiedNamePattern,
  runsOutsideTransaction,
  statementBreakpoint,
  statementName
} from "@vivd-catalyst/postgres-store/migration-statements";

export const platformRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const migrationsPath = "packages/postgres-store/migrations";
export const migrationsDirectory = join(platformRoot, migrationsPath);

/**
 * @typedef {{ historyThrough: string, oldestSupportedRelease: string }} MigrationPolicy
 * @typedef {{ migration: string, statement: string, rule: string, message: string }} LintFinding
 * @typedef {import("@vivd-catalyst/postgres-store/migration-statements").MigrationStatement} MigrationStatement
 */

/** @returns {MigrationPolicy} */
export function readMigrationPolicy(
  file = join(platformRoot, "packages/postgres-store/migration-policy.json")
) {
  const policy = JSON.parse(readFileSync(file, "utf8"));
  if (typeof policy.historyThrough !== "string" || !parseReleaseTag(policy.oldestSupportedRelease))
    throw new Error(
      `${file} must name historyThrough and an oldestSupportedRelease of the form v1.2.3`
    );
  return {
    historyThrough: policy.historyThrough,
    oldestSupportedRelease: policy.oldestSupportedRelease
  };
}

/**
 * @param {unknown} tag
 * @returns {[number, number, number] | undefined}
 */
function parseReleaseTag(tag) {
  const match = typeof tag === "string" ? /^v(\d+)\.(\d+)\.(\d+)$/u.exec(tag) : null;
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/**
 * Negative when `left` is the older release.
 * @param {[number, number, number]} left
 * @param {[number, number, number]} right
 */
function compareReleases(left, right) {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

/**
 * The newest release tag reachable from a commit. No file pins it.
 * @param {{ repoRoot?: string, ref?: string }} [input]
 * @returns {string}
 */
export function previousReleaseTag({ repoRoot = platformRoot, ref = "HEAD" } = {}) {
  const tags = git(repoRoot, ["tag", "--list", "v*", "--merged", ref])
    .split("\n")
    .flatMap((tag) => {
      const release = parseReleaseTag(tag);
      return release ? [{ tag, release }] : [];
    })
    .sort((left, right) => compareReleases(right.release, left.release));
  const newest = tags[0];
  if (!newest) throw new Error(`No release tag (v1.2.3) is reachable from ${ref}`);
  return newest.tag;
}

/** @param {string} name */
function tableKey(name) {
  return name.toLowerCase();
}

/** @param {string} shape */
function splitTopLevelCommas(shape) {
  const parts = [""];
  let depth = 0;
  for (const character of shape) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "," && depth === 0) parts.push("");
    else parts[parts.length - 1] += character;
  }
  return parts.map((part) => part.trim());
}

const repeatableConcurrentIndex =
  /^(?:CREATE (?:UNIQUE )?INDEX CONCURRENTLY IF NOT EXISTS|DROP INDEX CONCURRENTLY IF EXISTS)\b/u;
const additiveCreate = /^CREATE (?:TABLE|TYPE|SCHEMA|SEQUENCE|EXTENSION)\b/u;
const additiveColumnAction =
  /^(?:ALTER (?:COLUMN )?\S+ (?:SET DEFAULT\b|DROP NOT NULL$)|VALIDATE CONSTRAINT \S+$)/u;

/**
 * Lints one new migration against an allow list of additive forms: new tables, types, schemas
 * and sequences; a nullable or defaulted column; a column default; a relaxed NOT NULL; a
 * constraint added NOT VALID and its later validation; a concurrent index in a migration of its
 * own; inserts and updates; comments. A table created unconditionally earlier in the same
 * migration takes any change. Every other statement is a contract step: it passes only under
 * `-- contract-after: <tag>` naming a release at or before the oldest supported one, the release
 * from which nothing depends on the old shape. A required column without a default and a
 * blocking index build never pass, because an additive form exists for both.
 * @param {{ name: string, text: string, oldestSupportedRelease: string }} input
 * @returns {LintFinding[]}
 */
export function lintMigration({ name, text, oldestSupportedRelease }) {
  const oldest = parseReleaseTag(oldestSupportedRelease);
  if (!oldest) throw new Error(`Invalid oldest supported release ${oldestSupportedRelease}`);
  const migration = parseMigration(text);
  /** @type {LintFinding[]} */
  const findings = migration.malformedBreakpoints.map((line) => ({
    migration: name,
    statement: line,
    rule: "breakpoint",
    message: `A statement breakpoint is exactly "${statementBreakpoint}" at the end of a line; anything after it on the line runs as SQL.`
  }));
  /** @param {MigrationStatement} statement @param {string} rule @param {string} message */
  const reject = (statement, rule, message) =>
    findings.push({ migration: name, statement: statement.sql, rule, message });
  /** @param {MigrationStatement} statement @param {string} rule @param {string} what */
  const contract = (statement, rule, what) => {
    const marker = statement.comments
      .map((comment) => /^\s*contract-after:\s*(\S+)\s*$/u.exec(comment)?.[1])
      .find((tag) => tag !== undefined);
    if (marker === undefined)
      return reject(
        statement,
        rule,
        `${what} is not additive: a release that depends on the old shape breaks. Expand first; contract in a later migration under "-- contract-after: <tag>".`
      );
    const release = parseReleaseTag(marker);
    if (!release)
      return reject(statement, rule, `contract-after must name a release tag such as v1.2.3`);
    if (compareReleases(release, oldest) > 0)
      reject(
        statement,
        rule,
        `${what} waits until the oldest supported release (${oldestSupportedRelease}) reaches ${marker}.`
      );
  };

  /** Tables this migration created unconditionally, before the statement under review. */
  const newTables = new Set();
  const statements = migration.chunks.flatMap((chunk) => chunk.statements);
  for (const statement of statements) {
    const { shape } = statement;
    /** @param {string} pattern */
    const named = (pattern) => {
      const token = new RegExp(pattern, "u").exec(shape)?.[1];
      return token === undefined ? undefined : tableKey(statementName(statement, token));
    };
    // IF NOT EXISTS may find an older table, so only an unconditional create makes a table new.
    const createdTable = named(
      String.raw`^CREATE TABLE (?!IF NOT EXISTS\b)${qualifiedNamePattern}`
    );
    const alteredTable = named(
      String.raw`^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?${qualifiedNamePattern}`
    );
    const indexedTable = named(
      String.raw`^CREATE (?:UNIQUE )?INDEX\b.*?\bON (?:ONLY )?${qualifiedNamePattern}`
    );

    if (indexedTable !== undefined) {
      if (/\bCONCURRENTLY\b/u.test(shape) || newTables.has(indexedTable)) continue;
      reject(
        statement,
        "blocking-index",
        "An index build on an existing table blocks its writes. Put CREATE INDEX CONCURRENTLY IF NOT EXISTS in a migration of its own."
      );
    } else if (additiveCreate.test(shape)) {
      if (createdTable !== undefined) newTables.add(createdTable);
    } else if (/^(?:INSERT|UPDATE)\b/u.test(shape) && !/\b(?:DELETE|TRUNCATE)\b/u.test(shape)) {
      continue;
    } else if (/^COMMENT ON\b/u.test(shape) || repeatableConcurrentIndex.test(shape)) {
      continue;
    } else if (/^ALTER TYPE \S+ ADD VALUE\b/u.test(shape)) {
      continue;
    } else if (alteredTable !== undefined) {
      if (newTables.has(alteredTable)) continue;
      const actions = splitTopLevelCommas(
        shape.replace(
          new RegExp(
            String.raw`^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?${qualifiedNamePattern}\s*\*?\s*`,
            "u"
          ),
          ""
        )
      );
      for (const action of actions) {
        if (/^ADD CONSTRAINT\b/u.test(action)) {
          if (!/\bNOT VALID$/u.test(action))
            contract(statement, "not-additive", "A constraint that is not added NOT VALID");
        } else if (/^ADD (?:PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE)\b/u.test(action)) {
          contract(statement, "not-additive", "A constraint on an existing table");
        } else if (/^ADD\b/u.test(action)) {
          if (/\b(?:UNIQUE|PRIMARY KEY)\b/u.test(action))
            contract(statement, "not-additive", "A unique or primary key column");
          else if (
            /\bNOT NULL\b/u.test(action) &&
            !/\b(?:DEFAULT|GENERATED|(?:SMALL|BIG)?SERIAL)\b/u.test(action)
          )
            reject(
              statement,
              "required-column",
              "A required column without a default fails inserts from a release that does not write it. Add it nullable or with a default."
            );
        } else if (additiveColumnAction.test(action)) {
          continue;
        } else if (/^RENAME\b/u.test(action)) {
          contract(statement, "rename", "A rename");
        } else if (/^DROP (?!CONSTRAINT\b)/u.test(action)) {
          contract(statement, "drop", "A column drop");
        } else if (/\bSET NOT NULL$/u.test(action)) {
          contract(statement, "required-column", "A new NOT NULL on an existing column");
        } else {
          contract(statement, "not-additive", "This change to an existing table");
        }
      }
    } else if (/^DROP\b/u.test(shape)) {
      contract(statement, "drop", "A drop");
    } else if (/^ALTER\b.*\bRENAME\b/u.test(shape)) {
      contract(statement, "rename", "A rename");
    } else {
      contract(statement, "not-additive", "This statement");
    }
  }

  // A concurrent build runs outside a transaction, so a failed run leaves the migration half
  // applied and the next run repeats every statement.
  if (statements.some(runsOutsideTransaction)) {
    for (const statement of statements) {
      if (!repeatableConcurrentIndex.test(statement.shape))
        reject(
          statement,
          "concurrent-index",
          "A migration with a concurrent index build holds only CREATE INDEX CONCURRENTLY IF NOT EXISTS and DROP INDEX CONCURRENTLY IF EXISTS."
        );
    }
    const crowded = migration.chunks.find((chunk) => chunk.statements.length > 1)?.statements[0];
    if (crowded)
      reject(
        crowded,
        "concurrent-index",
        `Separate every statement of a concurrent index migration with "${statementBreakpoint}".`
      );
  }
  return findings;
}

/**
 * @typedef {{ tag: string, when: number }} JournalEntry
 * @param {string | undefined} text
 * @returns {JournalEntry[]}
 */
function journalEntries(text) {
  if (text === undefined) return [];
  /** @type {{ entries: JournalEntry[] }} */
  const journal = JSON.parse(text);
  return journal.entries;
}

/**
 * What the committed migrations are compared against: the merge base with the base branch, and,
 * when the commit under test is that merge base (main itself), the newest release tag as well, so
 * the comparison is never empty on main.
 * @param {{ repoRoot: string, baseRef: string }} input
 * @returns {string[]}
 */
function comparisonBases({ repoRoot, baseRef }) {
  const mergeBase = git(repoRoot, ["merge-base", "HEAD", baseRef]).trim();
  if (mergeBase !== git(repoRoot, ["rev-parse", "HEAD"]).trim()) return [mergeBase];
  try {
    return [mergeBase, previousReleaseTag({ repoRoot })];
  } catch {
    return [mergeBase];
  }
}

/**
 * Lints the journal and every migration that is new: absent from the journal of the comparison
 * base and after the history boundary. History is never linted.
 * @param {{ repoRoot?: string, baseRef: string, path?: string, policy?: MigrationPolicy }} input
 * @returns {LintFinding[]}
 */
export function lintNewMigrations({
  repoRoot = platformRoot,
  baseRef,
  path = migrationsPath,
  policy = readMigrationPolicy()
}) {
  const directory = join(repoRoot, path);
  const entries = journalEntries(readFileSync(join(directory, "meta/_journal.json"), "utf8"));
  const tags = entries.map((entry) => entry.tag);
  /** @type {LintFinding[]} */
  const findings = [];
  /** @param {string} migration @param {string} message */
  const journal = (migration, message) =>
    findings.push({ migration, statement: `${path}/meta/_journal.json`, rule: "journal", message });

  entries.forEach((entry, index) => {
    const previous = entries[index - 1];
    if (tags.indexOf(entry.tag) !== index) journal(entry.tag, "The journal names this tag twice.");
    if (previous && !(entry.when > previous.when))
      journal(
        entry.tag,
        `Its journal timestamp must be greater than that of ${previous.tag}, or a migrated database never applies it.`
      );
    if (!existsSync(join(directory, `${entry.tag}.sql`)))
      journal(entry.tag, "The journal names a migration without a file.");
  });
  for (const file of readdirSync(directory).filter((file) => file.endsWith(".sql")))
    if (!tags.includes(file.slice(0, -".sql".length)))
      journal(file, "The migration is not in the journal, so it never runs.");

  const boundary = tags.indexOf(policy.historyThrough);
  if (boundary < 0)
    throw new Error(`historyThrough names no committed migration: ${policy.historyThrough}`);
  const bases = comparisonBases({ repoRoot, baseRef });
  const base = bases[bases.length - 1];
  const known = new Set(
    journalEntries(gitOptional(repoRoot, ["show", `${base}:${path}/meta/_journal.json`])).map(
      (entry) => entry.tag
    )
  );
  for (const [index, tag] of tags.entries()) {
    if (index <= boundary || known.has(tag) || !existsSync(join(directory, `${tag}.sql`))) continue;
    findings.push(
      ...lintMigration({
        name: tag,
        text: readFileSync(join(directory, `${tag}.sql`), "utf8"),
        oldestSupportedRelease: policy.oldestSupportedRelease
      })
    );
  }
  return findings;
}

/**
 * Committed migrations that differ from a comparison base: changed, removed or renamed files, and
 * journal entries that no longer match. Adding a migration is the only change.
 * @param {{ repoRoot?: string, baseRef: string, path?: string }} input
 * @returns {string[]}
 */
export function findMigrationHistoryChanges({
  repoRoot = platformRoot,
  baseRef,
  path = migrationsPath
}) {
  const journalPath = `${path}/meta/_journal.json`;
  let current = journalEntries(undefined);
  try {
    current = journalEntries(readFileSync(join(repoRoot, journalPath), "utf8"));
  } catch {
    // A missing journal reports every committed entry below.
  }
  /** @type {Set<string>} */
  const changes = new Set();
  for (const base of comparisonBases({ repoRoot, baseRef })) {
    for (const line of git(repoRoot, ["diff", "--name-status", "--find-renames", base, "--", path])
      .split("\n")
      .filter(Boolean)) {
      const [status = "", file = "", renamedTo] = line.split("\t");
      if (!file.endsWith(".sql")) continue;
      if (status.startsWith("M") || status.startsWith("T")) changes.add(`${file} was modified`);
      if (status.startsWith("D")) changes.add(`${file} was removed`);
      if (status.startsWith("R"))
        changes.add(`${file} was renamed to ${renamedTo ?? "another name"}`);
    }
    journalEntries(gitOptional(repoRoot, ["show", `${base}:${journalPath}`])).forEach(
      (entry, index) => {
        if (JSON.stringify(entry) !== JSON.stringify(current[index]))
          changes.add(`${journalPath} no longer records ${entry.tag} as committed`);
      }
    );
  }
  return [...changes];
}

/**
 * The branch migrations are compared against: an explicit ref, else local main, else origin/main.
 * @param {string} [repoRoot]
 */
export function migrationBaseRef(repoRoot = platformRoot) {
  if (process.env.MIGRATIONS_BASE_REF) return process.env.MIGRATIONS_BASE_REF;
  for (const ref of ["main", "origin/main"]) {
    if (gitOptional(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) return ref;
  }
  throw new Error("No main branch to compare migrations against. Set MIGRATIONS_BASE_REF.");
}

/**
 * Unpacks the files of a release tag into a directory, all of them or the given paths.
 * @param {{ tag: string, directory: string, paths?: string[], repoRoot?: string }} input
 */
export function extractRelease({ tag, directory, paths = [], repoRoot = platformRoot }) {
  execFileSync("tar", ["-x", "-C", directory], {
    input: execFileSync("git", ["-C", repoRoot, "archive", tag, ...paths], {
      maxBuffer: 2 ** 31 - 1
    })
  });
}

/** @param {string} repoRoot @param {string[]} args */
export function git(repoRoot, args) {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

/** @param {string} repoRoot @param {string[]} args */
function gitOptional(repoRoot, args) {
  try {
    return git(repoRoot, args);
  } catch {
    return undefined;
  }
}
