import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runConfigCommand } from "@work-shape/catalyst-cli";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function copy() {
  const root = await mkdtemp(join(tmpdir(), "sf4-limits-"));
  roots.push(root);
  await writeFile(
    join(root, "catalyst.yaml"),
    "instances:\n  local:\n    url: https://catalyst.test\ndefaultInstance: local\nagents: []\nskills: [skills/*/SKILL.md]\n"
  );
  for (const folder of ["references", "scripts", "assets"])
    await mkdir(join(root, "skills/form", folder), { recursive: true });
  for (const path of [
    "SKILL.md",
    "references/r.md",
    "scripts/fill_form.py",
    "assets/template.pdf",
    "assets/logo.png"
  ])
    await writeFile(
      join(root, "skills/form", path),
      path === "SKILL.md" ? "---\nname: form\ndescription: Forms.\n---\n\n# Form\n" : "file"
    );
  return root;
}

describe("CLI skill limits before sending", () => {
  it.each(["size", "count", "ELF", "LFS", "script", "total", "link"])(
    "refuses %s locally before sending",
    async (failure) => {
      const source = await copy();
      let reason: string, path: string;
      if (failure === "count") {
        for (let i = 0; i < 496; i++)
          await writeFile(
            join(source, "skills/form/assets", `${String(i).padStart(3, "0")}.bin`),
            ""
          );
        reason = "skill_too_many_files";
        path = "SKILL.md";
      } else if (failure === "link") {
        path = "assets/link";
        reason = "symbolic link";
        await symlink("logo.png", join(source, "skills/form", path));
      } else {
        path = failure === "script" ? "scripts/bad.py" : "assets/bad.bin";
        const bytes =
          failure === "size"
            ? Buffer.alloc(2 * 1024 * 1024 + 1)
            : failure === "ELF"
              ? Buffer.from([0x7f, 0x45, 0x4c, 0x46])
              : failure === "LFS"
                ? Buffer.from("version https://git-lfs.github.com/spec/v1\n")
                : failure === "total"
                  ? Buffer.alloc(2 * 1024 * 1024)
                  : Buffer.from([0xff]);
        await writeFile(join(source, "skills/form", path), bytes);
        if (failure === "total")
          for (let i = 0; i < 3; i++)
            await writeFile(join(source, "skills/form/assets", `${i}.bin`), bytes);
        if (failure === "total") path = "assets/logo.png";
        reason =
          failure === "size"
            ? "skill_file_too_large"
            : failure === "ELF"
              ? "skill_file_executable"
              : failure === "LFS"
                ? "skill_file_lfs_pointer"
                : failure === "total"
                  ? "skill_too_large"
                  : "skill_file_not_text";
      }
      let calls = 0;
      const err: string[] = [];
      expect(
        await runConfigCommand("push", {
          cwd: source,
          env: { CATALYST_API_KEY: "test" },
          fetchImpl: async () => {
            calls++;
            throw new Error("must not send");
          },
          stderr: (text) => err.push(text)
        })
      ).toBe(1);
      expect(calls).toBe(0);
      expect(err.join("")).toContain(reason);
      expect(err.join("")).toContain(path);
    }
  );
});
