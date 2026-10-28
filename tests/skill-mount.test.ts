import * as fs from "node:fs/promises";
import { mkdtemp, readFile, readdir, rm, chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { skillConfigSchema } from "@work-shape/catalyst-config-schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  asAgentRunId,
  asConversationId,
  asExecutionWorkspaceId,
  asToolCallId,
  asWorkspaceCommandId,
  type AgentRunId,
  type ConversationId,
  type PlatformStores,
  type SkillFolderReader,
  type JsonObject,
  type ToolExecutionContext
} from "@work-shape/catalyst-core";
import { createSkillFolderReader } from "@work-shape/catalyst-server";
import {
  createReadSkillTool,
  createSkillSourceVersion,
  DockerWorkspaceCommandProcessExecutor,
  LocalWorkspaceCommandProcessExecutor,
  LocalWorkspaceCommandRunner,
  ToolRegistry,
  WorkspaceCommandService,
  type DockerCommandRunInput,
  type ProcessResult,
  type WorkspaceCommandProcessExecutor
} from "@work-shape/catalyst-tool-execution";
import { createFilesystemObjectStorage } from "@work-shape/catalyst-object-storage";
import { agent, clientInstanceId } from "./support/access-instance";
import { runnerContainer } from "./support/runner-container";
import { put, useSkillWorlds, type SkillWorld } from "./support/skill-folders";
import { createStoredConfigAssetSource } from "./support/static-config-asset-source";
import { fileTestDatabaseUrl } from "./support/test-database";
import { addTestStoreHelpers, type TestStoreHelpers } from "./support/test-store";
import { createTestToolRunner } from "./support/tool-runner";
import { inlineCommandResults, runQueuedCommands } from "./support/workspace-command-jobs";

// A skill's folder in the sandbox of a workspace command (SF-3): every command of an agent run
// finds the skills that run may read, whole and read-only, at /skills/<name>/, each at the
// revision that was live when the command was queued. Walked over an assembled instance, its
// database and its `files` store, with a Docker client that records what it is asked to start,
// with the local sandbox, and, where a runner image is named, with Docker itself:
//   CATALYST_RUNNER_IMAGE=<image> pnpm exec vitest run tests/skill-mount.test.ts

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, mkdir: vi.fn(actual.mkdir) };
});

const SKILL_MD = `---
name: form
description: Use when a PDF form has to be filled.
---

# Form

Run \`python /skills/form/scripts/fill_form.py /skills/form/assets/template.pdf artifacts/out.pdf\`.
`;
const SCRIPT = `import sys

source, target = sys.argv[1], sys.argv[2]
with open(source, "rb") as handle:
    data = handle.read()
with open(target, "wb") as handle:
    handle.write(data.replace(b"{{NAME}}", b"Ada Lovelace"))
print("filled", target)
`;
/** A PDF with a field to fill and bytes that are no text. */
const TEMPLATE = Buffer.concat([
  Buffer.from("%PDF-1.4\n%", "latin1"),
  Buffer.from([0xe2, 0xe3, 0xcf, 0xd3, 0x0a]),
  Buffer.from("1 0 obj<</T({{NAME}})>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n", "latin1")
]);
const FILLED = Buffer.from(
  TEMPLATE.toString("latin1").replace("{{NAME}}", "Ada Lovelace"),
  "latin1"
);

const FORM = { kind: "skill", name: "form" } as const;
const formFolder = (manifest = SKILL_MD, script = SCRIPT): JsonObject[] => [
  { path: "SKILL.md", text: manifest },
  { path: "scripts/fill_form.py", text: script },
  { path: "assets/template.pdf", base64: TEMPLATE.toString("base64") }
];
const plainSkill = (name: string) => [
  {
    path: "SKILL.md",
    text: `---\nname: ${name}\ndescription: Use when ${name} is asked for.\n---\n\n# ${name}\n`
  }
];

type Stores = PlatformStores & TestStoreHelpers;

/**
 * An instance with three skills: `form` of the agent `assistant`, `secret` of another agent,
 * and `elsewhere`, which a workspace owns and nobody offers.
 */
async function startWorld(start: () => Promise<SkillWorld>) {
  const world = await start();
  const stores = addTestStoreHelpers(world.api.stores);
  expect((await put(world, { files: formFolder(), expectedRevision: null }, FORM)).statusCode).toBe(
    200
  );
  const secret = { kind: "skill", name: "secret" };
  expect(
    (await put(world, { files: plainSkill("secret"), expectedRevision: null }, secret)).statusCode
  ).toBe(200);
  const created = await world.api.call("workspaces.create", { payload: { name: "Elsewhere" } });
  expect(created.statusCode, created.body).toBe(200);
  const workspaceId = z.object({ id: z.string() }).parse(created.json()).id;
  const elsewhere = { kind: "skill", name: "elsewhere" };
  const owned = await put(
    world,
    { files: plainSkill("elsewhere"), expectedRevision: null, workspaceId },
    elsewhere
  );
  expect(owned.statusCode, owned.body).toBe(200);
  await stores.configAssets.applyConfigAssetMutations({
    clientInstanceId,
    baseRevisions: { "agent:assistant": null, "agent:other": null },
    mutations: [
      {
        type: "upsert",
        kind: "agent",
        name: "assistant",
        config: agent("assistant", {
          toolNames: ["read_skill", "workspace.exec"],
          skillNames: ["form"]
        })
      },
      {
        type: "upsert",
        kind: "agent",
        name: "other",
        config: agent("other", { toolNames: ["read_skill"], skillNames: ["secret"] })
      },
      { type: "setDefaultAgent", agentName: "assistant" }
    ]
  });
  return { world, stores };
}

/** What a fake Docker engine saw of one container: its mounts and the files below /skills. */
interface Started {
  commandId: string;
  args: string[];
  skillBinds: string[];
  skills: Record<string, Record<string, string>>;
}

/** A Docker client that starts nothing and records what it would have mounted at /skills. */
function recordingDocker(started: Started[]) {
  return {
    async run(input: DockerCommandRunInput): Promise<ProcessResult> {
      const binds = input.args.flatMap((arg, at) =>
        arg === "--mount" ? [input.args[at + 1] ?? ""] : []
      );
      const skillBinds = binds.filter((bind) => bind.includes("target=/skills/"));
      const skills: Started["skills"] = {};
      for (const bind of skillBinds) {
        const source = /source=([^,]+)/u.exec(bind)?.[1] ?? "";
        const name = /target=\/skills\/([^,]+)/u.exec(bind)?.[1] ?? "";
        skills[name] = await readTree(source);
      }
      started.push({ commandId: input.command.id, args: input.args, skillBinds, skills });
      return {
        exitCode: 0,
        stdoutPreview: "",
        stderrPreview: "",
        truncated: { stdout: false, stderr: false },
        durationMs: 1
      };
    }
  };
}

async function readTree(directory: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  const walk = async (current: string, prefix: string) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(current, entry.name), path);
      else found[path] = (await readFile(join(current, entry.name))).toString("base64");
    }
  };
  await walk(directory, "");
  return found;
}

const roots: string[] = [];
afterEach(async () => {
  vi.mocked(fs.mkdir).mockImplementation(
    (await vi.importActual<typeof fs>("node:fs/promises")).mkdir
  );
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await openTree(root);
      await rm(root, { recursive: true, force: true });
    })
  );
});

async function openTree(directory: string): Promise<void> {
  await chmod(directory, 0o700).catch(() => undefined);
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) await openTree(join(directory, entry.name));
  }
}

/** The command path of one agent run: its service, its runner and the worker's cache. */
async function harness(
  world: SkillWorld,
  stores: Stores,
  options: {
    executor: WorkspaceCommandProcessExecutor;
    agentName?: string;
    /** Queue only: the commands run when `runQueued` is called. */
    queueOnly?: boolean;
    /** The worker's read of skill folders, in place of the instance's. */
    skillFolders?: SkillFolderReader;
  }
) {
  const root = await mkdtemp(join(tmpdir(), "skill-mount-test-"));
  roots.push(root);
  const conversation = await stores.createConversationForTesting({
    clientInstanceId,
    createdByUserId: "user-1",
    createdByExternalUserId: "user-1",
    title: "Fill a form",
    retainedUntil: "2099-01-01T00:00:00.000Z"
  });
  const run = await stores.createAgentRunForTesting(conversation);
  const byteStore = createFilesystemObjectStorage(join(root, "objects"));
  const commandsDirectory = join(root, "commands");
  const runner = new LocalWorkspaceCommandRunner({
    store: stores,
    byteStore,
    tempRootDirectory: commandsDirectory,
    reuseWorkspaceDirectories: true,
    processExecutor: options.executor,
    skillFolders:
      options.skillFolders ??
      createSkillFolderReader({
        clientInstanceId,
        stores,
        ...(world.execution.pages ? { files: world.execution.pages.objects } : {})
      })
  });
  const assetSource = createStoredConfigAssetSource({
    store: stores.configAssets,
    clientInstanceId
  });
  const service = new WorkspaceCommandService({
    store: stores,
    objectStore: byteStore,
    fileStore: byteStore,
    skills: { assetSource },
    ...(options.queueOnly
      ? { execResultWaitMs: 0 }
      : { commandResults: inlineCommandResults(stores, { runner }) })
  });
  const context = toolContext(conversation.id, run.id, options.agentName ?? "assistant");
  return {
    service,
    runner,
    context,
    commandsDirectory,
    assetSource,
    async exec(command: string) {
      const result = await service.exec({ command }, context);
      if (result.status !== "success" || !result.output) {
        throw new Error(`The command was not queued: ${JSON.stringify(result)}`);
      }
      return result.output;
    },
    runQueued: () => runQueuedCommands(stores, clientInstanceId, { runner }),
    command: (commandId: string) =>
      stores.executionWorkspaces.getWorkspaceCommand({
        clientInstanceId,
        commandId: asWorkspaceCommandId(commandId)
      })
  };
}

function toolContext(
  conversationId: ConversationId,
  agentRunId: AgentRunId,
  agentName: string
): ToolExecutionContext {
  return {
    clientInstanceId,
    correlationId: "corr_skill_mount",
    user: {
      id: "user-1",
      externalUserId: "user-1",
      displayLabel: "User",
      roles: ["user"],
      permissionRefs: [],
      clientInstanceId,
      authSource: "test"
    },
    toolRequest: {
      toolName: "workspace.exec",
      toolCallId: asToolCallId(`toolcall_${globalThis.crypto.randomUUID()}`),
      agentRunId,
      conversationId,
      agentName,
      input: {}
    }
  };
}

describe("the folders of an agent's skills in its workspace commands", () => {
  const { start } = useSkillWorlds();

  it("mounts the admitted Try draft's whole folder even after the draft is discarded", async () => {
    const { world, stores } = await startWorld(start);
    const changedScript = "print('draft script')\n";
    const saved = await world.api.call("assets.put", {
      params: FORM,
      payload: { files: formFolder(SKILL_MD, changedScript), expectedRevision: 1 }
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const live = await stores.configAssets.getConfigAsset({ clientInstanceId, ...FORM });
    if (!live) throw new Error("Skill missing");
    const draft = await stores.agentProposals.get({ clientInstanceId, agentId: live.id });
    if (!draft) throw new Error("Draft missing");
    const started: Started[] = [];
    const h = await harness(world, stores, {
      queueOnly: true,
      executor: new DockerWorkspaceCommandProcessExecutor({
        image: "runner:test",
        commandClient: recordingDocker(started)
      })
    });
    h.context.agentPreview = {
      agentId: "assistant",
      revision: 1,
      source: "live",
      config: agent("assistant", { skillNames: ["form"], toolNames: ["workspace.exec"] }),
      skills: [
        {
          revision: draft.revision,
          config: skillConfigSchema.parse(draft.config),
          ...(draft.fileSetId ? { fileSetId: draft.fileSetId } : {})
        }
      ]
    };
    const queued = await h.exec("ls /skills/form");
    expect(queued.status).toBe("queued");
    await stores.agentProposals.remove({
      clientInstanceId,
      agentId: live.id,
      revision: draft.revision
    });
    await h.runQueued();
    expect((await h.command(queued.commandId))?.status).toBe("completed");
    expect(started[0]?.skills.form?.["scripts/fill_form.py"]).toBe(
      Buffer.from(changedScript).toString("base64")
    );
    expect(started[0]?.skills.form?.["assets/template.pdf"]).toBe(TEMPLATE.toString("base64"));
  });

  it("records the run's skills on the command and mounts those alone, read-only, with no network", async () => {
    const { world, stores } = await startWorld(start);
    const started: Started[] = [];
    const h = await harness(world, stores, {
      executor: new DockerWorkspaceCommandProcessExecutor({
        image: "runner:test",
        commandClient: recordingDocker(started)
      })
    });

    const output = await h.exec("ls /skills");

    expect(output.status).toBe("completed");
    const form = await h.assetSource.getSkillRevision("form");
    if (!form) throw new Error("The skill form is not stored");
    const command = await h.command(output.commandId);
    expect(command?.skillMounts).toEqual([
      {
        name: "form",
        revision: form.revision,
        sourceVersion: createSkillSourceVersion(form.skill)
      }
    ]);
    // Names, revisions and versions: no byte of the skill is on the command row.
    expect(JSON.stringify(command)).not.toContain("fill_form.py");
    const [container] = started;
    expect(started).toHaveLength(1);
    expect(container?.skillBinds).toHaveLength(1);
    expect(container?.skillBinds[0]).toMatch(
      /^type=bind,source=\/.+,target=\/skills\/form,readonly$/u
    );
    expect(container?.args.join(" ")).not.toMatch(/secret|elsewhere/u);
    expect(container?.args[(container.args.indexOf("--network") ?? 0) + 1]).toBe("none");
    // The whole folder, byte for byte as `assets.get files=true` answers it.
    expect(container?.skills.form).toEqual({
      "SKILL.md": Buffer.from(SKILL_MD).toString("base64"),
      "assets/template.pdf": TEMPLATE.toString("base64"),
      "scripts/fill_form.py": Buffer.from(SCRIPT).toString("base64")
    });
    // The cache is beside the workspaces, not in one.
    const source = /source=([^,]+)/u.exec(container?.skillBinds[0] ?? "")?.[1] ?? "";
    expect(source.startsWith(join(h.commandsDirectory, "catalyst-skill-folders"))).toBe(true);
  });

  it("mounts the skills of the other agent for its run, and none of the first", async () => {
    const { world, stores } = await startWorld(start);
    const started: Started[] = [];
    const h = await harness(world, stores, {
      agentName: "other",
      executor: new DockerWorkspaceCommandProcessExecutor({
        image: "runner:test",
        commandClient: recordingDocker(started)
      })
    });
    const output = await h.exec("ls /skills");
    expect((await h.command(output.commandId))?.skillMounts?.map((m) => m.name)).toEqual([
      "secret"
    ]);
    expect(Object.keys(started[0]?.skills ?? {})).toEqual(["secret"]);
  });

  it("mounts the revision live when the command was queued: a later save shows at the next command", async () => {
    const { world, stores } = await startWorld(start);
    const started: Started[] = [];
    const h = await harness(world, stores, {
      queueOnly: true,
      executor: new DockerWorkspaceCommandProcessExecutor({
        image: "runner:test",
        commandClient: recordingDocker(started)
      })
    });
    const before = await h.exec("python /skills/form/scripts/fill_form.py");
    const saved = await put(
      world,
      {
        files: formFolder(SKILL_MD.replace("# Form", "# Form, second"), `${SCRIPT}# v2\n`),
        expectedRevision: 1
      },
      FORM
    );
    expect(saved.statusCode, saved.body).toBe(200);
    const after = await h.exec("python /skills/form/scripts/fill_form.py");
    expect(before.status).toBe("queued");

    // The commands of one workspace run one after the other.
    for (let pass = 0; pass < 4; pass++) {
      await h.runQueued();
      if ((await h.command(after.commandId))?.status === "completed") break;
    }

    const first = await h.command(before.commandId);
    const second = await h.command(after.commandId);
    expect(first?.status).toBe("completed");
    expect(second?.status).toBe("completed");
    expect(first?.skillMounts?.[0]?.revision).toBe(1);
    expect(second?.skillMounts?.[0]?.revision).toBe(2);
    expect(first?.skillMounts?.[0]?.sourceVersion).not.toBe(
      second?.skillMounts?.[0]?.sourceVersion
    );
    const seen = (commandId: string) =>
      Buffer.from(
        started.find((container) => container.commandId === commandId)?.skills.form?.[
          "scripts/fill_form.py"
        ] ?? "",
        "base64"
      ).toString("utf8");
    expect(seen(before.commandId)).toBe(SCRIPT);
    expect(seen(after.commandId)).toBe(`${SCRIPT}# v2\n`);
  });

  it("fills a cache folder that changed on the worker's disk again, and mounts what the skill holds", async () => {
    const { world, stores } = await startWorld(start);
    const started: Started[] = [];
    const h = await harness(world, stores, {
      executor: new DockerWorkspaceCommandProcessExecutor({
        image: "runner:test",
        commandClient: recordingDocker(started)
      })
    });
    await h.exec("true");
    const source = /source=([^,]+)/u.exec(started[0]?.skillBinds[0] ?? "")?.[1] ?? "";
    await chmod(join(source, "scripts"), 0o755);
    await chmod(join(source, "scripts/fill_form.py"), 0o644);
    await writeFile(join(source, "scripts/fill_form.py"), "print('tampered')\n");

    const output = await h.exec("true");

    expect(output.status).toBe("completed");
    expect(started[1]?.skillBinds[0]).toBe(started[0]?.skillBinds[0]);
    expect(
      Buffer.from(started[1]?.skills.form?.["scripts/fill_form.py"] ?? "", "base64").toString()
    ).toBe(SCRIPT);
  });

  it("fails a command whose skill folder cannot be read, with the skill's name, and runs nothing", async () => {
    const { world, stores } = await startWorld(start);
    const started: Started[] = [];
    const h = await harness(world, stores, {
      queueOnly: true,
      executor: new DockerWorkspaceCommandProcessExecutor({
        image: "runner:test",
        commandClient: recordingDocker(started)
      })
    });
    const queued = await h.exec("true");
    // A command row that names a revision the skill never had.
    const sql = postgres(await fileTestDatabaseUrl(), { max: 1 });
    try {
      await sql`update workspace_commands set skill_mounts = ${sql.json([
        { name: "form", revision: 99, sourceVersion: `sha256:${"0".repeat(64)}` }
      ])} where id = ${queued.commandId}`;
    } finally {
      await sql.end();
    }

    await h.runQueued();

    const failed = await h.command(queued.commandId);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toMatchObject({
      code: "WORKSPACE_SKILL_MOUNT_FAILED",
      details: { reason: "skill_mount_failed", skill: "form" }
    });
    expect(started).toEqual([]);
  });

  it("tells the agent in one sentence that a skill could not be made available, with no path of the worker", async () => {
    const { world, stores } = await startWorld(start);
    const started: Started[] = [];
    const h = await harness(world, stores, {
      executor: new DockerWorkspaceCommandProcessExecutor({
        image: "runner:test",
        commandClient: recordingDocker(started)
      }),
      skillFolders: {
        read: () => Promise.reject(new Error("EACCES: /var/lib/catalyst/objects/skills/form"))
      }
    });

    const result = await h.service.exec({ command: "ls /skills" }, h.context);

    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "handler_failed",
        message:
          "The skill 'form' could not be made available for this command, so it did not run; try again or continue without it.",
        details: { reason: "skill_mount_failed", skill: "form" }
      }
    });
    expect(JSON.stringify(result)).not.toMatch(/\/var\/lib|EACCES|skill-mount-test-/u);
    expect(started).toEqual([]);
  });

  it("fails with the skill's name and no path where the local sandbox cannot copy the folder", async () => {
    const { world, stores } = await startWorld(start);
    const h = await harness(world, stores, {
      executor: new LocalWorkspaceCommandProcessExecutor()
    });
    // The worker's disk refuses the folder of the command's copy of the skill.
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.mkdir).mockImplementation((path, options) =>
      String(path).endsWith(join("skills", "form"))
        ? Promise.reject(
            Object.assign(new Error(`EACCES: permission denied, mkdir '${String(path)}'`), {
              code: "EACCES"
            })
          )
        : actual.mkdir(path, options)
    );

    const result = await h.service.exec({ command: "true" }, h.context);

    expect(result).toMatchObject({
      status: "failed",
      error: { details: { reason: "skill_mount_failed", skill: "form" } }
    });
    const failed = await h.command(
      z
        .object({ commandId: z.string() })
        .parse(result.status === "failed" ? result.error.details : {}).commandId
    );
    expect(failed?.error).toMatchObject({
      code: "WORKSPACE_SKILL_MOUNT_FAILED",
      details: { reason: "skill_mount_failed", skill: "form", cause: "not_copied" }
    });
    expect(JSON.stringify([result, failed?.error])).not.toContain(h.commandsDirectory);
  });

  it("refuses a folder whose stored file is missing or is not the one the revision records", async () => {
    const { world, stores } = await startWorld(start);
    const objects = world.execution.pages?.objects;
    if (!objects) throw new Error("The world has no files store");
    const reader = createSkillFolderReader({ clientInstanceId, stores, files: objects });
    const assetSource = createStoredConfigAssetSource({
      store: stores.configAssets,
      clientInstanceId
    });
    const live = await assetSource.getSkillRevision("form");
    if (!live) throw new Error("The skill form is not stored");
    const read = () => reader.read({ clientInstanceId, name: "form", revision: live.revision });
    expect((await read()).map((file) => file.path)).toEqual([
      "SKILL.md",
      "assets/template.pdf",
      "scripts/fill_form.py"
    ]);

    // The revision records other bytes for one file than its file set holds.
    const sql = postgres(await fileTestDatabaseUrl(), { max: 1 });
    try {
      const recorded = (live.skill.files ?? []).map((entry) => ({ ...entry }));
      const setFiles = (files: typeof recorded) =>
        sql`update config_asset_revisions set config = jsonb_set(config, '{files}', ${sql.json(files)})
          where client_instance_id = ${clientInstanceId} and revision = ${live.revision}
          and config->>'name' = 'form'`;
      expect(recorded.map((entry) => entry.path)).toEqual([
        "assets/template.pdf",
        "scripts/fill_form.py"
      ]);
      await setFiles(
        recorded.map((entry) =>
          entry.path === "assets/template.pdf" ? { ...entry, sha256: "0".repeat(64) } : entry
        )
      );
      await expect(read()).rejects.toMatchObject({ details: { reason: "skill_file_mismatch" } });
      // The revision does not name a file its file set holds.
      await setFiles(recorded.filter((entry) => entry.path !== "assets/template.pdf"));
      await expect(read()).rejects.toMatchObject({ details: { reason: "skill_file_mismatch" } });
      await setFiles(recorded);
      expect(await read()).toHaveLength(3);
    } finally {
      await sql.end();
    }

    // A file of the file set is gone from storage: refused, never an empty file.
    const keys: string[] = [];
    for (let cursor: string | undefined, first = true; first || cursor; first = false) {
      const page = await objects.list("", cursor);
      keys.push(...page.objects.map((object) => object.key));
      cursor = page.cursor;
    }
    const template = keys.filter((key) => key.endsWith("/assets/template.pdf"));
    expect(template.length).toBeGreaterThan(0);
    for (const key of template) await objects.delete(key);
    await expect(read()).rejects.toThrow();
  });

  it("mounts nothing for a command whose call names no agent", async () => {
    const { world, stores } = await startWorld(start);
    const started: Started[] = [];
    const h = await harness(world, stores, {
      executor: new DockerWorkspaceCommandProcessExecutor({
        image: "runner:test",
        commandClient: recordingDocker(started)
      })
    });
    if (!h.context.toolRequest) throw new Error("The harness has no tool request");
    const result = await h.service.exec(
      { command: "ls /skills" },
      { ...h.context, toolRequest: { ...h.context.toolRequest, agentName: "" } }
    );
    if (result.status !== "success" || !result.output) throw new Error(JSON.stringify(result));
    expect((await h.command(result.output.commandId))?.skillMounts).toBeUndefined();
    expect(started[0]?.skillBinds).toEqual([]);
  });

  it("runs the skill's script on its template with the local sandbox, and only the output becomes a workspace file", async () => {
    const { world, stores } = await startWorld(start);
    const h = await harness(world, stores, {
      executor: new LocalWorkspaceCommandProcessExecutor()
    });

    const output = await h.exec(
      [
        "set -e",
        'skills="$WORKSPACE_DIR/../skills"',
        'PYTHONDONTWRITEBYTECODE=1 python3 "$skills/form/scripts/fill_form.py" "$skills/form/assets/template.pdf" artifacts/out.pdf',
        'ls "$skills"'
      ].join("\n")
    );

    expect(output).toMatchObject({ status: "completed", exitCode: 0 });
    expect(output.stdoutPreview).toBe("filled artifacts/out.pdf\nform\n");
    expect(output.changedFiles.map((file) => file.path)).toEqual(["artifacts/out.pdf"]);
    const promoted = await h.service.promoteArtifact(
      { path: "artifacts/out.pdf", kind: "workspace.file" },
      h.context
    );
    expect(promoted).toMatchObject({
      status: "success",
      output: { path: "artifacts/out.pdf", byteSize: FILLED.byteLength }
    });
    const files = await stores.executionWorkspaces.listWorkspaceFiles({
      clientInstanceId,
      workspaceId: asExecutionWorkspaceId(output.workspaceId)
    });
    expect(files.map((file) => file.path)).toEqual(["artifacts/out.pdf"]);
  });
});

describe("what `read_skill` says of the folder", () => {
  const { start } = useSkillWorlds();

  it("names /skills/<name>/ for an agent with workspace.exec, and not for one without", async () => {
    const { stores } = await startWorld(start);
    const assetSource = createStoredConfigAssetSource({
      store: stores.configAssets,
      clientInstanceId
    });
    const run = createTestToolRunner({
      registry: new ToolRegistry({ tools: [createReadSkillTool({ assetSource })] }),
      getAgentToolNames: () => ["read_skill"]
    });
    const read = (agentName: string, name: string) =>
      run(
        {
          toolName: "read_skill",
          toolCallId: asToolCallId(`toolcall_${globalThis.crypto.randomUUID()}`),
          agentRunId: asAgentRunId("run_read"),
          conversationId: asConversationId("conv_read"),
          agentName,
          input: { name }
        },
        toolContext(asConversationId("conv_read"), asAgentRunId("run_read"), agentName)
      );
    const withWorkspace = await read("assistant", "form");
    expect(withWorkspace).toMatchObject({ status: "success", output: { folder: "/skills/form/" } });
    expect(withWorkspace.status === "success" && withWorkspace.output).not.toHaveProperty(
      "workspaceNotice"
    );
    const without = await read("other", "secret");
    expect(without.status === "success" && without.output).not.toHaveProperty("folder");
  });
});

// With Docker and the runner image of a release: what the container itself lets a command do.
const runnerImage = process.env.CATALYST_RUNNER_IMAGE;

describe.skipIf(!runnerImage)("a skill folder in the runner container", () => {
  const { start } = useSkillWorlds();

  it("runs the skill's script, keeps the folder read-only and shows no other skill", async () => {
    const { world, stores } = await startWorld(start);
    const container = runnerContainer(runnerImage ?? "");
    const h = await harness(world, stores, { executor: container.executor });

    const filled = await h.exec(
      "python /skills/form/scripts/fill_form.py /skills/form/assets/template.pdf artifacts/out.pdf"
    );
    expect(filled, filled.stderrPreview).toMatchObject({ status: "completed", exitCode: 0 });
    expect(filled.changedFiles.map((file) => file.path)).toEqual(["artifacts/out.pdf"]);
    const promoted = await h.service.promoteArtifact(
      { path: "artifacts/out.pdf", kind: "workspace.file" },
      h.context
    );
    expect(promoted).toMatchObject({
      status: "success",
      output: { path: "artifacts/out.pdf", byteSize: FILLED.byteLength }
    });

    const probe = await h.exec(
      [
        "ls -a /skills | tr '\\n' ' '; echo",
        "if touch /skills/form/x 2>/dev/null; then echo touch-allowed; else echo touch-refused; fi",
        "if rm /skills/form/SKILL.md 2>/dev/null; then echo rm-allowed; else echo rm-refused; fi",
        "if mkdir /skills/other 2>/dev/null; then echo mkdir-allowed; else echo mkdir-refused; fi",
        "if chmod u+w /skills/form/SKILL.md 2>/dev/null; then echo chmod-allowed; else echo chmod-refused; fi",
        "touch /workspace/still-writable && echo workspace-writable",
        "if python -c \"import socket; socket.create_connection(('1.1.1.1', 53), timeout=2)\" 2>/dev/null; then echo network; else echo no-network; fi",
        "cat /skills/form/../form/SKILL.md | head -2 | tail -1"
      ].join("\n")
    );
    expect(probe, probe.stderrPreview).toMatchObject({ status: "completed", exitCode: 0 });
    expect(probe.stdoutPreview.split("\n")).toEqual([
      ". .. form ",
      "touch-refused",
      "rm-refused",
      "mkdir-refused",
      "chmod-refused",
      "workspace-writable",
      "no-network",
      "name: form",
      ""
    ]);
    // Nothing of /skills became a workspace file.
    expect(probe.changedFiles.map((file) => file.path)).toEqual(["still-writable"]);
    const files = await stores.executionWorkspaces.listWorkspaceFiles({
      clientInstanceId,
      workspaceId: asExecutionWorkspaceId(probe.workspaceId)
    });
    expect(files.map((file) => file.path).sort()).toEqual(["artifacts/out.pdf", "still-writable"]);
  }, 180_000);
});
