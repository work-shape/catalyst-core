import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  diffSkillFolders,
  readSkillImport,
  readSkillSource,
  skillFileOfBytes,
  SkillImportTooLarge,
  zipEntries,
  type SkillFormState,
  type SkillImportEntry
} from "@work-shape/catalyst-chat-ui/build-area";

const MANIFEST =
  "---\nname: form-filler\ndescription: Fills a form.\n---\n\n# Form filler\n\nFill it.\n";
const UNNAMED = "---\ndescription: Fills a form.\n---\n\n# Form filler\n\nFill it.\n";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const MiB = 1024 * 1024;

async function zipOf(
  files: Record<string, string | Uint8Array>,
  options: Record<string, { unixPermissions: number }> = {}
): Promise<File> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) zip.file(path, content, options[path]);
  const bytes = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    platform: "UNIX"
  });
  return new File([bytes], "form-filler.zip");
}

/** An entry whose read the test can watch: it fails the test where it is read unexpectedly. */
function entry(path: string, bytes: Uint8Array | string, size?: number): SkillImportEntry {
  const content = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return {
    path,
    size: size ?? content.byteLength,
    read: async (limit) => {
      if (content.byteLength > limit) throw new SkillImportTooLarge(content.byteLength);
      return content;
    }
  };
}

function unreadable(path: string, size: number | undefined): SkillImportEntry {
  return {
    path,
    size,
    read: () => {
      throw new Error(`${path} was read`);
    }
  };
}

describe("reading a skill from a folder or a .zip", () => {
  it("strips the one top folder, skips what is no part of a skill and names it from SKILL.md", async () => {
    const read = await readSkillSource({
      kind: "zip",
      file: await zipOf({
        "form-filler-main/SKILL.md": MANIFEST,
        "form-filler-main/references/r.md": "# R\n",
        "form-filler-main/scripts/run.py": "print('run')\n",
        "form-filler-main/assets/t.png": PNG,
        "form-filler-main/.DS_Store": "junk",
        "form-filler-main/.git/HEAD": "ref: refs/heads/main\n",
        "form-filler-main/.catalyst-skill.json": "{}",
        "__MACOSX/form-filler-main/._SKILL.md": "junk"
      })
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.skill.files.map((file) => file.path).sort()).toEqual([
      "SKILL.md",
      "assets/t.png",
      "references/r.md",
      "scripts/run.py"
    ]);
    expect(read.skill.files.find((file) => file.path === "assets/t.png")?.bytes).toBe(PNG.length);
    expect(read.skill.form).toMatchObject({
      name: "form-filler",
      title: "Form filler",
      description: "Fills a form."
    });
    const png = read.skill.form.files.find((file) => file.path === "assets/t.png");
    expect(png?.base64).toBeDefined();
    expect(read.skill.form.files.find((file) => file.path === "scripts/run.py")?.text).toBe(
      "print('run')\n"
    );
  });

  // A folder name that is an address is kept as written; another is made into one as the
  // platform makes one: lower case, `_` for a space.
  it("names a skill whose SKILL.md names none after its folder, else after its archive", async () => {
    const inFolder = await readSkillImport("download", [
      entry("pdf-tools/SKILL.md", UNNAMED),
      entry("pdf-tools/references/r.md", "# R\n")
    ]);
    expect(inFolder.ok && inFolder.skill.form.name).toBe("pdf-tools");
    const atTop = await readSkillImport("Report Maker", [entry("SKILL.md", UNNAMED)]);
    expect(atTop.ok && atTop.skill.form.name).toBe("report_maker");
    const named = await readSkillImport("pdf-tools", [
      entry("SKILL.md", "---\nname: pdf_kit\ndescription: Reads PDFs.\n---\nRead.\n")
    ]);
    expect(named.ok && named.skill.form.name).toBe("pdf_kit");
  });

  it("says a folder without SKILL.md at its top is no skill", async () => {
    const read = await readSkillImport("notes", [
      entry("notes/README.md", "# Notes\n"),
      entry("notes/deep/SKILL.md", MANIFEST)
    ]);
    expect(read).toEqual({ ok: false, refusals: [{ reason: "import_no_skill" }] });
  });

  it("refuses a skill whose declared sizes pass the limit before any byte is read", async () => {
    const read = await readSkillImport("big", [
      unreadable("SKILL.md", 1024),
      unreadable("assets/a.bin", 2 * MiB),
      unreadable("assets/b.bin", 2 * MiB),
      unreadable("assets/c.bin", 2 * MiB),
      unreadable("assets/d.bin", 2 * MiB)
    ]);
    expect(read).toEqual({
      ok: false,
      refusals: [{ reason: "skill_too_large", limit: 8 * MiB, actual: 8 * MiB + 1024 }]
    });
  });

  it("refuses a file over its limit by path without reading it", async () => {
    const read = await readSkillImport("big", [
      entry("SKILL.md", MANIFEST),
      unreadable("assets/huge.bin", 2 * MiB + 1)
    ]);
    expect(read).toEqual({
      ok: false,
      refusals: [
        {
          reason: "skill_file_too_large",
          path: "assets/huge.bin",
          limit: 2 * MiB,
          actual: 2 * MiB + 1
        }
      ]
    });
  });

  it("stops reading once the bytes that come pass the limit, whatever was declared", async () => {
    const half = new Uint8Array(1.5 * MiB);
    const read = await readSkillImport("lying", [
      entry("SKILL.md", MANIFEST),
      ...["a", "b", "c", "d", "e", "f"].map((name) => entry(`assets/${name}.bin`, half, 0)),
      unreadable("assets/never.bin", 0)
    ]);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.refusals).toHaveLength(1);
    expect(read.refusals[0]?.reason).toBe("skill_too_large");
  });

  it("stops inflating an archive's entry at the limit it is read with", async () => {
    const opened = await zipEntries(
      await zipOf({ "SKILL.md": MANIFEST, "assets/zeros.bin": new Uint8Array(MiB) })
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const zeros = opened.entries.find((candidate) => candidate.path === "assets/zeros.bin");
    expect(zeros?.size).toBe(MiB);
    await expect(zeros?.read(64 * 1024)).rejects.toBeInstanceOf(SkillImportTooLarge);
    expect((await zeros?.read(MiB))?.byteLength).toBe(MiB);
  });

  it("refuses a link entry of an archive by path", async () => {
    const read = await readSkillSource({
      kind: "zip",
      file: await zipOf(
        { "skill/SKILL.md": MANIFEST, "skill/references/secret.md": "/etc/passwd" },
        { "skill/references/secret.md": { unixPermissions: 0o120777 } }
      )
    });
    expect(read).toEqual({
      ok: false,
      refusals: [{ reason: "import_link", path: "references/secret.md" }]
    });
  });

  it("refuses a compiled program, and a script that is no UTF-8 text, by path", async () => {
    const read = await readSkillImport("skill", [
      entry("SKILL.md", MANIFEST),
      entry("scripts/tool", new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0])),
      entry("scripts/run.py", new Uint8Array([0x70, 0xff, 0xfe, 0x00]))
    ]);
    expect(read).toEqual({
      ok: false,
      refusals: [
        { reason: "skill_file_executable", path: "scripts/tool" },
        { reason: "skill_file_not_text", path: "scripts/run.py" }
      ]
    });
  });

  it("says a file that is no archive cannot be read as one", async () => {
    const read = await readSkillSource({
      kind: "zip",
      file: new File(["not a zip"], "skill.zip")
    });
    expect(read).toEqual({ ok: false, refusals: [{ reason: "import_archive_unreadable" }] });
  });
});

describe("the files a replace of a skill's folder changes", () => {
  const base: SkillFormState = {
    name: "form-filler",
    title: "Form filler",
    description: "Fills a form.",
    summary: "",
    starters: [],
    frontmatter: {},
    content: "# Form filler\n\nFill it.",
    files: []
  };

  it("lists the files added, changed by their hash and removed, and counts the rest", async () => {
    const before: SkillFormState = {
      ...base,
      files: [
        { path: "references/r.md", bytes: 4, text: "# R\n" },
        skillFileOfBytes("assets/t.png", PNG),
        { path: "scripts/run.py", bytes: 13, text: "print('run')\n" }
      ]
    };
    const changedPng = new Uint8Array([...PNG, 1, 2]);
    const after: SkillFormState = {
      ...base,
      files: [
        skillFileOfBytes("assets/t.png", changedPng),
        { path: "scripts/run.py", bytes: 13, text: "print('run')\n" },
        { path: "references/new.md", bytes: 6, text: "# New\n" }
      ]
    };
    const diff = await diffSkillFolders(before, after);
    expect(diff).toEqual({
      added: [{ path: "references/new.md", bytes: 6 }],
      changed: [{ path: "assets/t.png", bytes: changedPng.length, before: PNG.length }],
      removed: [{ path: "references/r.md", bytes: 4 }],
      // SKILL.md and the script.
      unchanged: 2
    });
  });

  it("compares a file the page has not read by the hash the instance stored", async () => {
    const script = "print('run')\n";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script));
    const sha256 = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const diff = await diffSkillFolders(
      { ...base, files: [{ path: "scripts/run.py", bytes: 13, sha256 }] },
      {
        ...base,
        title: "Form filler 2",
        files: [{ path: "scripts/run.py", bytes: 13, text: script }]
      }
    );
    expect(diff.changed.map((file) => file.path)).toEqual(["SKILL.md"]);
    expect(diff.unchanged).toBe(1);
  });
});
