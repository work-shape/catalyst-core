// The docs package is a deployable static host root, including provenance from its build.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function inspectDocsPackage(root, version, coreCommit) {
  const problems = [];
  for (const file of [
    "dist/catalyst/index.html",
    "dist/catalyst/404.html",
    "dist/catalyst/pagefind/pagefind.js",
    "dist/catalyst/sitemap-index.xml",
    "dist/robots.txt"
  ]) {
    if (!existsSync(join(root, file))) problems.push(`missing static site file ${file}`);
  }
  try {
    const release = JSON.parse(readFileSync(join(root, "dist/catalyst/release.json"), "utf8"));
    if (release.version !== version) problems.push("docs release version differs from the package");
    if (!/^[0-9a-f]{40}$/u.test(release.coreCommit) || release.coreCommit !== coreCommit)
      problems.push("docs release core commit differs from the release checkout");
  } catch {
    problems.push("missing or invalid docs release provenance");
  }
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    if (Object.keys(manifest[section] ?? {}).length > 0)
      problems.push(`static docs package has runtime ${section}`);
  }
  return problems;
}
