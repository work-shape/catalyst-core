import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { format, resolveConfig } from "prettier";

/**
 * Workspace tests resolve the same source entries as development builds. Derive them from
 * exports so a new package or subpath has one owner. Capabilities also sees sibling platform.
 * @param {string} root
 * @param {boolean} types whether to select explicit source declarations for TypeScript
 * @returns {Record<string, string>}
 */
export function sourceAliases(root, types = false) {
  /** @type {Record<string, string>} */
  const aliases = {};
  for (const repo of new Set([resolve(root), resolve(root, "../platform")])) {
    for (const group of ["packages", "clients"]) {
      const directory = resolve(repo, group);
      if (!existsSync(directory)) continue;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const manifestFile = resolve(directory, entry.name, "package.json");
        if (!entry.isDirectory() || !existsSync(manifestFile)) continue;
        const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
        /** @type {Record<string, string | { development?: string, types?: string, import?: string }>} */
        const exports = manifest.exports ?? {};
        for (const [subpath, conditions] of Object.entries(exports)) {
          const target =
            typeof conditions === "string"
              ? conditions
              : (conditions.development ??
                (types ? conditions.types : undefined) ??
                conditions.import);
          if (typeof target !== "string" || target.startsWith("./dist/")) continue;
          const name = `${manifest.name}${subpath === "." ? "" : subpath.slice(1)}`;
          if (subpath.includes("*")) {
            // A pattern such as `"./*": { "development": "./src/seams/*.ts" }`: one alias for
            // each file it matches, as Node resolves it.
            for (const [match, file] of patternFiles(resolve(directory, entry.name), target))
              aliases[name.replace("*", match)] = file;
            continue;
          }
          aliases[name] = resolve(directory, entry.name, target);
        }
      }
    }
  }
  // Vite matches prefixes: a subpath must precede its package's root entry.
  return Object.fromEntries(
    Object.entries(aliases).sort(
      ([left], [right]) => right.length - left.length || left.localeCompare(right)
    )
  );
}

/**
 * The files an export pattern's target matches in one folder, with what its `*` stands for.
 * @param {string} packageDir
 * @param {string} target such as `./src/seams/*.ts`
 * @returns {[string, string][]}
 */
function patternFiles(packageDir, target) {
  const star = target.indexOf("*");
  const folder = resolve(packageDir, target.slice(0, target.lastIndexOf("/", star) + 1));
  const prefix = target.slice(target.lastIndexOf("/", star) + 1, star);
  const suffix = target.slice(star + 1);
  if (suffix.includes("/") || !existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((file) => file.startsWith(prefix) && file.endsWith(suffix))
    .map((file) => [file.slice(prefix.length, file.length - suffix.length), resolve(folder, file)]);
}

/**
 * TypeScript requires JSON paths. Keep that generated cache checked by lint; --write is the
 * only update command. Non-package paths (the capabilities test-support seam) stay explicit.
 * @param {string} root
 * @param {boolean} write
 * @returns {Promise<boolean>} whether the checked-in map matches the manifests
 */
export async function syncSourcePaths(root, write = false) {
  const file = resolve(root, "tsconfig.base.json");
  if (!existsSync(file)) return true;
  const config = JSON.parse(readFileSync(file, "utf8"));
  const previous = config.compilerOptions.paths ?? {};
  // Sorted by name, not in Vite's longest-first order: TypeScript prefers the longest match
  // itself, and a new package then lands beside its neighbours by name, not by key length.
  const paths = Object.fromEntries(
    [
      ...Object.entries(previous).filter(([name]) => !name.startsWith("@work-shape/")),
      ...Object.entries(sourceAliases(root, true)).map(([name, target]) => [
        name,
        [relative(root, target).replaceAll("\\", "/")]
      ])
    ].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  );
  // The check ignores the order, so a repository written in the old order still passes; any
  // write puts it in this one.
  const sorted = (/** @type {Record<string, unknown>} */ value) =>
    JSON.stringify(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
  const matches = sorted(previous) === sorted(paths);
  if (write && !matches) {
    config.compilerOptions.paths = paths;
    writeFileSync(
      file,
      await format(JSON.stringify(config), { ...(await resolveConfig(file)), filepath: file })
    );
  }
  return matches;
}
