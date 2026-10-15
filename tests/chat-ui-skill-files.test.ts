import { createHash } from "node:crypto";
import { createElement, createRef } from "react";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createTranslationContext } from "@work-shape/catalyst-chat-ui";
import {
  readBuildRefusal,
  SkillEditor,
  skillConfigToForm,
  skillFileOfBytes,
  skillFolderChanged,
  skillFormToConfig,
  skillFormToFolder,
  withReadFiles,
  withStoredHashes,
  type BuildAsset,
  type BuildAssetEditorProps,
  type SkillFormState
} from "@work-shape/catalyst-chat-ui/build-area";
import type { LocaleCode } from "@work-shape/catalyst-api-client";
import type { JsonObject } from "@work-shape/catalyst-core";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { required } from "./support/assertions";
import {
  GUIDE,
  PDF,
  SCRIPT,
  SKILL,
  get,
  put,
  useSkillWorlds,
  type SkillWorld
} from "./support/skill-folders";

// The skill editor's folder against an assembled instance: the page reads a skill as its
// config and the files its index names, a reader adds, replaces, deletes and edits files, and
// the save writes what the instance reads back byte for byte. A refusal of the instance is
// told with the path of the file it names.

const SKILL_MD = `---
title: Form filler
description: Use when a customer form has to be filled from a case.
license: MIT
---

# Form filler

Run \`scripts/fill_form.py\` on the case and attach \`assets/form.pdf\`.
`;

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** A small PNG: its header holds bytes that are no text. */
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
  "hex"
);
/** The first bytes of an ELF program. */
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00]);

/** Opens the skill as its page does: the config, then the content of the files it indexes. */
async function open(world: SkillWorld): Promise<{ form: SkillFormState; revision: number }> {
  const loaded = await get(world, false);
  const form = skillConfigToForm(loaded.config);
  const { files } = await get(world, true);
  return { form: withReadFiles(form, required(files)), revision: loaded.revision };
}

/** Saves the form as the page does: the folder where a file beside the config changed. */
async function save(
  world: SkillWorld,
  form: SkillFormState,
  baseline: SkillFormState,
  revision: number
) {
  const payload: JsonObject = skillFolderChanged(form, baseline)
    ? { files: skillFormToFolder(form), expectedRevision: revision }
    : {
        config: z.record(z.string(), z.json()).parse(skillFormToConfig(form)),
        expectedRevision: revision
      };
  return put(world, payload);
}

describe("the skill editor's folder", () => {
  const { start } = useSkillWorlds();

  async function written(): Promise<SkillWorld> {
    const world = await start();
    const answer = await put(world, {
      files: [
        { path: "SKILL.md", text: SKILL_MD },
        { path: "scripts/fill_form.py", text: SCRIPT },
        { path: "references/guide.md", text: GUIDE },
        { path: "assets/form.pdf", base64: PDF.toString("base64") }
      ],
      expectedRevision: null
    });
    expect(answer.statusCode, answer.body).toBe(200);
    return world;
  }

  it("reads the files the index names, so a script is text to edit and a PDF is bytes", async () => {
    const world = await written();
    const loaded = await get(world, false);
    const unread = skillConfigToForm(loaded.config);
    expect(unread.files).toEqual([
      { path: "references/guide.md", bytes: Buffer.byteLength(GUIDE), text: GUIDE },
      { path: "assets/form.pdf", bytes: PDF.byteLength, sha256: sha256(PDF) },
      { path: "scripts/fill_form.py", bytes: Buffer.byteLength(SCRIPT), sha256: sha256(SCRIPT) }
    ]);
    const { form } = await open(world);
    expect(form.files.find((file) => file.path === "scripts/fill_form.py")?.text).toBe(SCRIPT);
    expect(form.files.find((file) => file.path === "assets/form.pdf")?.base64).toBe(
      PDF.toString("base64")
    );
    // Reading is no change: a save of the title writes the config, and the files stay.
    expect(skillFolderChanged(form, form)).toBe(false);
  });

  it("writes an upload, a replaced file, a deleted file and an edited script, and keeps the rest", async () => {
    const world = await written();
    const { form: baseline, revision } = await open(world);
    const replaced = Buffer.concat([PDF, Buffer.from("% second version\n", "latin1")]);
    const editedScript = `${SCRIPT}print('done')\n`;
    const form: SkillFormState = {
      ...baseline,
      title: "Form filler, second",
      files: [
        ...baseline.files
          .filter((file) => file.path !== "references/guide.md")
          .map((file) =>
            file.path === "assets/form.pdf"
              ? skillFileOfBytes(file.path, replaced)
              : file.path === "scripts/fill_form.py"
                ? { path: file.path, bytes: Buffer.byteLength(editedScript), text: editedScript }
                : file
          ),
        skillFileOfBytes("assets/logo.png", PNG)
      ]
    };
    expect(skillFolderChanged(form, baseline)).toBe(true);

    const answer = await save(world, form, baseline, revision);
    expect(answer.statusCode, answer.body).toBe(200);

    // The answer names the hash of every file it stored, so the page shows the stored hashes.
    const stored = z
      .object({
        files: z.array(z.object({ path: z.string(), sha256: z.string(), bytes: z.number() }))
      })
      .parse(answer.json()).files;
    expect(
      withStoredHashes(form, stored).files.find((file) => file.path === "assets/logo.png")?.sha256
    ).toBe(sha256(PNG));

    const read = await get(world, true);
    expect(read.config).toMatchObject({
      title: "Form filler, second",
      // The further frontmatter of SKILL.md is written back as it was.
      frontmatter: { license: "MIT" }
    });
    expect(read.config.resources).toBeUndefined();
    const files = required(read.files);
    expect(files.map((file) => [file.path, file.sha256])).toEqual([
      ["SKILL.md", expect.any(String)],
      ["assets/form.pdf", sha256(replaced)],
      ["assets/logo.png", sha256(PNG)],
      ["scripts/fill_form.py", sha256(editedScript)]
    ]);
  });

  it("writes the config alone where only SKILL.md changed, and the files stay", async () => {
    const world = await written();
    const { form: baseline, revision } = await open(world);
    const form: SkillFormState = { ...baseline, content: "# Form filler\n\nFill the form." };
    expect(skillFolderChanged(form, baseline)).toBe(false);
    // An edited reference is a file of the folder: the instance checks it as one.
    const edited = baseline.files.map((file) =>
      file.path === "references/guide.md" ? { ...file, text: "# Guide\n\nShorter.\n" } : file
    );
    expect(skillFolderChanged({ ...baseline, files: edited }, baseline)).toBe(true);

    const answer = await save(world, form, baseline, revision);
    expect(answer.statusCode, answer.body).toBe(200);
    const read = await get(world, true);
    expect(read.config.content).toBe("# Form filler\n\nFill the form.");
    expect(required(read.files).map((file) => file.path)).toEqual([
      "SKILL.md",
      "assets/form.pdf",
      "references/guide.md",
      "scripts/fill_form.py"
    ]);
  });

  it("tells a refused upload with the path the instance names", async () => {
    const world = await written();
    const { form: baseline, revision } = await open(world);
    const form: SkillFormState = {
      ...baseline,
      files: [...baseline.files, skillFileOfBytes("scripts/tool", ELF)]
    };
    const answer = await save(world, form, baseline, revision);
    expect(answer.statusCode).toBe(422);

    const { t } = createTranslationContext("de");
    expect(readBuildRefusal({ payload: answer.json() }, t, "de")).toEqual({
      ok: false,
      conflict: false,
      refusals: [
        {
          field: "files",
          message:
            "scripts/tool ist ein kompiliertes Programm. Ein Skill enthält Skripte als Text, keine Programme."
        }
      ]
    });
    // Nothing was written.
    expect((await get(world, false)).revision).toBe(revision);
  });

  it("tells a refused text file with its path: too large, a Git LFS pointer, a file below a file", async () => {
    const world = await written();
    const { form: baseline, revision } = await open(world);
    const { t } = createTranslationContext("en");
    const refusedWith = async (files: SkillFormState["files"]) => {
      const form = { ...baseline, files };
      expect(skillFolderChanged(form, baseline)).toBe(true);
      const answer = await save(world, form, baseline, revision);
      expect(answer.statusCode, answer.body).toBe(422);
      const outcome = readBuildRefusal({ payload: answer.json() }, t, "en");
      return outcome.ok || outcome.conflict ? undefined : outcome.refusals;
    };

    expect(
      await refusedWith([
        ...baseline.files,
        skillFileOfBytes("assets/large.txt", Buffer.alloc(2 * 1024 * 1024 + 1, "x"))
      ])
    ).toEqual([
      {
        field: "files",
        message: "assets/large.txt has 2,097,153 B. A file of a skill has at most 2 MiB."
      }
    ]);
    expect(
      await refusedWith([
        ...baseline.files,
        skillFileOfBytes(
          "references/pointer.md",
          Buffer.from("version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 12\n")
        )
      ])
    ).toEqual([
      {
        field: "files",
        message:
          "references/pointer.md is a Git LFS pointer, not the file itself. Upload the file itself."
      }
    ]);
    // references/b.md renamed below references/a.md, which is a file itself.
    expect(
      await refusedWith([
        ...baseline.files,
        { path: "references/a.md", bytes: 4, text: "# A\n" },
        { path: "references/a.md/b.md", bytes: 4, text: "# B\n" }
      ])
    ).toEqual([
      {
        field: "files",
        message:
          "references/a.md/b.md lies below references/a.md, which is a file itself. A name is a file or a folder, not both."
      }
    ]);
    // Nothing was written.
    expect((await get(world, false)).revision).toBe(revision);
  });

  it("makes text of UTF-8 bytes and keeps every other file as its bytes", () => {
    expect(skillFileOfBytes("scripts/run.py", Buffer.from("﻿print('ä')\n"))).toEqual({
      path: "scripts/run.py",
      bytes: Buffer.byteLength("﻿print('ä')\n"),
      // The byte order mark stays, so the bytes written are the bytes chosen.
      text: "﻿print('ä')\n"
    });
    expect(skillFileOfBytes("assets/form.pdf", PDF)).toEqual({
      path: "assets/form.pdf",
      bytes: PDF.byteLength,
      base64: PDF.toString("base64")
    });
  });

  it("is the same skill whichever way it was read", () => {
    const config = { name: SKILL.name, title: "T", description: "D", content: "# T" };
    expect(skillFormToConfig(skillConfigToForm(config))).toEqual(config);
  });
});

/** A skill as its page loaded it. */
function storedSkill(config: Record<string, unknown>): BuildAsset {
  return {
    id: "asset_skill",
    kind: "skill",
    name: typeof config.name === "string" ? config.name : "",
    scope: { kind: "instance" },
    revision: 3,
    config,
    updatedAt: "2026-10-08T10:00:00.000Z"
  };
}

/** What the Build frame hands the skill's page: a folder it reads and writes, unless said. */
function frame(overrides: Partial<BuildAssetEditorProps> = {}): BuildAssetEditorProps {
  return {
    page: { ref: createRef<HTMLDivElement>(), above: null, shown: () => undefined },
    asset: undefined,
    start: undefined,
    canWrite: true,
    instanceWrite: true,
    back: null,
    actions: null,
    notice: null,
    onUnsavedChange: () => undefined,
    save: async () => ({ ok: true }),
    folder: { read: async () => [], save: async () => ({ ok: true }) },
    ...overrides
  };
}

function page(config: Record<string, unknown>, overrides: Partial<BuildAssetEditorProps> = {}) {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale: "en" },
      createElement(SkillEditor, {
        frame: frame({ asset: storedSkill(config), ...overrides }),
        initialForm: skillConfigToForm(config),
        editable: true
      })
    )
  );
}

describe("the skill editor's page", () => {
  const config = {
    name: "document_review",
    title: "Document review",
    description: "Review submitted documents.",
    content: "# Review",
    resources: [{ path: "references/checks.md", mediaType: "text/markdown", content: "# Checks" }]
  };

  it("shows the folder as a tree: SKILL.md, and the files below references/, scripts/ and assets/", () => {
    const withFiles = {
      ...config,
      files: [
        {
          path: "assets/template.pdf",
          sha256: "a".repeat(64),
          bytes: 2048,
          mediaType: "application/pdf"
        },
        { path: "scripts/fill.py", sha256: "b".repeat(64), bytes: 12, mediaType: "text/x-python" }
      ]
    };
    const markup = page(withFiles);
    const order = [
      "SKILL.md",
      "references",
      "references/checks.md",
      "scripts",
      "scripts/fill.py",
      "assets",
      "assets/template.pdf"
    ];
    const places = order.map((name) =>
      markup.search(new RegExp(`data-skill-(?:file|folder)="${name}"`, "u"))
    );
    expect(places.every((place) => place >= 0)).toBe(true);
    expect([...places].sort((left, right) => left - right)).toEqual(places);
    // A file is named by its name in its folder.
    expect(markup).toMatch(/data-skill-file="assets\/template.pdf".*?>template\.pdf</u);
    expect(markup).toMatch(/<a href="#files"[^>]*>.*?>4<\/span><\/a>/u);
    // The index names the files without their content. Until the page has read them nothing
    // adds to the folder, so a save of it carries every file.
    expect(markup).not.toContain('aria-label="Add a file to');
  });

  it("offers each folder a file to add, and asks for no media type", () => {
    const markup = page(config);
    for (const folder of ["references", "scripts", "assets"]) {
      expect(markup).toContain(`aria-label="Add a file to ${folder}/"`);
    }
    expect(markup).not.toContain("Media type");
    // A frame that writes the config alone offers no file to add.
    expect(page(config, { folder: undefined })).not.toContain('aria-label="Add a file to');
  });

  it("names a refused file in the files section, in the reader's language", () => {
    const refusal = (reason: string, details: Record<string, unknown>, locale: LocaleCode = "en") =>
      readBuildRefusal(
        { payload: { error: { code: "VALIDATION_FAILED", details: { reason, ...details } } } },
        createTranslationContext(locale).t,
        locale
      );
    expect(
      refusal("skill_file_too_large", {
        path: "assets/big.pdf",
        limit: 2 * 1024 * 1024,
        actual: 3.5 * 1024 * 1024
      })
    ).toEqual({
      ok: false,
      conflict: false,
      refusals: [
        {
          field: "files",
          message: "assets/big.pdf has 3.5 MiB. A file of a skill has at most 2 MiB."
        }
      ]
    });
    expect(
      refusal("skill_too_large", { limit: 8 * 1024 * 1024, actual: 9.25 * 1024 * 1024 }, "de")
    ).toMatchObject({
      refusals: [
        {
          field: "files",
          message: "Die Dateien des Skills haben zusammen 9,3 MiB. Ein Skill hat höchstens 8 MiB."
        }
      ]
    });
    expect(refusal("skill_file_executable", { path: "scripts/tool", format: "ELF" })).toMatchObject(
      {
        refusals: [
          {
            field: "files",
            message: expect.stringMatching(/^scripts\/tool is a compiled program/u)
          }
        ]
      }
    );
    expect(refusal("skill_file_not_text", { path: "scripts/run.py" })).toMatchObject({
      refusals: [
        { field: "files", message: expect.stringMatching(/^scripts\/run\.py is not UTF-8 text/u) }
      ]
    });
    expect(refusal("skill_too_many_files", { limit: 500, actual: 501 })).toMatchObject({
      refusals: [{ message: "The skill has 501 files. A skill has at most 500." }]
    });
  });
});
