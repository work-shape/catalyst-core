import { describe, expect, it } from "vitest";
import type { JsonObject } from "@vivd-catalyst/core";
import { required } from "./support/assertions";
import {
  GUIDE,
  PDF,
  SCRIPT,
  SKILL,
  SKILL_MD,
  get,
  put,
  refusal,
  useSkillWorlds
} from "./support/skill-folders";

// What a skill's folder may not hold, asked over the API of an assembled instance: each file
// is refused by its path with a reason of its own before anything is written, and a file that
// only looks like what is refused is taken.

/** A program compiled for Windows: `MZ`, and where that header says, `PE` and two zero bytes. */
const PE = Buffer.alloc(0x48);
PE.write("MZ", 0, "latin1");
PE.writeUInt32LE(0x40, 0x3c);
PE.write("PE\0\0", 0x40, "latin1");
/** The first bytes of a program compiled for Linux. */
const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.alloc(56)]);

describe("what a skill's folder may not hold", () => {
  const { start } = useSkillWorlds();

  it("refuses what a skill may not hold, each with its path and a reason of its own, and writes nothing", async () => {
    const world = await start();
    const manifest = { path: "SKILL.md", text: SKILL_MD };
    const refused = async (files: JsonObject[]) =>
      (await refusal(put(world, { files: [manifest, ...files], expectedRevision: null }))).details;
    const lfs = "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 12\n";

    expect(await refused([{ path: "assets/tool", base64: ELF.toString("base64") }])).toMatchObject({
      reason: "skill_file_executable",
      path: "assets/tool",
      format: "ELF"
    });
    expect(
      await refused([{ path: "assets/tool.exe", base64: PE.toString("base64") }])
    ).toMatchObject({ reason: "skill_file_executable", path: "assets/tool.exe", format: "PE" });
    // A path a disk does not hold as a name, and a path that is a file and a folder at once.
    expect(await refused([{ path: `assets/${"n".repeat(480)}.txt`, text: "x" }])).toMatchObject({
      reason: "skill_path_invalid"
    });
    expect(
      await refused([
        { path: "a", base64: PDF.toString("base64") },
        { path: "a/b.py", text: SCRIPT }
      ])
    ).toMatchObject({ reason: "skill_path_duplicate", path: "a/b.py" });
    expect(
      await refused([
        { path: "Docs/guide.md", text: GUIDE },
        { path: "docs", text: "x" }
      ])
    ).toMatchObject({ reason: "skill_path_duplicate" });
    // A frontmatter of nested aliases is refused at once, at any number of levels.
    for (const levels of [5, 6, 7, 12]) {
      const lines = ["l0: &l0 [x, x, x, x, x, x, x, x, x, x]"];
      for (let level = 1; level < levels; level += 1) {
        lines.push(
          `l${level}: &l${level} [${Array.from({ length: 10 }, () => `*l${level - 1}`).join(", ")}]`
        );
      }
      const bomb = `---\nname: form-filler\ndescription: d\n${lines.join("\n")}\nmetadata: *l${levels - 1}\n---\n\nText.\n`;
      const start = performance.now();
      const answered = await refusal(
        put(world, { files: [{ path: "SKILL.md", text: bomb }], expectedRevision: null })
      );
      expect(performance.now() - start, `${levels} levels`).toBeLessThan(2_000);
      expect(answered.details, `${levels} levels`).toMatchObject({
        reason: "skill_frontmatter_alias",
        path: "SKILL.md"
      });
    }
    expect(
      await refused([
        {
          path: "assets/tool.dylib",
          base64: Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7]).toString("base64")
        }
      ])
    ).toMatchObject({ reason: "skill_file_executable", format: "Mach-O" });
    expect(await refused([{ path: "assets/large.bin", text: lfs }])).toMatchObject({
      reason: "skill_file_lfs_pointer",
      path: "assets/large.bin"
    });
    expect(
      await refused([
        { path: "scripts/run.py", base64: Buffer.from([0xff, 0xfe, 0x41]).toString("base64") }
      ])
    ).toMatchObject({ reason: "skill_file_not_text", path: "scripts/run.py" });
    // A text by its extension is UTF-8 wherever it lies. A file of another extension is bytes.
    expect(
      await refused([
        { path: "notes/readme.txt", base64: Buffer.from([0xff, 0xfe, 0x41]).toString("base64") }
      ])
    ).toMatchObject({ reason: "skill_file_not_text", path: "notes/readme.txt" });
    // A file under scripts/ is a script and text, whatever its extension.
    expect(
      await refused([
        { path: "scripts/helper", base64: Buffer.from([0xff, 0xfe, 0x00, 0x41]).toString("base64") }
      ])
    ).toMatchObject({ reason: "skill_file_not_text", path: "scripts/helper" });
    // An absolute path, and two paths that differ in case alone.
    expect(await refused([{ path: "/etc/passwd", text: "x" }])).toMatchObject({
      reason: "skill_path_invalid",
      path: "/etc/passwd"
    });
    // A NUL in a path is refused by the contract of the call, before the skill reads it.
    expect(await refused([{ path: "assets/a\u0000.md", text: "x" }])).toMatchObject({
      issues: [{ message: "A name must not contain a NUL byte", path: ["files", 1, "path"] }]
    });
    expect(
      await refused([
        { path: "references/A.md", text: GUIDE },
        { path: "references/a.md", text: GUIDE }
      ])
    ).toMatchObject({ reason: "skill_path_duplicate", path: "references/a.md" });
    expect(await refused([{ path: "docs/SKILL.md", text: SKILL_MD }])).toMatchObject({
      reason: "skill_path_invalid",
      path: "docs/SKILL.md"
    });
    expect(await refused([{ path: "../outside.md", text: "x" }])).toMatchObject({
      reason: "skill_path_invalid",
      path: "../outside.md"
    });
    expect(await refused([{ path: "assets//form.pdf", text: "x" }])).toMatchObject({
      reason: "skill_path_invalid"
    });
    expect(
      await refused([
        { path: "assets/big.bin", base64: Buffer.alloc(2 * 1024 ** 2 + 1, 1).toString("base64") }
      ])
    ).toMatchObject({ reason: "skill_file_too_large", path: "assets/big.bin" });
    expect(
      await refused(
        Array.from({ length: 5 }, (_, index) => ({
          path: `assets/part-${index}.bin`,
          base64: Buffer.alloc(1_700_000, 1).toString("base64")
        }))
      )
    ).toMatchObject({ reason: expect.stringMatching(/^(skill_too_large|files_too_large)$/u) });
    // More files than a skill holds: the call itself takes no more.
    expect(
      (
        await refusal(
          put(world, {
            files: [
              manifest,
              ...Array.from({ length: 500 }, (_, index) => ({
                path: `assets/n-${index}.txt`,
                text: "x"
              }))
            ],
            expectedRevision: null
          })
        )
      ).code
    ).toBe("VALIDATION_FAILED");
    expect(
      (
        await refusal(
          put(world, {
            files: [{ path: "scripts/fill_form.py", text: SCRIPT }],
            expectedRevision: null
          })
        )
      ).details
    ).toMatchObject({ reason: "skill_manifest_missing" });

    const missing = await world.api.call("assets.get", { params: SKILL });
    expect(missing.statusCode).toBe(404);
  });

  it("refuses a SKILL.md whose frontmatter is no YAML with the line and the column, and says to quote a value with a colon", async () => {
    const world = await start();
    const refused = async (frontmatter: string) =>
      refusal(
        put(world, {
          files: [
            { path: "SKILL.md", text: `---\nname: form-filler\n${frontmatter}\n---\n\nT.\n` }
          ],
          expectedRevision: null
        })
      );

    const colon = await refused("description: Use this when: the user asks");
    expect(colon.message).toContain("line 3, column");
    expect(colon.message).toContain("in quotes");
    expect(colon.details).toMatchObject({
      reason: "skill_manifest_invalid",
      path: "SKILL.md",
      issues: [{ line: 3, column: expect.any(Number), message: expect.any(String) }]
    });
    for (const [shape, frontmatter] of [
      ["a key written twice", "description: d\nlicense: MIT\nlicense: Apache-2.0"],
      ["a tag the reader does not know", "description: d\nmetadata: !!python/object:os.system x"],
      ["a tag of the file's own", "description: d\nmetadata: !mine x"]
    ] as const) {
      expect((await refused(frontmatter)).details, shape).toMatchObject({
        reason: "skill_manifest_invalid",
        issues: [{ line: expect.any(Number), column: expect.any(Number) }]
      });
    }
    const deep = await refused(
      `description: d\nmetadata: ${"[".repeat(5_000)}${"]".repeat(5_000)}`
    );
    expect(deep.details?.reason).toMatch(/^skill_(frontmatter_too_deep|manifest_invalid)$/u);

    expect((await world.api.call("assets.get", { params: SKILL })).statusCode).toBe(404);
  });

  it("takes a text that begins with the letters MZ, which a program for Windows begins with too", async () => {
    const world = await start();
    const notes = "MZ is the abbreviation the form uses for the reference number.\n";
    const written = await put(world, {
      files: [
        { path: "SKILL.md", text: SKILL_MD },
        { path: "references/abbreviations.txt", text: notes },
        {
          path: "assets/MZ-codes.bin",
          base64: Buffer.from(`MZ${"\u0001".repeat(80)}`, "latin1").toString("base64")
        }
      ],
      expectedRevision: null
    });
    expect(written.statusCode, written.body).toBe(200);
    expect(
      required((await get(world)).files).find(({ path }) => path === "references/abbreviations.txt")
        ?.text
    ).toBe(notes);
  });
});
