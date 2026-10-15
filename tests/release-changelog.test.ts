import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  changesPath,
  foldChanges,
  main,
  parseChange,
  readChanges,
  repoRoot
} from "../scripts/release/changelog.mjs";

const intro = "# Changelog\n\nAll platform packages are released in lockstep.\n\n";
const released = "## 0.6.3 — 2026-10-08\n\n### Fixed\n\n- **Chat:** an old fix.\n";
const unreleased = [
  "## Unreleased",
  "",
  "### Added",
  "",
  "- **Guardrails:** written before change files,",
  "  over two lines.",
  "",
  "### Fixed",
  "",
  "- **Models:** an older fix.",
  "",
  ""
].join("\n");

const change = (section: string, body: string) => `---\nsection: ${section}\n---\n\n${body}\n`;

describe("change files", () => {
  it("reads the section and the entry", () => {
    expect(parseChange("a.md", change("Fixed", "- **Chat:** a fix."))).toEqual({
      file: "a.md",
      section: "Fixed",
      body: "- **Chat:** a fix."
    });
  });

  it("refuses a file the release could not place", () => {
    const errors = (text: string) => {
      const parsed = parseChange("a.md", text);
      return "errors" in parsed ? parsed.errors : [];
    };
    expect(errors("- **Chat:** no front matter.")).toHaveLength(1);
    expect(errors(change("Removed", "- **Chat:** a removal."))).toEqual([
      'section "Removed" is none of Added, Changed, Fixed, Database'
    ]);
    expect(errors("---\nkind: Fixed\n---\n- a\n")).toEqual([
      'front matter holds only "section", not "kind: Fixed"',
      "front matter names no section"
    ]);
    expect(errors(change("Fixed", ""))).toEqual(["holds no entry after the front matter"]);
    expect(errors(change("Fixed", "A sentence."))).toHaveLength(1);
    expect(errors(change("Fixed", "- a\n\n### Fixed\n\n- b"))).toHaveLength(1);
  });
});

describe("folding change files into the changelog", () => {
  const fix = { file: "b.md", section: "Fixed", body: "- **Chat:** a new fix." };
  const changes = [
    fix,
    { file: "c.md", section: "Changed", body: "- **Build:** a change,\n  over two lines." },
    { file: "d.md", section: "Added", body: "- **Data Stores:** an addition." }
  ];

  it("leaves a changelog without change files as it is", () => {
    const changelog = intro + unreleased + released;
    expect(foldChanges(changelog, []).text).toBe(changelog);
  });

  it("puts each entry after the Unreleased entries of its section, sections in order", () => {
    const { text, section } = foldChanges(
      intro + unreleased + released,
      changes,
      "## 0.7.0 — 2026-10-20"
    );
    expect(text).toBe(
      intro +
        [
          "## 0.7.0 — 2026-10-20",
          "",
          "### Added",
          "",
          "- **Guardrails:** written before change files,",
          "  over two lines.",
          "- **Data Stores:** an addition.",
          "",
          "### Changed",
          "",
          "- **Build:** a change,",
          "  over two lines.",
          "",
          "### Fixed",
          "",
          "- **Models:** an older fix.",
          "- **Chat:** a new fix.",
          "",
          ""
        ].join("\n") +
        released
    );
    expect(text.startsWith(intro + section)).toBe(true);
  });

  it("writes the section before the newest release when there is no Unreleased section", () => {
    expect(foldChanges(intro + released, [fix], "## 0.6.4 — 2026-10-09").text).toBe(
      intro + "## 0.6.4 — 2026-10-09\n\n### Fixed\n\n- **Chat:** a new fix.\n\n" + released
    );
  });
});

describe("the changelog command", () => {
  const roots: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function repository(files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), "catalyst-changelog-"));
    roots.push(root);
    mkdirSync(join(root, changesPath), { recursive: true });
    writeFileSync(join(root, "CHANGELOG.md"), intro + unreleased + released);
    writeFileSync(join(root, changesPath, ".gitkeep"), "");
    for (const [file, text] of Object.entries(files))
      writeFileSync(join(root, changesPath, file), text);
    return root;
  }

  const quiet = () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  };

  it("folds the files under the version and deletes them, keeping the folder", () => {
    quiet();
    const root = repository({ "feat-chat.md": change("Fixed", "- **Chat:** a new fix.") });
    expect(main(["--check"], root)).toBe(0);
    expect(main(["--release", "0.7.0", "--date", "2026-10-20"], root)).toBe(0);
    const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    expect(changelog).toContain("## 0.7.0 — 2026-10-20\n");
    expect(changelog).toContain("- **Models:** an older fix.\n- **Chat:** a new fix.\n");
    expect(changelog).not.toContain("## Unreleased");
    expect(existsSync(join(root, changesPath, "feat-chat.md"))).toBe(false);
    expect(existsSync(join(root, changesPath, ".gitkeep"))).toBe(true);
    expect(readChanges(root)).toEqual({ changes: [], errors: [] });
  });

  it("stops before writing when a file is malformed or the version is missing", () => {
    quiet();
    const root = repository({
      "good.md": change("Fixed", "- **Chat:** a fix."),
      "notes.txt": "no Markdown"
    });
    expect(main(["--check"], root)).toBe(1);
    expect(main(["--release", "0.7.0"], root)).toBe(1);
    expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toContain("## Unreleased");
    rmSync(join(root, changesPath, "notes.txt"));
    expect(main(["--release"], root)).toBe(1);
    expect(main(["--release", "seven"], root)).toBe(1);
    expect(main(["--release", "0.7.0", "--date", "20.10.2026"], root)).toBe(1);
    expect(existsSync(join(root, changesPath, "good.md"))).toBe(true);
  });

  it.each([["--typo", "--check"], ["--check", "--roots", "."], ["stray"], ["--date"]])(
    "refuses unknown or incomplete arguments: %j",
    (...args) => {
      quiet();
      const root = repository({ "good.md": change("Fixed", "- A fix.") });
      const before = readFileSync(join(root, "CHANGELOG.md"), "utf8");
      expect(main(args, root)).toBe(1);
      expect(console.error).toHaveBeenCalled();
      expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toBe(before);
      expect(existsSync(join(root, changesPath, "good.md"))).toBe(true);
    }
  );

  it("holds well-formed change files in this repository", () => {
    expect(readChanges(repoRoot).errors).toEqual([]);
  });

  it("checks a companion root without reading the core's change files", () => {
    quiet();
    const root = repository({ "bad.md": "malformed companion change" });
    expect(main(["--root", root, "--check"])).toBe(1);
    rmSync(join(root, changesPath, "bad.md"));
    expect(main(["--root", root, "--check"])).toBe(0);
    expect(main(["--root"])).toBe(1);
  });
});
