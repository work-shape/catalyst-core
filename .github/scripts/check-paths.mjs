import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

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
  return {
    code: files.some((file) => !isDocs(file) || isManifest(file)),
    browser: files.some(
      (file) =>
        !isDocs(file) &&
        /^(?:packages\/(?:ui|chat-ui|chat-server)\/|clients\/demo\/|e2e\/|tests\/fixtures\/)/u.test(
          file
        )
    ),
    images: files.some(
      (file) =>
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
