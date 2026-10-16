// Keep only the closure of the public importers before asking pnpm to normalize the lock.
// Filtering importers alone leaves every closed-package snapshot in a pnpm v9 lockfile.
import { parse, stringify } from "yaml";
import { PUBLIC_PACKAGE_DIRS } from "./package-metadata.mjs";

const SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"];

export function publicLockfile(content) {
  const lock = parse(content);
  if (lock.lockfileVersion !== "9.0" || typeof lock.settings?.autoInstallPeers !== "boolean")
    throw new Error("Expected pnpm v9 lockfile with autoInstallPeers");
  const importers = { ".": {} };
  for (const dir of PUBLIC_PACKAGE_DIRS) {
    const key = `packages/${dir}`;
    if (!lock.importers?.[key]) throw new Error(`Missing public importer ${key}`);
    importers[key] = lock.importers[key];
  }
  const snapshots = {};
  const packages = {};
  const visit = (name, reference) => {
    if (reference.startsWith("link:")) {
      if (!PUBLIC_PACKAGE_DIRS.some((dir) => reference === `link:../${dir}`))
        throw new Error(`Public lock links outside the public workspace: ${reference}`);
      return;
    }
    // npm aliases already carry the real name in their resolution.
    const key = lock.snapshots?.[`${name}@${reference}`] ? `${name}@${reference}` : reference;
    if (Object.hasOwn(snapshots, key)) return;
    const snapshot = lock.snapshots?.[key];
    if (!snapshot) throw new Error(`Missing public dependency snapshot ${name}@${reference}`);
    const packageKey = key.split("(")[0];
    if (!lock.packages?.[packageKey]) throw new Error(`Missing public package ${packageKey}`);
    snapshots[key] = snapshot;
    packages[packageKey] = lock.packages[packageKey];
    for (const section of ["dependencies", "optionalDependencies"])
      for (const [dependency, version] of Object.entries(snapshot[section] ?? {}))
        visit(dependency, version);
  };
  for (const importer of Object.values(importers))
    for (const section of SECTIONS)
      for (const [name, resolution] of Object.entries(importer[section] ?? {}))
        visit(name, resolution.version);
  const sorted = (entries) =>
    Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
  return {
    autoInstallPeers: lock.settings.autoInstallPeers,
    content: stringify({
      lockfileVersion: lock.lockfileVersion,
      settings: lock.settings,
      ...(lock.overrides ? { overrides: lock.overrides } : {}),
      importers,
      packages: sorted(packages),
      snapshots: sorted(snapshots)
    })
  };
}
