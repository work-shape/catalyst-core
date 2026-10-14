#!/usr/bin/env node
// pnpm check:migrations: new migrations take numbers main has not given out yet, committed
// migrations are unchanged, and new ones expand before they contract.
import {
  findMigrationHistoryChanges,
  findMigrationNumberCollisions,
  lintNewMigrations,
  migrationBaseRef,
  migrationsPath,
  readMigrationPolicy
} from "./policy.mjs";

const policy = readMigrationPolicy();
const baseRef = migrationBaseRef();

// A local main can be behind the remote one, so origin/main is asked as well unless a base was
// named. The first ref that finds a collision answers.
const collisionRefs = process.env.MIGRATIONS_BASE_REF ? [baseRef] : [baseRef, "origin/main"];
for (const ref of new Set(collisionRefs)) {
  const collisions = findMigrationNumberCollisions({ ref });
  if (collisions.length === 0) continue;
  for (const { migration, mainHead } of collisions)
    console.error(
      `${migration}: ${ref} already runs through ${mainHead}, so this number is taken.`
    );
  console.error(
    `\nRenumber: rebase onto ${ref}, delete your migration's SQL and snapshot in ${migrationsPath}, ` +
      `take the journal and snapshots of ${ref}, run \`pnpm db:generate --name <name>\` again ` +
      `(with --custom for a hand-written one) and compare the SQL with your old file.`
  );
  process.exit(1);
}

const changes = findMigrationHistoryChanges({ baseRef });
const findings = lintNewMigrations({ baseRef, policy });

for (const change of changes) console.error(`immutable history: ${change}`);
for (const finding of findings)
  console.error(
    `${finding.migration}: ${finding.rule}: ${finding.message}\n    ${finding.statement}`
  );

if (changes.length > 0 || findings.length > 0) {
  console.error(
    `\nMigration check failed. Committed migrations never change; a schema change is a new migration that keeps ${policy.oldestSupportedRelease} working.`
  );
  process.exit(1);
}
console.log(
  `Migrations are unchanged against ${baseRef}; history runs through ${policy.historyThrough}; later migrations keep ${policy.oldestSupportedRelease} working.`
);
