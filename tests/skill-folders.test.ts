import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import {
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  asToolCallId,
  type JsonObject
} from "@vivd-catalyst/core";
import { ToolRegistry, createReadSkillTool } from "@vivd-catalyst/tool-execution";
import { agent } from "./support/access-instance";
import { required } from "./support/assertions";
import { createTestConfig } from "./support/fixtures";
import { createTestInstance, getTestExecution, type TestInstance } from "./support/test-instance";
import { createTestToolRunner } from "./support/tool-runner";

// A skill as a folder of real files, walked over the API of an assembled instance: its
// `SKILL.md`, a script and a PDF are written and read back as they were, the agent still
// reads its instructions, what a skill may not hold is refused by its path, a skill written
// as its config stays what it was, and a skill from before all this reads with its history.

const clientInstanceId = asClientInstanceId("demo-local");
const SKILL = { kind: "skill", name: "form-filler" } as const;

const SKILL_MD = `---
title: Form filler
description: Use when a customer form has to be filled from a case.
---

# Form filler

Run \`scripts/fill_form.py\` on the case and attach \`assets/form.pdf\`.
`;
const SCRIPT = "#!/usr/bin/env python3\nimport sys\n\nprint('filled', sys.argv[1:])\n";
const GUIDE = "# Guide\n\nWhich field takes which value.\n";
/** A small PDF as a program writes one: its second line holds bytes that are no text. */
const PDF = Buffer.concat([
  Buffer.from("%PDF-1.4\n%", "latin1"),
  Buffer.from([0xe2, 0xe3, 0xcf, 0xd3, 0x0a]),
  Buffer.from(
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n" +
      "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
    "latin1"
  )
]);
/** The first bytes of a program compiled for Linux. */
const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.alloc(56)]);

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

const folder: JsonObject[] = [
  { path: "SKILL.md", text: SKILL_MD },
  { path: "scripts/fill_form.py", text: SCRIPT },
  { path: "references/guide.md", text: GUIDE },
  { path: "assets/form.pdf", base64: PDF.toString("base64") }
];

const fileSchema = z.object({
  path: z.string(),
  contentType: z.string(),
  sha256: z.string(),
  bytes: z.number(),
  text: z.string().optional(),
  base64: z.string().optional()
});
const readSchema = z.object({
  config: z.record(z.string(), z.unknown()),
  revision: z.number(),
  files: z.array(fileSchema).optional()
});
const writtenSchema = z.object({
  revision: z.number(),
  fileSetId: z.string().optional(),
  files: z.array(z.object({ path: z.string(), sha256: z.string(), bytes: z.number() })).optional()
});
const refusedSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional()
  })
});

describe("a skill as a folder of files", () => {
  const roots: string[] = [];
  const started: TestInstance[] = [];

  afterEach(async () => {
    await Promise.all(started.splice(0).map((instance) => instance.close()));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  /** An assembled instance and its call path on one database, with or without a store of files. */
  async function start(files = true) {
    const root = await mkdtemp(join(tmpdir(), "skill-folders-test-"));
    roots.push(root);
    const base = createTestConfig({ tools: [{ name: "read_skill", enabled: true }] });
    const config = parseClientInstanceConfig({
      ...base,
      modules: { assetManagement: { enabled: true } },
      administration: { agentConfiguration: { enabled: true, allowSkillEditing: true } },
      ...(files
        ? {
            infrastructure: {
              ...base.infrastructure,
              objectStorage: {
                ...base.infrastructure.objectStorage,
                files: { provider: "filesystem", root }
              }
            }
          }
        : {})
    });
    const api = await createTestInstance({ config, env: {}, tools: [] });
    started.push(api);
    const calls = await createTestInstance({ execution: { config, env: {}, tools: [] } });
    started.push(calls);
    return { api, execution: getTestExecution(calls) };
  }

  type World = Awaited<ReturnType<typeof start>>;

  const put = (
    { api }: World,
    payload: JsonObject,
    address: { kind: string; name: string } = SKILL
  ) => api.call("assets.put", { params: address, payload });
  const get = async (
    { api }: World,
    files = true,
    address: { kind: string; name: string } = SKILL
  ) => {
    const response = await api.call("assets.get", {
      params: address,
      ...(files ? { query: { files: "true" } } : {})
    });
    expect(response.statusCode, response.body).toBe(200);
    return readSchema.parse(response.json());
  };
  const refusal = async (response: ReturnType<World["api"]["call"]>) => {
    const answered = await response;
    expect(answered.statusCode, answered.body).toBe(422);
    return refusedSchema.parse(answered.json()).error;
  };
  const bytesOf = (file: z.infer<typeof fileSchema>) =>
    file.text !== undefined
      ? Buffer.from(file.text, "utf8")
      : Buffer.from(file.base64 ?? "", "base64");

  /** What the agent `assistant` reads of a skill with its tool. */
  async function readSkill({ execution }: World, name: string) {
    const run = createTestToolRunner({
      registry: new ToolRegistry({
        tools: [createReadSkillTool({ assetSource: execution.assetSource })]
      }),
      getAgentToolNames: () => ["read_skill"]
    });
    return run(
      {
        toolName: "read_skill",
        toolCallId: asToolCallId("toolcall_read_skill"),
        agentRunId: asAgentRunId("run_1"),
        conversationId: asConversationId("conv_1"),
        agentName: "assistant",
        input: { name }
      },
      {
        clientInstanceId,
        correlationId: "corr_skill_folders",
        user: {
          id: "user-1",
          externalUserId: "user-1",
          displayLabel: "User",
          roles: ["user"],
          permissionRefs: [],
          clientInstanceId,
          authSource: "test"
        }
      }
    );
  }

  it("is written with a script and a PDF, read back byte for byte with its index, and still read by an agent", async () => {
    const world = await start();

    const written = await put(world, { files: folder, expectedRevision: null });
    expect(written.statusCode, written.body).toBe(200);
    const answer = writtenSchema.parse(written.json());
    expect(answer.fileSetId).toBeDefined();
    expect(answer.files).toEqual([
      { path: "SKILL.md", sha256: sha256(SKILL_MD), bytes: Buffer.byteLength(SKILL_MD) },
      { path: "assets/form.pdf", sha256: sha256(PDF), bytes: PDF.byteLength },
      { path: "references/guide.md", sha256: sha256(GUIDE), bytes: Buffer.byteLength(GUIDE) },
      { path: "scripts/fill_form.py", sha256: sha256(SCRIPT), bytes: Buffer.byteLength(SCRIPT) }
    ]);

    const read = await get(world);
    // The config is what a skill's config always was, with the index of the other files.
    expect(read.config).toEqual({
      name: "form-filler",
      title: "Form filler",
      description: "Use when a customer form has to be filled from a case.",
      content: SKILL_MD.split("---\n\n")[1]?.trim(),
      resources: [{ path: "references/guide.md", mediaType: "text/markdown", content: GUIDE }],
      files: [
        {
          path: "assets/form.pdf",
          sha256: sha256(PDF),
          bytes: PDF.byteLength,
          mediaType: "application/pdf"
        },
        {
          path: "scripts/fill_form.py",
          sha256: sha256(SCRIPT),
          bytes: Buffer.byteLength(SCRIPT),
          mediaType: "text/x-python"
        }
      ]
    });
    const files = required(read.files);
    expect(files.map(({ path }) => path)).toEqual([
      "SKILL.md",
      "assets/form.pdf",
      "references/guide.md",
      "scripts/fill_form.py"
    ]);
    const sent: Record<string, Buffer> = {
      "SKILL.md": Buffer.from(SKILL_MD),
      "assets/form.pdf": PDF,
      "references/guide.md": Buffer.from(GUIDE),
      "scripts/fill_form.py": Buffer.from(SCRIPT)
    };
    for (const file of files) {
      expect(bytesOf(file).equals(required(sent[file.path])), file.path).toBe(true);
      expect(file.sha256, file.path).toBe(sha256(required(sent[file.path])));
    }
    expect(required(files[1]).base64).toBeDefined();

    // The event of the write names each file by its hash and holds no content.
    const events = await world.api.stores.audit.listAuditEvents({
      clientInstanceId,
      type: "config_asset.updated",
      limit: 10
    });
    const event = required(events.find(({ subject }) => subject?.includes("form-filler") ?? true));
    expect(JSON.stringify(event.metadata)).toContain(sha256(PDF));
    expect(JSON.stringify(event)).not.toContain("filled");
    expect(JSON.stringify(event)).not.toContain(PDF.toString("base64").slice(0, 40));

    // An agent that carries the skill reads its instructions as before.
    await world.api.stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { "agent:assistant": null },
      mutations: [
        {
          type: "upsert",
          kind: "agent",
          name: "assistant",
          config: agent("assistant", { toolNames: ["read_skill"], skillNames: ["form-filler"] })
        }
      ]
    });
    expect(await readSkill(world, "form-filler")).toMatchObject({
      status: "success",
      output: {
        name: "form-filler",
        title: "Form filler",
        content: expect.stringContaining("Run `scripts/fill_form.py`"),
        resources: [{ path: "references/guide.md", mediaType: "text/markdown" }]
      }
    });
  });

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
      await refused([
        { path: "assets/tool.exe", base64: Buffer.from("MZ\u0090\0").toString("base64") }
      ])
    ).toMatchObject({ reason: "skill_file_executable", path: "assets/tool.exe", format: "PE" });
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
    ).toMatchObject({ reason: "skill_script_not_text", path: "scripts/run.py" });
    expect(await refused([{ path: "../outside.md", text: "x" }])).toMatchObject({
      reason: "skill_path_invalid",
      path: "../outside.md"
    });
    expect(await refused([{ path: "assets//form.pdf", text: "x" }])).toMatchObject({
      reason: "skill_path_invalid"
    });
    expect(await refused([{ path: "tools/run.py", text: SCRIPT }])).toMatchObject({
      reason: "skill_file_outside_folders",
      path: "tools/run.py"
    });
    expect(await refused([{ path: "photo.png", base64: PDF.toString("base64") }])).toMatchObject({
      reason: "skill_file_outside_folders",
      path: "photo.png"
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

  it("keeps a skill that is written as its config what it was, and leaves the other files of a folder to a write of the config", async () => {
    const world = await start();
    const config = {
      name: "review",
      title: "Review",
      description: "Use when reviewing a case.",
      content: "# Review\n\nCheck the facts.",
      resources: [{ path: "checklist.md", mediaType: "text/markdown", content: "- facts\n" }]
    };
    const address = { kind: "skill", name: "review" };

    // The old way round: a config is put and read back as it was put.
    expect((await put(world, { config, expectedRevision: null }, address)).statusCode).toBe(200);
    const read = await get(world, true, address);
    expect(read.config).toEqual(config);
    expect(required(read.files).map(({ path, text }) => [path, text])).toEqual([
      ["SKILL.md", expect.stringContaining("# Review\n\nCheck the facts.")],
      ["checklist.md", "- facts\n"]
    ]);
    // Its folder, written back as it was read, makes the same config.
    const again = await put(
      world,
      {
        files: required(read.files).map(({ path, text }) => ({ path, text: text ?? "" })),
        expectedRevision: read.revision
      },
      address
    );
    expect(again.statusCode, again.body).toBe(200);
    expect((await get(world, false, address)).config).toEqual(config);

    // A folder with a PDF, and then a write of the config alone, as today's CLI makes it.
    expect((await put(world, { files: folder, expectedRevision: null })).statusCode).toBe(200);
    const before = await get(world);
    const { files: _index, ...text } = before.config;
    const changed = { ...text, content: "# Form filler\n\nAsk for the case number first." };
    const pushed = await put(world, { config: changed, expectedRevision: before.revision });
    expect(pushed.statusCode, pushed.body).toBe(200);
    const after = await get(world);
    expect(after.config).toEqual({ ...changed, files: before.config.files });
    const pdf = required(required(after.files).find(({ path }) => path === "assets/form.pdf"));
    expect(bytesOf(pdf).equals(PDF)).toBe(true);
    expect(required(required(after.files).find(({ path }) => path === "SKILL.md")).text).toContain(
      "Ask for the case number first."
    );

    // The revision before comes back with its own files.
    const reverted = await world.api.call("assets.revert", {
      params: SKILL,
      payload: { revision: before.revision, expectedRevision: after.revision }
    });
    expect(reverted.statusCode, reverted.body).toBe(200);
    const restored = await get(world);
    expect(restored.config).toEqual(before.config);
    expect(required(restored.files).find(({ path }) => path === "SKILL.md")?.text).toBe(SKILL_MD);
  });

  it("holds its text alone on an instance without a store of files, and says so of a file it cannot keep there", async () => {
    const world = await start(false);
    const textOnly = folder.filter(({ path }) => typeof path === "string" && path.endsWith(".md"));

    expect(
      (await refusal(put(world, { files: folder, expectedRevision: null }))).details
    ).toMatchObject({ reason: "files_unavailable" });
    const written = await put(world, { files: textOnly, expectedRevision: null });
    expect(written.statusCode, written.body).toBe(200);
    const read = await get(world);
    expect(read.config).not.toHaveProperty("files");
    expect(required(read.files).map(({ path }) => path)).toEqual([
      "SKILL.md",
      "references/guide.md"
    ]);
  });

  it("reads a skill from before skills held files, with its history, and takes its folder afterwards", async () => {
    const world = await start();
    const { configAssets } = world.api.stores;
    const old = (content: string) => ({
      name: "legacy",
      title: "Legacy",
      description: "A skill from before.",
      content,
      resources: [{ path: "notes/terms.txt", mediaType: "text/plain", content: "net 30\n" }]
    });
    // Two revisions as the store held them then: a config, no file set, no index.
    for (const [base, content] of [
      [null, "First."],
      [1, "Second."]
    ] as const) {
      await configAssets.applyConfigAssetMutations({
        clientInstanceId,
        baseRevisions: { "skill:legacy": base },
        mutations: [{ type: "upsert", kind: "skill", name: "legacy", config: old(content) }]
      });
    }
    const address = { kind: "skill", name: "legacy" };

    const read = await get(world, true, address);
    expect(read.config).toEqual(old("Second."));
    expect(required(read.files).map(({ path, text }) => [path, text])).toEqual([
      ["SKILL.md", expect.stringContaining("Second.")],
      ["notes/terms.txt", "net 30\n"]
    ]);
    const history = await world.api.call("assets.revisions.list", { params: address });
    expect(history.statusCode).toBe(200);
    const revisions = z
      .object({ items: z.array(z.object({ revision: z.number() })) })
      .parse(history.json()).items;
    expect(revisions.map(({ revision }) => revision).sort()).toEqual([1, 2]);

    // Its first revision comes back, and it takes a script beside the resource it had.
    const reverted = await world.api.call("assets.revert", {
      params: address,
      payload: { revision: 1, expectedRevision: 2 }
    });
    expect(reverted.statusCode, reverted.body).toBe(200);
    expect((await get(world, false, address)).config).toEqual(old("First."));
    const current = await get(world, true, address);
    const grown = await put(
      world,
      {
        files: [
          ...required(current.files).map(({ path, text }) => ({ path, text: text ?? "" })),
          { path: "scripts/check.sh", text: "#!/bin/sh\necho ok\n" }
        ],
        expectedRevision: current.revision
      },
      address
    );
    expect(grown.statusCode, grown.body).toBe(200);
    expect((await get(world, true, address)).config).toMatchObject({
      resources: [{ path: "notes/terms.txt" }],
      files: [{ path: "scripts/check.sh" }]
    });
  });
});
