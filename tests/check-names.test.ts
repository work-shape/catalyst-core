import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

// A stand-in name, so this file names no customer: its digest plays the denied list.
const NAME = "acmewidget";
const digest = (word: string) => createHash("sha256").update(word).digest("hex");
const script = resolve("scripts/check-names.mjs");
const repos: string[] = [];

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "check-names-"));
  repos.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args], {
      cwd: dir
    });
  git("init", "-q", "-b", "main");
  mkdirSync(join(dir, "tests/support"), { recursive: true });
  writeFileSync(join(dir, "tests/support/name-hashes.ts"), `const denied = ["${digest(NAME)}"];\n`);
  writeFileSync(join(dir, "README.md"), "plain\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  return { dir, git };
}

function check(dir: string, ...args: string[]) {
  const run = spawnSync("node", [script, ...args], { cwd: dir, encoding: "utf8" });
  return { status: run.status, output: run.stdout + run.stderr };
}

afterEach(() => {
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("passes a change that names nobody", () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "a.ts"), "export const builder = 'Musterbau';\n");
  git("add", ".");
  git("commit", "-q", "-m", "feat: a neutral example");
  expect(check(dir, "--range", "main~1..main").status).toBe(0);
});

it.each([
  [
    "an added line, in any spelling",
    "notes.md",
    "We built this for Acme Widget.\n",
    "chore: notes",
    "notes.md:1"
  ],
  ["a commit message", "b.md", "neutral\n", "fix: the acmewidget import", "message"],
  ["a new file path", `docs/${NAME}.md`, "neutral\n", "docs: page", `path docs/`]
])(
  "refuses a name in %s, and says where without repeating it",
  (_, file, content, message, where) => {
    const { dir, git } = repo();
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, file), content);
    git("add", ".");
    git("commit", "-q", "-m", message);
    const result = check(dir, "--range", "main~1..main");
    expect(result.status).toBe(1);
    expect(result.output).toContain(where);
    expect(result.output.toLowerCase().replace(`docs/${NAME}.md`, "")).not.toMatch(/acme ?widget/u);
  }
);

it("refuses a name in a pull request's title or body", () => {
  const { dir } = repo();
  const event = join(dir, "event.json");
  writeFileSync(
    event,
    JSON.stringify({
      pull_request: { title: "Fix", body: "Asked by AcmeWidget.", head: { ref: "fix/x" } }
    })
  );
  const result = check(dir, "--range", "main..main", "--event", event);
  expect(result.status).toBe(1);
  expect(result.output).toContain("pull request body");
});

it("reads the denied list from the base, so removing a digest does not pass", () => {
  const { dir, git } = repo();
  // The change keeps a list, only without this name's digest.
  writeFileSync(
    join(dir, "tests/support/name-hashes.ts"),
    `const denied = ["${digest("other")}"];\n`
  );
  writeFileSync(join(dir, "c.md"), "for acmewidget\n");
  git("add", ".");
  git("commit", "-q", "-m", "chore: tidy");
  expect(check(dir, "--range", "main~1..main").status).toBe(1);
});

it("the real denied list is not empty and matches the test helper", () => {
  const result = check(resolve("."), "--text", "README.md");
  expect(result.status).toBe(0);
  expect(result.output).toMatch(/1 places checked/u);
});
