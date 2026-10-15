import { dirname } from "node:path";

/** Select changed workspace packages and their transitive dependents. */
export function affectedPackages(graph, packages, changed) {
  const names = new Map(packages.map((pkg) => [pkg.dir, pkg.name]));
  const selected = new Set();
  for (const file of changed) {
    const dir = file.match(/^(?:packages|clients)\/[^/]+/)?.[0];
    if (dir && names.has(dir)) selected.add(names.get(dir));
    else if (!/^(?:README\.md|CHANGELOG\.md|changes\/|docs\/|\.github\/)/u.test(file))
      return packages.map((pkg) => pkg.name).sort();
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
