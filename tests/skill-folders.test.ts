import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ApprovalRequestWorkflow } from "@vivd-catalyst/chat-server";
import { createSkillChangePreview, type SkillChangeOperation } from "@vivd-catalyst/config-schema";
import {
  StoreBackedAuditRecorder,
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  asToolCallId,
  type AuthenticatedUser,
  type JsonObject
} from "@vivd-catalyst/core";
import {
  ToolRegistry,
  createReadSkillTool,
  createSkillSourceVersion
} from "@vivd-catalyst/tool-execution";
import { accessOf } from "./support/access";
import { agent } from "./support/access-instance";
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
  useSkillWorlds,
  type SkillFileRead,
  type SkillWorld
} from "./support/skill-folders";
import { createTestToolRunner } from "./support/tool-runner";

// A skill as a folder of real files, walked over the API of an assembled instance: its
// `SKILL.md`, a script and a PDF are written and read back as they were, the agent still
// reads its instructions, what a skill may not hold is refused by its path, a skill written
// as its config stays what it was, and a skill from before all this reads with its history.

const clientInstanceId = asClientInstanceId("demo-local");

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

const folder: JsonObject[] = [
  { path: "SKILL.md", text: SKILL_MD },
  { path: "scripts/fill_form.py", text: SCRIPT },
  { path: "references/guide.md", text: GUIDE },
  { path: "assets/form.pdf", base64: PDF.toString("base64") }
];

const writtenSchema = z.object({
  revision: z.number(),
  fileSetId: z.string().optional(),
  files: z.array(z.object({ path: z.string(), sha256: z.string(), bytes: z.number() })).optional()
});

describe("a skill as a folder of files", () => {
  const { start } = useSkillWorlds();
  type World = SkillWorld;

  const bytesOf = (file: SkillFileRead) =>
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

  it("takes a folder shaped like a skill of a public library as it is: saved, read back byte for byte, titled from its content", async () => {
    const world = await start();
    const address = { kind: "skill", name: "pdf-forms" };
    // The frontmatter of the public convention: a name, a description, and keys of its own.
    const manifest = `---
name: pdf-forms
description: Fill and read PDF forms. Use when a PDF with fields has to be completed.
license: Complete terms in LICENSE.txt
metadata:
  version: "1.2"
  tags: [pdf, forms]
allowed-tools: Bash(python:*) Read
---

# PDF forms guide

Read \`reference.md\`, then run \`scripts/x.py\`.
`;
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(40, 7)
    ]);
    const sent: Record<string, Buffer> = {
      "LICENSE.txt": Buffer.from("Copyright. All rights reserved.\n"),
      "SKILL.md": Buffer.from(manifest),
      "assets/logo.png": png,
      "reference.md": Buffer.from("# Reference\n\nField names.\n"),
      "references/forms.md": Buffer.from("# Forms\n\nWhich form takes which field.\n"),
      "scripts/x.py": Buffer.from("print('x')\n")
    };
    const files = Object.entries(sent).map(([path, bytes]): JsonObject =>
      path.endsWith(".png")
        ? { path, base64: bytes.toString("base64") }
        : { path, text: bytes.toString() }
    );

    const written = await put(world, { files, expectedRevision: null }, address);
    expect(written.statusCode, written.body).toBe(200);
    // Its name and description are of the convention: nothing to warn of.
    expect(z.object({ warnings: z.array(z.unknown()) }).parse(written.json()).warnings).toEqual([]);

    const read = await get(world, true, address);
    expect(read.config).toEqual({
      name: "pdf-forms",
      // No title in the file: the first heading of its content.
      title: "PDF forms guide",
      description: "Fill and read PDF forms. Use when a PDF with fields has to be completed.",
      content: "# PDF forms guide\n\nRead `reference.md`, then run `scripts/x.py`.",
      // Kept as they are and read by nothing.
      frontmatter: {
        license: "Complete terms in LICENSE.txt",
        metadata: { version: "1.2", tags: ["pdf", "forms"] },
        "allowed-tools": "Bash(python:*) Read"
      },
      resources: [
        { path: "LICENSE.txt", mediaType: "text/plain", content: sent["LICENSE.txt"]?.toString() },
        {
          path: "reference.md",
          mediaType: "text/markdown",
          content: sent["reference.md"]?.toString()
        },
        {
          path: "references/forms.md",
          mediaType: "text/markdown",
          content: sent["references/forms.md"]?.toString()
        }
      ],
      files: [
        {
          path: "assets/logo.png",
          sha256: sha256(png),
          bytes: png.byteLength,
          mediaType: "image/png"
        },
        {
          path: "scripts/x.py",
          sha256: sha256(required(sent["scripts/x.py"])),
          bytes: 11,
          mediaType: "text/x-python"
        }
      ]
    });
    const back = required(read.files);
    expect(back.map(({ path }) => path)).toEqual(Object.keys(sent));
    for (const file of back) {
      expect(bytesOf(file).equals(required(sent[file.path])), file.path).toBe(true);
    }

    // The folder written back as it was read is the same folder: a round trip changes no byte.
    const again = await put(
      world,
      {
        files: back.map(({ path, text, base64 }): JsonObject =>
          text === undefined ? { path, base64: base64 ?? "" } : { path, text }
        ),
        expectedRevision: read.revision
      },
      address
    );
    expect(again.statusCode, again.body).toBe(200);
    const twice = await get(world, true, address);
    expect(twice.config).toEqual(read.config);
    expect(required(twice.files).map(({ sha256: hash }) => hash)).toEqual(
      back.map(({ sha256: hash }) => hash)
    );
  });

  it("reads the summary and the starters of a SKILL.md as fields of the skill, and answers a changed summary in the SKILL.md it reads back", async () => {
    const world = await start();
    const address = { kind: "skill", name: "leave-policy" };
    const manifest = `---
name: leave-policy
description: Use for questions on leave.
summary: Knows how leave is granted.
starters:
  - title: Special leave
    prompt: How many days do I get for moving house?
license: MIT
---

# Leave policy

Thirty days a year.
`;
    const sent = [
      { path: "SKILL.md", text: manifest },
      { path: "scripts/days.py", text: "print(30)\n" }
    ];
    const written = await put(world, { files: sent, expectedRevision: null }, address);
    expect(written.statusCode, written.body).toBe(200);
    const read = await get(world, true, address);
    expect(read.config).toMatchObject({
      summary: "Knows how leave is granted.",
      starters: [{ title: "Special leave", prompt: "How many days do I get for moving house?" }],
      frontmatter: { license: "MIT" }
    });
    const manifestOf = (files: SkillFileRead[] | undefined) =>
      required(files).find(({ path }) => path === "SKILL.md")?.text;
    expect(manifestOf(read.files)).toBe(manifest);

    // A write of the config alone with another summary: the stored file no longer says it.
    const changed = { ...read.config, summary: "Knows every kind of leave." };
    const pushed = await put(world, { config: changed, expectedRevision: read.revision }, address);
    expect(pushed.statusCode, pushed.body).toBe(200);
    const after = await get(world, true, address);
    expect(after.config).toEqual(changed);
    expect(manifestOf(after.files)).toContain("summary: Knows every kind of leave.");
    expect(manifestOf(after.files)).toContain("license: MIT");

    // A field of the skill is no further frontmatter of its config.
    const refused = await refusal(
      put(
        world,
        {
          config: { ...changed, frontmatter: { summary: "Knows nothing." } },
          expectedRevision: after.revision
        },
        address
      )
    );
    expect(JSON.stringify(refused)).toContain("Skill frontmatter cannot hold 'summary'");
  });

  it("derives a title from the name where the content has no heading, and warns of a name or a description outside the convention", async () => {
    const world = await start();
    const plain = (name: string, description = "Use it.") => ({
      files: [
        {
          path: "SKILL.md",
          text: `---\nname: ${name}\ndescription: ${description}\n---\n\nJust do it.\n`
        }
      ],
      expectedRevision: null
    });
    const warningsOf = async (name: string, description?: string) => {
      const written = await put(world, plain(name, description), { kind: "skill", name });
      expect(written.statusCode, written.body).toBe(200);
      return z
        .object({ warnings: z.array(z.object({ code: z.string(), message: z.string() })) })
        .parse(written.json())
        .warnings.map(({ code }) => code);
    };

    expect(await warningsOf("3d-print-check")).toEqual([]);
    expect(
      (await get(world, false, { kind: "skill", name: "3d-print-check" })).config
    ).toMatchObject({
      title: "3d print check"
    });
    // What a skill here could always be named stays a name, and is said not to be portable.
    expect(await warningsOf("Legacy_Review.v2")).toEqual(["skill_name_not_portable"]);
    expect(await warningsOf("a".repeat(65))).toEqual(["skill_name_not_portable"]);
    expect(await warningsOf("long-words", "d".repeat(1_025))).toEqual([
      "skill_description_not_portable"
    ]);
    // A config written the old way round is told the same.
    const config = await put(
      world,
      {
        config: { name: "Other_Skill", title: "Other", description: "d", content: "c" },
        expectedRevision: null
      },
      { kind: "skill", name: "Other_Skill" }
    );
    expect(config.json()).toMatchObject({ warnings: [{ code: "skill_name_not_portable" }] });
  });

  it("keeps the files and the frontmatter of a skill through an approved proposal of an agent and through a sync of its config", async () => {
    const world = await start(true, true);
    const { stores } = world.api;
    const manifest = SKILL_MD.replace("title: Form filler\n", "title: Form filler\nlicense: MIT\n");
    expect(
      (
        await put(world, {
          files: [{ path: "SKILL.md", text: manifest }, ...folder.slice(1)],
          expectedRevision: null
        })
      ).statusCode
    ).toBe(200);
    await stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { "agent:assistant": null },
      mutations: [
        {
          type: "upsert",
          kind: "agent",
          name: "assistant",
          config: agent("assistant", {
            toolNames: ["read_skill", "propose_skill_change"],
            skillNames: ["form-filler"]
          })
        },
        // An instance with an agent has a default one.
        { type: "setDefaultAgent", agentName: "assistant" }
      ]
    });
    const before = await get(world);
    const kept = async () => {
      const now = await get(world);
      expect(now.config.files).toEqual(before.config.files);
      expect(now.config.frontmatter).toEqual({ license: "MIT" });
      const pdf = required(required(now.files).find(({ path }) => path === "assets/form.pdf"));
      expect(bytesOf(pdf).equals(PDF)).toBe(true);
      expect(required(now.files).map(({ path }) => path)).toEqual(
        required(before.files).map(({ path }) => path)
      );
      return now;
    };

    // 1. An agent proposes a change of the instructions and a reviewer approves it.
    const person = (id: string, permissions: string[]): AuthenticatedUser => ({
      id,
      externalUserId: id,
      displayLabel: id,
      roles: ["user"],
      permissionRefs: [],
      permissions,
      clientInstanceId,
      authSource: "test"
    });
    const requester = person("requester", []);
    const reviewer = person("reviewer", ["agent_skills.approve"]);
    const workflow = new ApprovalRequestWorkflow({
      clientInstanceId,
      store: stores.approvals,
      handlers: world.execution.approvalRequestHandlers,
      auditRecorder: new StoreBackedAuditRecorder({ clientInstanceId, store: stores.audit })
    });
    const stored = required(
      (await world.execution.assetSource.getSnapshot()).skills.find(
        ({ name }) => name === "form-filler"
      )
    );
    const operations: SkillChangeOperation[] = [
      { type: "replace_text", target: "root", oldText: "Run", newText: "Always run" }
    ];
    const context = { correlationId: "corr_skill_folders" };
    const request = await workflow.createRequest(requester, context, {
      kind: "skill_change",
      summary: "Say it more firmly.",
      payload: z.record(z.string(), z.json()).parse(
        JSON.parse(
          JSON.stringify({
            agentName: "assistant",
            skillName: "form-filler",
            operations,
            baseSourceVersion: createSkillSourceVersion(stored),
            preview: createSkillChangePreview(stored, operations)
          })
        )
      )
    });
    expect(
      await workflow.decideRequest(reviewer, accessOf(reviewer), context, {
        requestId: request.id,
        decision: "approve"
      })
    ).toMatchObject({ status: "approved" });
    const approved = await kept();
    expect(approved.config.content).toContain("Always run `scripts/fill_form.py`");
    expect(required(approved.files).find(({ path }) => path === "SKILL.md")?.text).toContain(
      "Always run"
    );

    // 2. A sync of the config, as a release and today's CLI send it: the text and no file.
    expect(
      (
        await world.api.call("namespaces.create", {
          payload: { prefix: "form-", displayName: "Forms" }
        })
      ).statusCode
    ).toBe(200);
    const { files: _index, frontmatter: _kept, ...text } = approved.config;
    const synced = await world.api.call("assets.sync", {
      payload: {
        namespace: "form-",
        items: [
          {
            type: "put",
            kind: "skill",
            config: { ...text, description: "Use when a form has to be filled." },
            expectedRevision: approved.revision
          }
        ]
      }
    });
    expect(synced.statusCode, synced.body).toBe(200);
    expect((await kept()).config.description).toBe("Use when a form has to be filled.");
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
