// The expand-and-contract rules for platform migrations: what a new migration may contain, that
// committed migrations never change, and which release a schema change must still serve.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const platformRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const migrationsPath = "packages/postgres-store/migrations";
export const migrationsDirectory = join(platformRoot, migrationsPath);

/**
 * @typedef {{ historyThrough: string, oldestSupportedRelease: string }} MigrationPolicy
 * @typedef {{ migration: string, statement: string, rule: string, message: string }} LintFinding
 * @typedef {{ sql: string, comments: string[], chunk: number }} SqlStatement
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

/**
 * Splits migration text into statements at top-level semicolons and drizzle breakpoints. Comments
 * are returned beside the statement they precede; string contents are blanked so a rule never
 * matches text inside a literal.
 * @param {string} text
 * @returns {SqlStatement[]}
 */
export function splitSqlStatements(text) {
  /** @type {SqlStatement[]} */
  const statements = [];
  let sql = "";
  /** @type {string[]} */
  let comments = [];
  let chunk = 0;
  const end = () => {
    if (sql.trim()) statements.push({ sql: sql.trim().replace(/\s+/gu, " "), comments, chunk });
    sql = "";
    comments = [];
  };
  for (let index = 0; index < text.length;) {
    const rest = text.slice(index);
    const dollarQuote = /^\$[A-Za-z_]*\$/u.exec(rest)?.[0];
    if (rest.startsWith("--")) {
      const line = rest.slice(2, rest.includes("\n") ? rest.indexOf("\n") : undefined);
      if (line.trim() === "> statement-breakpoint") {
        end();
        chunk += 1;
      } else comments.push(line.trim());
      index += 2 + line.length;
    } else if (rest.startsWith("/*")) {
      const close = rest.indexOf("*/");
      const length = close < 0 ? rest.length : close + 2;
      comments.push(rest.slice(2, length - 2).trim());
      index += length;
    } else if (dollarQuote) {
      const close = rest.indexOf(dollarQuote, dollarQuote.length);
      sql += "$$";
      index += close < 0 ? rest.length : close + dollarQuote.length;
    } else if (rest[0] === "'") {
      const literal = /^'(?:[^']|'')*'?/u.exec(rest)?.[0] ?? "'";
      sql += "''";
      index += literal.length;
    } else if (rest[0] === '"') {
      const identifier = /^"(?:[^"]|"")*"?/u.exec(rest)?.[0] ?? '"';
      sql += identifier;
      index += identifier.length;
    } else if (rest[0] === ";") {
      end();
      index += 1;
    } else {
      sql += rest[0];
      index += 1;
    }
  }
  end();
  return statements;
}

/** @param {string} name */
function tableName(name) {
  return name
    .replaceAll('"', "")
    .replace(/^public\./u, "")
    .toLowerCase();
}

/** @param {string} sql */
function splitTopLevelCommas(sql) {
  const parts = [""];
  let depth = 0;
  for (const character of sql) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "," && depth === 0) parts.push("");
    else parts[parts.length - 1] += character;
  }
  return parts.map((part) => part.trim());
}

const identifier = String.raw`((?:"[^"]+"|\w+)(?:\.(?:"[^"]+"|\w+))?)`;
const repeatableConcurrentIndex =
  /^(?:CREATE (?:UNIQUE )?INDEX CONCURRENTLY IF NOT EXISTS|DROP INDEX CONCURRENTLY IF EXISTS)\b/iu;

/**
 * Lints one migration that is not history. A drop, a rename and a new NOT NULL on an existing
 * column are contract steps: they pass only under `-- contract-after: <tag>` naming a release at
 * or before the oldest supported one, the release from which nothing reads the old shape.
 * @param {{ name: string, text: string, oldestSupportedRelease: string }} input
 * @returns {LintFinding[]}
 */
export function lintMigration({ name, text, oldestSupportedRelease }) {
  const oldest = parseReleaseTag(oldestSupportedRelease);
  if (!oldest) throw new Error(`Invalid oldest supported release ${oldestSupportedRelease}`);
  const statements = splitSqlStatements(text);
  const createdTables = new Set(
    statements.flatMap(({ sql }) => {
      const match = new RegExp(
        String.raw`^CREATE (?:UNLOGGED )?TABLE (?:IF NOT EXISTS )?${identifier}`,
        "iu"
      ).exec(sql);
      return match?.[1] ? [tableName(match[1])] : [];
    })
  );
  /** @type {LintFinding[]} */
  const findings = [];
  /** @param {SqlStatement} statement @param {string} rule @param {string} message */
  const reject = (statement, rule, message) =>
    findings.push({ migration: name, statement: statement.sql, rule, message });
  /** @param {SqlStatement} statement @param {string} rule @param {string} what */
  const contract = (statement, rule, what) => {
    const marker = statement.comments
      .map((comment) => /^contract-after:\s*(\S+)\s*$/u.exec(comment)?.[1])
      .find((tag) => tag !== undefined);
    if (marker === undefined)
      return reject(
        statement,
        rule,
        `${what} breaks a release that still uses the old shape. Expand first; contract in a later migration under "-- contract-after: <tag>".`
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

  for (const statement of statements) {
    const { sql } = statement;
    const alteredTable = new RegExp(
      String.raw`^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?${identifier}`,
      "iu"
    ).exec(sql)?.[1];
    const ownTable = alteredTable !== undefined && createdTables.has(tableName(alteredTable));

    if (/^DROP (?:TABLE|SCHEMA|TYPE|VIEW|MATERIALIZED VIEW|SEQUENCE)\b/iu.test(sql))
      contract(statement, "drop", "A drop");
    if (/^ALTER (?:TABLE|TYPE|SCHEMA|VIEW|MATERIALIZED VIEW|SEQUENCE)\b.*\bRENAME\b/iu.test(sql))
      contract(statement, "rename", "A rename");
    if (/^ALTER TYPE\b.*\bDROP ATTRIBUTE\b/iu.test(sql)) contract(statement, "drop", "A drop");

    if (alteredTable !== undefined && !ownTable) {
      for (const action of splitTopLevelCommas(sql)) {
        if (/\bDROP (?!CONSTRAINT\b|NOT NULL\b|DEFAULT\b|EXPRESSION\b|IDENTITY\b)/iu.test(action))
          contract(statement, "drop", "A column drop");
        if (/\bSET NOT NULL\b/iu.test(action))
          contract(statement, "required-column", "A new NOT NULL on an existing column");
        if (
          /\bADD (?!CONSTRAINT\b|PRIMARY\b|UNIQUE\b|CHECK\b|FOREIGN\b|EXCLUDE\b)/iu.test(action) &&
          /\bNOT NULL\b/iu.test(action) &&
          !/\b(?:DEFAULT|GENERATED|(?:SMALL|BIG)?SERIAL)\b/iu.test(action)
        )
          reject(
            statement,
            "required-column",
            "A required column without a default fails inserts from a release that does not write it. Add it nullable or with a default."
          );
      }
    }

    const indexedTable = new RegExp(
      String.raw`^CREATE (?:UNIQUE )?INDEX\b.*?\bON (?:ONLY )?${identifier}`,
      "iu"
    ).exec(sql)?.[1];
    if (
      indexedTable !== undefined &&
      !/\bCONCURRENTLY\b/iu.test(sql) &&
      !createdTables.has(tableName(indexedTable))
    )
      reject(
        statement,
        "blocking-index",
        "An index build on an existing table blocks its writes. Put CREATE INDEX CONCURRENTLY IF NOT EXISTS in a migration of its own."
      );
  }

  // A concurrent build runs outside a transaction, so a failed run leaves the migration half
  // applied and the next run repeats every statement.
  if (statements.some(({ sql }) => /\bCONCURRENTLY\b/iu.test(sql))) {
    const chunks = new Set(statements.map(({ chunk }) => chunk));
    for (const statement of statements) {
      if (!repeatableConcurrentIndex.test(statement.sql))
        reject(
          statement,
          "concurrent-index",
          "A migration with a concurrent index build holds only CREATE INDEX CONCURRENTLY IF NOT EXISTS and DROP INDEX CONCURRENTLY IF EXISTS."
        );
    }
    if (chunks.size !== statements.length) {
      const [first] = statements;
      if (first)
        reject(
          first,
          "concurrent-index",
          'Separate every statement of a concurrent index migration with "--> statement-breakpoint".'
        );
    }
  }
  return findings;
}

/**
 * Lints every committed migration after the history boundary. History is never linted.
 * @param {{ directory?: string, policy?: MigrationPolicy }} [input]
 * @returns {LintFinding[]}
 */
export function lintCommittedMigrations({
  directory = migrationsDirectory,
  policy = readMigrationPolicy()
} = {}) {
  const names = readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .map((file) => file.slice(0, -".sql".length))
    .sort();
  if (!names.includes(policy.historyThrough))
    throw new Error(`historyThrough names no committed migration: ${policy.historyThrough}`);
  return names
    .filter((name) => name > policy.historyThrough)
    .flatMap((name) =>
      lintMigration({
        name,
        text: readFileSync(join(directory, `${name}.sql`), "utf8"),
        oldestSupportedRelease: policy.oldestSupportedRelease
      })
    );
}

/**
 * Committed migrations that differ from the merge base with the base branch: changed, removed or
 * renamed files, and journal entries that no longer match. Adding a migration is the only change.
 * @param {{ repoRoot?: string, baseRef: string, path?: string }} input
 * @returns {string[]}
 */
export function findMigrationHistoryChanges({
  repoRoot = platformRoot,
  baseRef,
  path = migrationsPath
}) {
  const mergeBase = git(repoRoot, ["merge-base", "HEAD", baseRef]).trim();
  const changes = git(repoRoot, ["diff", "--name-status", "--find-renames", mergeBase, "--", path])
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const [status = "", file = "", renamedTo] = line.split("\t");
      if (!file.endsWith(".sql")) return [];
      if (status.startsWith("M") || status.startsWith("T")) return [`${file} was modified`];
      if (status.startsWith("D")) return [`${file} was removed`];
      if (status.startsWith("R")) return [`${file} was renamed to ${renamedTo ?? "another name"}`];
      return [];
    });

  const journalPath = `${path}/meta/_journal.json`;
  const committed = journalEntries(gitOptional(repoRoot, ["show", `${mergeBase}:${journalPath}`]));
  let current = journalEntries(undefined);
  try {
    current = journalEntries(readFileSync(join(repoRoot, journalPath), "utf8"));
  } catch {
    // A missing journal reports every committed entry below.
  }
  committed.forEach((entry, index) => {
    if (entry !== current[index])
      changes.push(`${journalPath} no longer records ${JSON.parse(entry).tag} as committed`);
  });
  return changes;
}

/** @param {string | undefined} text */
function journalEntries(text) {
  if (text === undefined) return [];
  /** @type {{ entries: unknown[] }} */
  const journal = JSON.parse(text);
  return journal.entries.map((entry) => JSON.stringify(entry));
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
