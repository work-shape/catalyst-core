import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  asAgentRunId,
  asConversationId,
  asToolCallId,
  createPlatformId,
  toolCallOperationName,
  type ConversationId,
  type JobWorker,
  type Logger,
  type UserRecord
} from "@work-shape/catalyst-core";
import { runCli } from "@work-shape/catalyst-cli";
import { createOutsideSchemaChecker } from "@work-shape/catalyst-connections";
import {
  createJobWorker,
  createToolAssetKind,
  createToolCodeCallClient,
  createToolCodeCallJobs,
  createToolOperationSource
} from "@work-shape/catalyst-client-assembly";
import {
  LocalWorkspaceCommandProcessExecutor,
  runOperation
} from "@work-shape/catalyst-tool-execution";
import { clientInstanceId, setupAccessInstance } from "./support/access-instance";
import {
  fixtureOn,
  identityOf,
  operationOf,
  type ConnectionOperationsFixture
} from "./support/connection-operations";
import { testOperations } from "./support/operations";
import { createTestFetch } from "./support/test-instance";

// A code tool written as a folder reaches an agent (TOOL-2d): `catalyst tool put <folder>`
// writes it as a draft, `catalyst tool publish` makes it live, and the agent's call runs the
// bundle the CLI made in the sandbox, whose Connection call goes through the platform. `catalyst
// tool run` runs the same folder locally, its Connection call made on the instance as a draft's.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checker = createOutsideSchemaChecker();
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const AGENT = "assistant";

const TOOL = `
import { z } from "zod";
import { defineTool } from "@work-shape/catalyst-tool-sdk/code";

export default defineTool({
  name: "shout",
  title: "Shout",
  description: "Echoes a text through the CRM, louder.",
  inputSchema: z.object({ text: z.string().describe("What to shout") }),
  async execute({ text }, ctx) {
    const echoed = await ctx.connection("crm").call("echo", { text: text.toUpperCase() });
    ctx.display.data("shout", { echoed }, "Shouted");
    return { echoed };
  }
});
`;

const PYTHON = `
from catalyst_tools import tool


@tool
def whisper(ctx, text: str):
    """Echoes a text through the CRM, quieter.

    Args:
        text: What to whisper.
    """
    return {"echoed": ctx.connection("crm").call("echo", {"text": text.lower()})}
`;

let f: ConnectionOperationsFixture;
let conversationId: ConversationId;
let tempRoot = "";
const folders: string[] = [];
const workers: JobWorker[] = [];

beforeAll(async () => {
  f = await fixtureOn((options) =>
    setupAccessInstance({
      ...options,
      furtherKinds: [
        ...(options.furtherKinds ?? []),
        createToolAssetKind({ checker, operations: () => f.operationCalls })
      ]
    })
  );
  f.operationCalls.registry.addSource(
    createToolOperationSource({
      clientInstanceId,
      store: f.stores.configAssets,
      checker,
      codeCalls: createToolCodeCallClient({ stores: f.stores, pollMs: 10 }),
      operations: () => f.operationCalls
    })
  );
  const crm = await f.seed("crm", { operations: [operationOf("echo")] });
  await f.grant(f.kai.id, "connection.use", { assetId: crm });
  const workspaceId = await f.sharedWorkspace("tools");
  conversationId = (
    await f.stores.conversations.createConversation({
      clientInstanceId,
      collaborationWorkspaceId: workspaceId,
      createdByUserId: f.kai.id,
      createdByExternalUserId: f.kai.id,
      visibility: "private",
      title: "Tools",
      retainedUntil: "2099-01-01T00:00:00.000Z"
    })
  ).id;
  tempRoot = await mkdtemp(join(tmpdir(), "tool-sdk-e2e-"));
  const local = new LocalWorkspaceCommandProcessExecutor();
  const worker = createJobWorker({
    stores: f.stores,
    clientInstanceId,
    logger: silent,
    handlers: createToolCodeCallJobs({
      clientInstanceId,
      stores: f.stores,
      tempRoot,
      slots: 2,
      limits: {
        cpuCount: 1,
        memoryBytes: 256 * 1024 ** 2,
        pidsLimit: 64,
        scratchBytes: 16 * 1024 ** 2
      },
      cancelCheckMs: 50,
      requestPollMs: 10,
      sandbox: {
        execute(given) {
          return local.execute({
            ...given,
            env: { ...given.env, PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin` }
          });
        }
      }
    }).handlers
  });
  worker.start();
  workers.push(worker);
});

afterAll(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  await Promise.all(
    [tempRoot, ...folders].map((path) => rm(path, { recursive: true, force: true }))
  );
  await checker.close();
});

async function folderOf(files: Record<string, string>, typescript = false): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "tool-sdk-e2e-folder-"));
  folders.push(folder);
  for (const [path, content] of Object.entries(files)) await writeFile(join(folder, path), content);
  if (typescript) {
    const sdk = join(repository, "packages/tool-sdk");
    await mkdir(join(folder, "node_modules/@work-shape"), { recursive: true });
    await symlink(sdk, join(folder, "node_modules/@work-shape/catalyst-tool-sdk"), "dir");
    await symlink(
      await realpath(join(sdk, "node_modules/zod")),
      join(folder, "node_modules/zod"),
      "dir"
    );
  }
  return folder;
}

/** `catalyst <args>` as `user`, signed in with their personal key, against the test instance. */
async function cli(user: UserRecord, args: string[]) {
  const serverFetch = createTestFetch(f.instance, {
    "x-test-user": user.id,
    "x-test-key": "personal",
    "x-test-key-scopes": "tool.write tool.publish connection.use"
  });
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli([...args, "--instance", "https://catalyst.test"], {
    cwd: tmpdir(),
    env: { CATALYST_API_KEY: "cat_personal", PATH: process.env.PATH ?? "" },
    stdin: Readable.from([]),
    fetchImpl: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname === testOperations["access_tokens.exchange"].path) {
        return Response.json({
          accessToken: "access-token",
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        });
      }
      // The test instance signs the person in from its own header, not from the token.
      const headers = new Headers(request.headers);
      headers.delete("authorization");
      return serverFetch(new Request(request, { headers }));
    },
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text)
  });
  return { code, out: out.join(""), err: err.join("") };
}

/** Puts the folder with the CLI and publishes the revision it wrote. */
async function putAndPublish(folder: string, name: string): Promise<void> {
  const put = await cli(f.admin, ["tool", "put", folder]);
  expect(put.code, put.err).toBe(0);
  const revision = /--revision (\d+)/u.exec(put.out)?.[1];
  expect(revision, put.out).toBeDefined();
  const published = await cli(f.admin, ["tool", "publish", name, "--revision", revision ?? ""]);
  expect(published.code, published.err).toBe(0);
}

/** The agent's call of the published tool as Kai. */
async function agentCall(tool: string, input: Record<string, string>) {
  f.state.agentTools.set(AGENT, [toolCallOperationName(tool)]);
  return runOperation(
    {
      operation: toolCallOperationName(tool),
      effect: "changing",
      input,
      actor: identityOf(f.kai),
      origin: {
        kind: "agent",
        agentRunId: asAgentRunId(createPlatformId("run")),
        conversationId: asConversationId(conversationId),
        agentName: AGENT,
        toolCallId: asToolCallId(createPlatformId("call")),
        toolName: toolCallOperationName(tool)
      },
      correlationId: createPlatformId("corr")
    },
    f.operationCalls.deps,
    {}
  );
}

const answerSchema = z.object({ echoed: z.unknown() });

describe("a code tool from its folder", () => {
  it("is put and published with the CLI, and an agent's call runs the TypeScript bundle", async () => {
    const folder = await folderOf(
      { "tool.yaml": "summary: Shouts\nconnections: [crm.echo]\n", "index.ts": TOOL },
      true
    );
    await putAndPublish(folder, "shout");
    const outcome = await agentCall("shout", { text: "hello" });
    expect(outcome.result.status, JSON.stringify([outcome.result, outcome.run.error])).toBe("done");
    const output = outcome.result.status === "done" ? outcome.result.output : undefined;
    expect(answerSchema.parse(output).echoed).toEqual({ text: "HELLO" });
  }, 60_000);

  it("is put and published with the CLI, and an agent's call runs the Python handler", async () => {
    const folder = await folderOf({
      "tool.yaml": "title: Whisper\nconnections: [crm.echo]\n",
      "main.py": PYTHON
    });
    await putAndPublish(folder, "whisper");
    const outcome = await agentCall("whisper", { text: "QUIET" });
    expect(outcome.result.status, JSON.stringify([outcome.result, outcome.run.error])).toBe("done");
    const output = outcome.result.status === "done" ? outcome.result.output : undefined;
    expect(answerSchema.parse(output).echoed).toEqual({ text: "quiet" });
  }, 60_000);

  it("runs locally, its Connection call made on the instance with the person's key", async () => {
    const folder = await folderOf(
      { "tool.yaml": "connections: [crm.echo]\n", "index.ts": TOOL },
      true
    );
    const before = new Set((await f.runs()).map((run) => run.id));
    const ran = await cli(f.kai, ["tool", "run", folder, "--input", '{"text":"local"}']);
    expect(ran.code, ran.err).toBe(0);
    expect(JSON.parse(ran.out)).toEqual({ echoed: { text: "LOCAL" } });
    const made = (await f.runs()).filter((run) => !before.has(run.id));
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({
      operation: "connection.crm.echo",
      status: "done",
      actor: { kind: "user", id: f.kai.id },
      origin: { kind: "cli" }
    });

    // Lena holds no connection.use: the handler is told, and nothing runs.
    const refused = await cli(f.lena, ["tool", "run", folder, "--input", '{"text":"x"}']);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("forbidden");
  }, 60_000);
});
