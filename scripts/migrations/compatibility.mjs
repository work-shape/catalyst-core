#!/usr/bin/env node
// pnpm test:compatibility: the database tests of the previous release and of the oldest supported
// release, run from checkouts of those tags against the schema of this commit.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import {
  extractRelease,
  git,
  migrationsDirectory,
  platformRoot,
  previousReleaseTag,
  readMigrationPolicy
} from "./policy.mjs";

const adminUrl = process.env.POSTGRES_STORE_TEST_DATABASE_URL;
if (!adminUrl) {
  console.error(
    "test:compatibility needs POSTGRES_STORE_TEST_DATABASE_URL: a disposable Postgres whose role has CREATEDB."
  );
  process.exit(1);
}

const previous = previousReleaseTag();
const oldest = readMigrationPolicy().oldestSupportedRelease;
console.log(`[compatibility] previous release ${previous}, oldest supported release ${oldest}`);
console.log(`[compatibility] head migrations ${migrationsDirectory}`);

for (const tag of new Set([previous, oldest])) {
  const checkout = mkdtempSync(join(tmpdir(), `catalyst-compatibility-${tag}-`));
  try {
    extractRelease({ tag, directory: checkout });
    run(tag, checkout, "pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], {});
    if (existsSync(join(checkout, "tests/support/postgres-fixtures.ts"))) {
      // The release owns migrated fixtures: its whole suite runs, and its test support builds
      // every database from the migrations of this commit.
      run(tag, checkout, "pnpm", ["exec", "vitest", "run"], {
        POSTGRES_STORE_TEST_DATABASE_URL: adminUrl,
        CATALYST_TEST_MIGRATIONS_DIRECTORY: migrationsDirectory
      });
    } else {
      await runGatedDatabaseTests(tag, checkout);
    }
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
}
console.log("[compatibility] passed");

/**
 * A release from before migrated fixtures: its database tests are the files gated by
 * POSTGRES_STORE_TEST_DATABASE_URL, and they share one database migrated to this commit.
 * @param {string} tag
 * @param {string} checkout
 */
async function runGatedDatabaseTests(tag, checkout) {
  const files = git(platformRoot, [
    "grep",
    "-l",
    "POSTGRES_STORE_TEST_DATABASE_URL",
    tag,
    "--",
    "tests/*.test.ts"
  ])
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(`${tag}:`.length));
  if (files.length === 0) throw new Error(`${tag} has no database tests to run`);
  console.log(`[compatibility] ${tag}: ${files.length} database test files`);

  const { migrateDatabase } = await importHeadStore();
  const name = `catalyst_compatibility_${randomUUID().replaceAll("-", "")}`;
  const databaseUrl = new URL(adminUrl ?? "");
  databaseUrl.pathname = `/${name}`;
  const admin = postgres(adminUrl ?? "", { max: 1, onnotice() {} });
  try {
    await admin.unsafe(`create database "${name}" template template0`);
    try {
      const applied = await migrateDatabase({ databaseUrl: databaseUrl.toString() });
      console.log(`[compatibility] ${tag}: database migrated to head (${applied.length} applied)`);
      run(tag, checkout, "pnpm", ["exec", "vitest", "run", ...files], {
        POSTGRES_STORE_TEST_DATABASE_URL: databaseUrl.toString()
      });
    } finally {
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
}

/** @returns {Promise<{ migrateDatabase(input: { databaseUrl: string }): Promise<string[]> }>} */
async function importHeadStore() {
  const entry = join(platformRoot, "packages/postgres-store/dist/index.js");
  if (!existsSync(entry))
    throw new Error("Build @vivd-catalyst/postgres-store first; pnpm test:compatibility does.");
  return import(entry);
}

/**
 * @param {string} tag
 * @param {string} cwd
 * @param {string} command
 * @param {string[]} args
 * @param {Record<string, string>} env
 */
function run(tag, cwd, command, args, env) {
  console.log(`[compatibility] ${tag}: ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: "inherit"
  });
  if (result.status !== 0)
    throw new Error(`${tag}: ${command} ${args[0]} failed against the schema of this commit`);
}
