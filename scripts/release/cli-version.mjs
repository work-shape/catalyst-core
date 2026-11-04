#!/usr/bin/env node
// `PUBLISHED_CLI_VERSION` names the CLI released with this platform version. The cut sets it to the
// version being cut, since the release publishes the CLI with that version before any deployment
// uses it; `release:check` and a unit test fail when it differs from the CLI package's version.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CLI_VERSION_FILE = "packages/api-contract/src/public-cli.ts";
export const CLI_PACKAGE_MANIFEST = "packages/config-cli/package.json";
const DECLARATION =
  /^(export const PUBLISHED_CLI_VERSION: string \| undefined = )(?:"([^"\n]*)"|undefined);$/mu;

const readText = (root) => readFileSync(join(root, CLI_VERSION_FILE), "utf8");

/** The constant's value, or undefined while it is unset. Throws when the declaration is not found. */
export function readPublishedCliVersion(root) {
  const match = DECLARATION.exec(readText(root));
  if (!match) throw new Error(`${CLI_VERSION_FILE}: PUBLISHED_CLI_VERSION declaration not found.`);
  return match[2];
}

export function setPublishedCliVersion(root, version) {
  const text = readText(root);
  if (!DECLARATION.test(text))
    throw new Error(`${CLI_VERSION_FILE}: PUBLISHED_CLI_VERSION declaration not found.`);
  writeFileSync(
    join(root, CLI_VERSION_FILE),
    text.replace(DECLARATION, (_, head) => `${head}${JSON.stringify(version)};`)
  );
}

export function readCliPackageVersion(root) {
  return JSON.parse(readFileSync(join(root, CLI_PACKAGE_MANIFEST), "utf8")).version;
}

/** Throws when the constant is not the CLI package's version. */
export function checkPublishedCliVersion(root) {
  const published = readPublishedCliVersion(root);
  const released = readCliPackageVersion(root);
  if (published !== released)
    throw new Error(
      `${CLI_VERSION_FILE}: PUBLISHED_CLI_VERSION is ${published === undefined ? "unset" : `"${published}"`}, ` +
        `but ${CLI_PACKAGE_MANIFEST} is ${released}. The CLI is released with the platform version; ` +
        "`pnpm release:cut` sets the constant to the version it cuts."
    );
  return released;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(
      `PUBLISHED_CLI_VERSION ${checkPublishedCliVersion(resolve("."))} matches the CLI package`
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
