import { dirname } from "node:path";

/** Shared tooling and its out-of-package inputs affect every quality scope. */
export function isGlobalChange(file, packages) {
  if (file === "quality-baseline.json") return false;
  if (
    file.startsWith("packages/quality-config/") ||
    file.startsWith("packages/model-provider/src/adapters/")
  )
    return true;
  const dir = file.match(/^(?:packages|clients)\/[^/]+/)?.[0];
  if (dir) return !packages.some((pkg) => pkg.dir === dir);
  return !/^(?:README\.md$|CHANGELOG\.md$|tests\/|e2e\/|changes\/|docs\/|\.github\/)/u.test(file);
}

/** Select changed workspace packages and their transitive dependents. */
export function affectedPackages(graph, packages, changed) {
  if (changed.some((file) => isGlobalChange(file, packages)))
    return packages.map((pkg) => pkg.name).sort();
  const names = new Map(packages.map((pkg) => [pkg.dir, pkg.name]));
  const selected = new Set();
  for (const file of changed) {
    const dir = file.match(/^(?:packages|clients)\/[^/]+/)?.[0];
    if (dir && names.has(dir)) selected.add(names.get(dir));
  }
  let previous;
  do {
    previous = selected.size;
    for (const [name, edges] of Object.entries(graph))
      if (edges.some((edge) => selected.has(edge))) selected.add(name);
  } while (selected.size !== previous);
  return [...selected].sort();
}

/** Walk test imports, including test support and re-exports, to the affected package roots. */
export function affectedTests(tests, dependencies, scopes, changed) {
  const changedSet = new Set(changed);
  const reaches = (file, seen) => {
    if (changedSet.has(file) || scopes.some((scope) => file.startsWith(`${scope}/`))) return true;
    if (seen.has(file)) return false;
    seen.add(file);
    return (dependencies.get(file) ?? []).some((next) => reaches(next, seen));
  };
  return tests.filter((file) => reaches(file, new Set())).sort();
}

/** Root files are shared configuration; package directories are complete baseline scopes. */
export function qualityScopes(packages, selected) {
  return packages.filter((pkg) => selected.includes(pkg.name)).map((pkg) => pkg.dir);
}

export function packageDirectory(manifest) {
  return dirname(manifest).replaceAll("\\", "/");
}
