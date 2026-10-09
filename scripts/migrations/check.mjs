#!/usr/bin/env node
// pnpm check:migrations: committed migrations are unchanged, and new ones expand before they
// contract.
import {
  findMigrationHistoryChanges,
  lintNewMigrations,
  migrationBaseRef,
  readMigrationPolicy
} from "./policy.mjs";

const policy = readMigrationPolicy();
const baseRef = migrationBaseRef();
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
