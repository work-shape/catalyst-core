// The browser suite's instance config: tests/fixtures/e2e-app.yaml with each spec's own people
// from tests/fixtures/e2e-users/<spec>.yaml put in place of its `# @e2e-users` line, in file name
// order. A spec adds its people in a file of its own, so two specs never edit the same lines.
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const platformRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const e2eFixturePath = join(platformRoot, "tests/fixtures/e2e-app.yaml");
export const e2eUsersDirectory = join(platformRoot, "tests/fixtures/e2e-users");
/** Where a caller that names no path of its own gets the composed config. */
export const composedE2eConfigPath = join(platformRoot, ".tmp/e2e/e2e-app.yaml");

const MARKER = "      # @e2e-users";

/** The composed config as text, comments kept. Throws on a missing marker or a repeated email. */
export function composeE2eConfig({
  fixturePath = e2eFixturePath,
  usersDirectory = e2eUsersDirectory
} = {}) {
  const fixture = readFileSync(fixturePath, "utf8");
  const lines = fixture.split("\n");
  const at = lines.indexOf(MARKER);
  if (at === -1 || lines.indexOf(MARKER, at + 1) !== -1) {
    throw new Error(`${fixturePath} must hold the line "${MARKER.trim()}" exactly once`);
  }
  const files = readdirSync(usersDirectory)
    .filter((file) => file.endsWith(".yaml"))
    .sort();
  const added = [];
  for (const file of files) {
    const text = readFileSync(join(usersDirectory, file), "utf8");
    const users = parse(text);
    if (!Array.isArray(users) || users.length === 0) {
      throw new Error(`e2e-users/${file} must be a list of seed users`);
    }
    added.push(
      ...text
        .trimEnd()
        .split("\n")
        .map((line) => (line ? `      ${line}` : line))
    );
  }
  const composed = [...lines.slice(0, at), ...added, ...lines.slice(at + 1)].join("\n");

  const seen = new Map();
  for (const user of parse(composed).auth.standalone.seedUsers) {
    const email = String(user.email).toLowerCase();
    if (seen.has(email)) throw new Error(`seed user ${email} is listed twice`);
    seen.set(email, true);
  }
  return composed;
}

/**
 * Writes the composed config to `path` and returns the path. The file is replaced in one rename,
 * so a process reading it while another writes it never reads half of it.
 */
export function writeE2eConfig(path = composedE2eConfigPath, text = composeE2eConfig()) {
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.${process.pid}.partial`;
  writeFileSync(partial, text);
  renameSync(partial, path);
  return path;
}
