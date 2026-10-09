import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findMigrationHistoryChanges,
  lintNewMigrations,
  lintMigration,
  migrationsDirectory,
  migrationsPath,
  previousReleaseTag,
  readMigrationPolicy
} from "../scripts/migrations/policy.mjs";

const oldestSupportedRelease = "v1.4.0";
const rules = (text: string) =>
  lintMigration({ name: "0100_probe", text, oldestSupportedRelease }).map(({ rule }) => rule);

describe("migration lint", () => {
  it("passes the additive forms", () => {
    expect(
      rules(`
        -- A comment that says DROP TABLE, RENAME and CONCURRENTLY changes nothing.
        CREATE TABLE "notes" ("id" text PRIMARY KEY NOT NULL, "body" text NOT NULL);--> statement-breakpoint
        CREATE INDEX "notes_body_idx" ON "notes" USING btree ("body");--> statement-breakpoint
        ALTER TABLE "notes" ADD COLUMN "pinned" boolean NOT NULL;--> statement-breakpoint
        ALTER TABLE "notes" ADD CONSTRAINT "notes_body_unique" UNIQUE("body");--> statement-breakpoint
        CREATE TYPE "note_kind" AS ENUM ('plain');--> statement-breakpoint
        ALTER TABLE "conversations" ADD COLUMN "summary" text;--> statement-breakpoint
        ALTER TABLE "conversations" ADD COLUMN "kind" text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
        ALTER TABLE "conversations" ADD COLUMN "rename" text, ADD COLUMN "drop" text;--> statement-breakpoint
        ALTER TABLE "conversations" ALTER COLUMN "title" DROP NOT NULL;--> statement-breakpoint
        ALTER TABLE "conversations" ALTER COLUMN "summary" SET DEFAULT 'DROP DEFAULT';--> statement-breakpoint
        ALTER TABLE "conversations" ADD CONSTRAINT "c_note_fk" FOREIGN KEY ("summary") REFERENCES "notes"("id") NOT VALID;--> statement-breakpoint
        ALTER TABLE "conversations" VALIDATE CONSTRAINT "c_note_fk";--> statement-breakpoint
        COMMENT ON COLUMN "conversations"."summary" IS 'TRUNCATE';--> statement-breakpoint
        INSERT INTO "notes" ("id", "body") VALUES ('n', 'DELETE FROM notes');--> statement-breakpoint
        UPDATE "conversations" SET "summary" = 'DROP TABLE; RENAME COLUMN' WHERE "summary" IS NULL;
      `)
    ).toEqual([]);
    expect(
      rules(`
        CREATE INDEX CONCURRENTLY IF NOT EXISTS "conversations_summary_idx" ON "conversations" ("summary");--> statement-breakpoint
        DROP INDEX CONCURRENTLY IF EXISTS "conversations_old_idx";
      `)
    ).toEqual([]);
  });

  it("rejects drops, renames, required columns and blocking index builds", () => {
    expect(rules(`DROP TABLE "conversations";`)).toEqual(["drop"]);
    expect(rules(`DROP INDEX "conversations_owner_idx";`)).toEqual(["drop"]);
    expect(rules(`ALTER TABLE "conversations" DROP COLUMN "title";`)).toEqual(["drop"]);
    expect(rules(`ALTER TABLE conversations DROP title;`)).toEqual(["drop"]);
    expect(rules(`ALTER TABLE "conversations" RENAME TO "threads";`)).toEqual(["rename"]);
    expect(rules(`ALTER TABLE "conversations" RENAME COLUMN "title" TO "name";`)).toEqual([
      "rename"
    ]);
    expect(rules(`ALTER TYPE "note_kind" RENAME VALUE 'plain' TO 'text';`)).toEqual(["rename"]);
    expect(rules(`ALTER TABLE "conversations" ADD COLUMN "kind" text NOT NULL;`)).toEqual([
      "required-column"
    ]);
    expect(rules(`ALTER TABLE "conversations" ALTER COLUMN "summary" SET NOT NULL;`)).toEqual([
      "required-column"
    ]);
    expect(rules(`CREATE INDEX "c_idx" ON "conversations" USING btree ("title");`)).toEqual([
      "blocking-index"
    ]);
    expect(
      rules(`CREATE UNIQUE INDEX IF NOT EXISTS c_idx ON public.conversations (title);`)
    ).toEqual(["blocking-index"]);
  });

  it.each([
    `TRUNCATE "conversations";`,
    `DELETE FROM "conversations" WHERE "title" IS NULL;`,
    `WITH gone AS (DELETE FROM "messages" RETURNING "id") UPDATE "conversations" SET "title" = '';`,
    `ALTER TABLE "conversations" ALTER COLUMN "title" TYPE varchar(80);`,
    `ALTER TABLE "conversations" ALTER COLUMN "title" SET DATA TYPE varchar(80);`,
    `ALTER TABLE "conversations" ALTER COLUMN "title" DROP DEFAULT;`,
    `ALTER TABLE "conversations" SET SCHEMA "archive";`,
    `ALTER TABLE "conversations" DROP CONSTRAINT "conversations_title_unique";`,
    `ALTER TABLE "conversations" ADD UNIQUE ("title");`,
    `ALTER TABLE "conversations" ADD PRIMARY KEY ("id");`,
    `ALTER TABLE "conversations" ADD CONSTRAINT "c_title_unique" UNIQUE ("title");`,
    `ALTER TABLE "conversations" ADD CONSTRAINT "c_fk" FOREIGN KEY ("title") REFERENCES "notes"("id");`,
    `ALTER TABLE "conversations" ADD COLUMN "slug" text UNIQUE;`,
    `DO $$ BEGIN DROP TABLE "conversations"; END $$;`,
    `CREATE OR REPLACE VIEW "recent" AS SELECT 1;`,
    `SELECT pg_terminate_backend(1);`
  ])("refuses what is not a known additive form: %s", (statement) => {
    expect(rules(statement)).toEqual(["not-additive"]);
    expect(rules(`-- contract-after: v1.4.0\n${statement}`)).toEqual([]);
    expect(rules(`-- contract-after: v1.4.1\n${statement}`)).toEqual(["not-additive"]);
  });

  it("treats a table as new only after its unconditional create in the same migration", () => {
    expect(
      rules(`
        CREATE TABLE IF NOT EXISTS "notes" ("id" text PRIMARY KEY NOT NULL);--> statement-breakpoint
        ALTER TABLE "notes" ADD COLUMN "body" text NOT NULL;--> statement-breakpoint
        CREATE INDEX "notes_body_idx" ON "notes" ("body");
      `)
    ).toEqual(["required-column", "blocking-index"]);
    expect(
      rules(`
        CREATE INDEX "notes_body_idx" ON "notes" ("body");--> statement-breakpoint
        CREATE TABLE "notes" ("id" text PRIMARY KEY NOT NULL, "body" text);
      `)
    ).toEqual(["blocking-index"]);
  });

  it("splits where the migration step splits and refuses a malformed breakpoint", () => {
    expect(
      rules(
        `ALTER TABLE "conversations" ADD COLUMN "a" text;--> statement-breakpoint DROP TABLE "x";`
      )
    ).toEqual(["breakpoint", "drop"]);
    expect(
      rules(`ALTER TABLE "conversations" ADD COLUMN "a" text;\n-->statement-breakpoint\nSELECT 1;`)
    ).toEqual(["breakpoint", "not-additive"]);
    expect(
      rules(`ALTER TABLE "conversations" ADD COLUMN "a" text;--> statement-breakpoint  \n`)
    ).toEqual([]);
  });

  it("keeps a concurrent index build in a repeatable migration of its own", () => {
    expect(rules(`CREATE INDEX CONCURRENTLY "c_idx" ON "conversations" ("title");`)).toEqual([
      "concurrent-index"
    ]);
    expect(
      rules(`
        ALTER TABLE "conversations" ADD COLUMN "summary" text;--> statement-breakpoint
        CREATE INDEX CONCURRENTLY IF NOT EXISTS "c_idx" ON "conversations" ("summary");
      `)
    ).toEqual(["concurrent-index"]);
    expect(
      rules(`
        CREATE INDEX CONCURRENTLY IF NOT EXISTS "a_idx" ON "conversations" ("title");
        CREATE INDEX CONCURRENTLY IF NOT EXISTS "b_idx" ON "conversations" ("status");
      `)
    ).toEqual(["concurrent-index"]);
  });

  it("allows a contract step once the oldest supported release reached its marker", () => {
    const contract = (tag: string) =>
      rules(`
        -- contract-after: ${tag}
        ALTER TABLE "conversations" DROP COLUMN "owner_user_id";--> statement-breakpoint
        -- contract-after: ${tag}
        ALTER TABLE "conversations" RENAME COLUMN "name" TO "title";--> statement-breakpoint
        -- contract-after: ${tag}
        ALTER TABLE "conversations" ALTER COLUMN "summary" SET NOT NULL;
      `);
    expect(contract("v1.3.9")).toEqual([]);
    expect(contract("v1.4.0")).toEqual([]);
    expect(contract("v1.4.1")).toEqual(["drop", "rename", "required-column"]);
    expect(contract("next")).toEqual(["drop", "rename", "required-column"]);
  });

  it("gives a marker to the statement it precedes only, and none to forms that never pass", () => {
    expect(
      rules(`
        -- contract-after: v1.0.0
        DROP TABLE "old_notes";
        DROP TABLE "conversations";
      `)
    ).toEqual(["drop"]);
    expect(
      rules(`
        DROP TABLE "conversations";
        -- contract-after: v1.0.0
      `)
    ).toEqual(["drop"]);
    expect(
      rules(`
        -- contract-after: v1.0.0
        CREATE INDEX "c_idx" ON "conversations" ("title");--> statement-breakpoint
        -- contract-after: v1.0.0
        ALTER TABLE "conversations" ADD COLUMN "kind" text NOT NULL;
      `)
    ).toEqual(["blocking-index", "required-column"]);
  });

  it("rejects migration 0021 as it was committed, read without editing it", () => {
    const text = readFileSync(
      join(migrationsDirectory, "0021_conversation_creator_attribution.sql"),
      "utf8"
    );
    expect(text).not.toContain("contract-after");
    const findings = lintMigration({
      name: "0021_conversation_creator_attribution",
      text,
      oldestSupportedRelease: readMigrationPolicy().oldestSupportedRelease
    });
    expect(findings.map(({ rule, statement }) => [rule, statement])).toEqual([
      [
        "rename",
        'ALTER TABLE "conversations" RENAME COLUMN "owner_user_id" TO "created_by_user_id"'
      ],
      [
        "rename",
        'ALTER TABLE "conversations" RENAME COLUMN "owner_external_user_id" TO "created_by_external_user_id"'
      ],
      ["drop", 'DROP INDEX "conversations_owner_idx"'],
      ["drop", 'DROP INDEX "conversations_owner_user_idx"']
    ]);
  });

  it("holds the policy of this repository", () => {
    expect(readMigrationPolicy()).toEqual({
      historyThrough: "0031_user_model_preference",
      oldestSupportedRelease: "v0.6.3"
    });
  });
});

describe("a repository's migrations and release tags", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function repository() {
    const root = mkdtempSync(join(tmpdir(), "catalyst-migration-policy-"));
    roots.push(root);
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        ["-C", root, "-c", "user.name=test", "-c", "user.email=test@example.test", ...args],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
      );
    const write = (file: string, content: string) => {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), content);
    };
    const journal = (...tags: (string | { tag: string; when: number })[]) =>
      write(
        `${migrationsPath}/meta/_journal.json`,
        JSON.stringify({
          entries: tags.map((entry, idx) =>
            typeof entry === "string" ? { idx, when: idx + 1, tag: entry } : { idx, ...entry }
          )
        })
      );
    const commit = (message: string) => {
      git("add", "-A");
      git("-c", "commit.gpgsign=false", "commit", "-m", message);
    };
    git("init", "--initial-branch=main");
    write(`${migrationsPath}/0000_first.sql`, "create table first (id text);");
    write(`${migrationsPath}/0001_second.sql`, "drop table committed_before_the_rules;");
    journal("0000_first", "0001_second");
    commit("committed migrations");
    git("switch", "-c", "change");
    return { root, git, write, journal, commit };
  }

  it("accepts a branch that only adds a migration", () => {
    const repo = repository();
    repo.write(`${migrationsPath}/0002_third.sql`, "create table third (id text);");
    repo.journal("0000_first", "0001_second", "0002_third");
    repo.commit("add a migration");
    expect(findMigrationHistoryChanges({ repoRoot: repo.root, baseRef: "main" })).toEqual([]);
  });

  it("rejects a modified, a removed and a renamed committed migration", () => {
    const modified = repository();
    modified.write(`${migrationsPath}/0000_first.sql`, "create table first (id uuid);");
    modified.commit("edit history");
    expect(findMigrationHistoryChanges({ repoRoot: modified.root, baseRef: "main" })).toEqual([
      `${migrationsPath}/0000_first.sql was modified`
    ]);

    const removed = repository();
    rmSync(join(removed.root, migrationsPath, "0001_second.sql"));
    removed.journal("0000_first");
    removed.commit("remove history");
    expect(findMigrationHistoryChanges({ repoRoot: removed.root, baseRef: "main" })).toEqual([
      `${migrationsPath}/0001_second.sql was removed`,
      `${migrationsPath}/meta/_journal.json no longer records 0001_second as committed`
    ]);

    const renamed = repository();
    renameSync(
      join(renamed.root, migrationsPath, "0001_second.sql"),
      join(renamed.root, migrationsPath, "0001_renamed.sql")
    );
    renamed.journal("0000_first", "0001_renamed");
    renamed.commit("rename history");
    expect(findMigrationHistoryChanges({ repoRoot: renamed.root, baseRef: "main" })).toEqual([
      `${migrationsPath}/0001_second.sql was renamed to ${migrationsPath}/0001_renamed.sql`,
      `${migrationsPath}/meta/_journal.json no longer records 0001_second as committed`
    ]);
  });

  it("rejects a change that is not committed yet", () => {
    const repo = repository();
    repo.write(`${migrationsPath}/0001_second.sql`, "drop table something_else;");
    expect(findMigrationHistoryChanges({ repoRoot: repo.root, baseRef: "main" })).toEqual([
      `${migrationsPath}/0001_second.sql was modified`
    ]);
  });

  const policy = { historyThrough: "0000_first", oldestSupportedRelease: "v1.4.0" };
  const lint = (root: string) =>
    lintNewMigrations({ repoRoot: root, baseRef: "main", policy }).map(
      ({ migration, rule }) => `${migration}: ${rule}`
    );

  it("lints the migrations the base journal lacks, whatever their names", () => {
    const repo = repository();
    expect(lint(repo.root)).toEqual([]);
    repo.write(`${migrationsPath}/0000_a_name_before_history.sql`, "drop table first;");
    repo.write(`${migrationsPath}/0002_third.sql`, "create table third (id text);");
    repo.journal("0000_first", "0001_second", "0000_a_name_before_history", "0002_third");
    expect(lint(repo.root)).toEqual(["0000_a_name_before_history: drop"]);
    repo.commit("add migrations");
    expect(lint(repo.root)).toEqual(["0000_a_name_before_history: drop"]);
  });

  it("requires unique tags, increasing timestamps and a journal entry for every file", () => {
    const repo = repository();
    repo.write(`${migrationsPath}/0002_third.sql`, "create table third (id text);");
    repo.write(`${migrationsPath}/0003_unlisted.sql`, "create table unlisted (id text);");
    repo.journal(
      "0000_first",
      "0001_second",
      { tag: "0002_third", when: 2 },
      { tag: "0002_third", when: 3 },
      { tag: "0004_missing", when: 4 }
    );
    expect(lint(repo.root)).toEqual([
      "0002_third: journal",
      "0002_third: journal",
      "0004_missing: journal",
      "0003_unlisted.sql: journal"
    ]);
  });

  it("compares main itself against the newest release tag", () => {
    const repo = repository();
    repo.git("switch", "main");
    repo.git("-c", "tag.gpgsign=false", "tag", "v1.0.0");
    repo.write(`${migrationsPath}/0000_first.sql`, "create table first (id uuid);");
    repo.write(`${migrationsPath}/0002_third.sql`, "truncate first;");
    repo.journal("0000_first", "0001_second", "0002_third");
    repo.commit("merged to main after the release");
    expect(findMigrationHistoryChanges({ repoRoot: repo.root, baseRef: "main" })).toEqual([
      `${migrationsPath}/0000_first.sql was modified`
    ]);
    expect(lint(repo.root)).toEqual(["0002_third: not-additive"]);
  });

  it("finds the newest release tag reachable from the commit under test", () => {
    const repo = repository();
    const tag = (name: string) => repo.git("-c", "tag.gpgsign=false", "tag", name);
    expect(() => previousReleaseTag({ repoRoot: repo.root })).toThrow("No release tag");
    tag("v0.9.0");
    tag("v0.10.0");
    tag("vnext");
    repo.git("switch", "main");
    repo.write("unreachable", "a release the change branch does not contain");
    repo.commit("later release");
    tag("v1.0.0");
    expect(previousReleaseTag({ repoRoot: repo.root })).toBe("v1.0.0");
    expect(previousReleaseTag({ repoRoot: repo.root, ref: "change" })).toBe("v0.10.0");
  });
});
