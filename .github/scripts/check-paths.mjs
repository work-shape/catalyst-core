import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Read manifests before installation; include build-time and optional workspace dependencies. */
export function browserDependencyPaths(root = fileURLToPath(new URL("../../", import.meta.url))) {
  const packages = new Map();
  for (const group of ["packages", "clients"]) {
    for (const directory of readdirSync(join(root, group))) {
      const path = `${group}/${directory}/`;
      const manifest = join(root, path, "package.json");
      if (existsSync(manifest)) {
        const pkg = JSON.parse(readFileSync(manifest, "utf8"));
        packages.set(pkg.name, { path, ...pkg });
      }
    }
  }
  const paths = new Set();
  const visit = (name) => {
    const pkg = packages.get(name);
    if (!pkg || paths.has(pkg.path)) return;
    paths.add(pkg.path);
    for (const dependency of Object.keys({
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
      ...pkg.optionalDependencies
    }))
      visit(dependency);
  };
  for (const name of ["@work-shape/catalyst-demo", "@work-shape/catalyst-server"]) {
    if (!packages.has(name)) throw new Error(`Missing browser workspace: ${name}`);
    visit(name);
  }
  return [...paths];
}

const browserPaths = browserDependencyPaths();

/** Conservative job selection: unknown paths and shared configuration run everything. */
export function selectChecks(files, event = "pull_request") {
  const full = { code: true, browser: true, images: true };
  if (event !== "pull_request" || files.length === 0) return full;
  const isManifest = (file) => /(^|\/)package\.json$/u.test(file);
  const isLock = (file) => /(^|\/)(?:[^/]*lock[^/]*\.(?:yaml|json)|yarn\.lock)$/u.test(file);
  const isDocs = (file) =>
    file.startsWith("packages/docs/") ||
    file.startsWith("changes/") ||
    (file.endsWith(".md") && !/^packages\/[^/]+\/src\//u.test(file));
  const isConfig = (file) =>
    /(^|\/)(?:[^/]*[.-])?config(?:[./-]|$)/u.test(file) || /(^|\/)tsconfig[^/]*\.json$/u.test(file);
  const everything = files.some(
    (file) =>
      file.startsWith(".github/") ||
      file.startsWith("scripts/") ||
      file.startsWith("packages/quality-config/") ||
      isLock(file) ||
      isConfig(file) ||
      (!file.includes("/") && !isDocs(file)) ||
      (!isDocs(file) && !/^(?:packages|clients|tests|e2e|docker)\//u.test(file))
  );
  if (everything) return full;
  const affectsBrowserWorkspace = (file) =>
    !isDocs(file) && browserPaths.some((path) => file.startsWith(path));
  return {
    code: files.some((file) => !isDocs(file) || isManifest(file)),
    browser: files.some(
      (file) =>
        affectsBrowserWorkspace(file) ||
        (!isDocs(file) && /^(?:e2e\/|tests\/fixtures\/)/u.test(file))
    ),
    images: files.some(
      (file) =>
        affectsBrowserWorkspace(file) ||
        file.startsWith("docker/") ||
        /(^|\/)Dockerfile(?:[.-]|$)|\.Dockerfile$/u.test(file) ||
        isManifest(file) ||
        isLock(file)
    )
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = process.env.EVENT;
  let files = [];
  if (event === "pull_request") {
    const git = (args) => execFileSync("git", args, { encoding: "utf8" });
    const base = git(["merge-base", process.env.BASE, process.env.HEAD]).trim();
    // No rename detection: both the deleted source and new target affect job selection.
    // NUL delimiters also handle file names containing whitespace or newlines.
    files = git(["diff", "--name-only", "--no-renames", "-z", base, process.env.HEAD])
      .split("\0")
      .filter(Boolean);
  }
  const selected = selectChecks(files, event);
  console.log({ files, selected });
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(selected)
      .map(([job, enabled]) => `${job}=${enabled}\n`)
      .join("")
  );
}
