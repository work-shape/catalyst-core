import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runPageBuild, type PageBuildLimits } from "@vivd-catalyst/app-build";
import { createPageBuildClient, createPageBundleJobs } from "@vivd-catalyst/chat-server";
import {
  assertAgentWorkerServesModuleJobKinds,
  createClientInstanceAgentRunWorker,
  platformModules
} from "@vivd-catalyst/client-assembly";
import {
  createModuleRegistry,
  FILE_SET_MAX_FILE_BYTES,
  readObjectBytes,
  type JobWorker,
  type Logger,
  type PageBuildClient
} from "@vivd-catalyst/core";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import { createPostgresJobWorker } from "@vivd-catalyst/postgres-store";
import {
  createPageSaveTool,
  InProcessToolExecution,
  ToolRegistry,
  WorkspaceCommandService
} from "@vivd-catalyst/tool-execution";
import { createTestConfig } from "./support/fixtures";
import { MemoryObjectStorage } from "./support/memory-object-storage";
import {
  fileRoute,
  htmlManifest,
  pageBuildProcessEntryFromSource,
  reactManifest,
  rootRoute
} from "./support/page-build";
import { fileTestDatabaseUrl } from "./support/test-database";
import { createWorkspaceHarness } from "./support/workspace-tools-harness";

// Saving a Page through the tool an agent calls: the folder in the conversation's Execution
// Workspace is snapshotted, built by the `page.bundle` job in a process of its own and stored
// as a file set. The job worker here is the executor's, on Postgres.

const silent: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => silent
};

const issueSchema = z.looseObject({
  file: z.string(),
  line: z.number().optional(),
  element: z.string().optional(),
  attribute: z.string().optional(),
  code: z.string().optional()
});
const saveOutputSchema = z.looseObject({
  pageId: z.string().optional(),
  number: z.number().optional(),
  fileSetId: z.string().optional(),
  errors: z.array(issueSchema).optional()
});

let processEntry: string;
let scratch: string;
const workers: JobWorker[] = [];

beforeAll(async () => {
  processEntry = await pageBuildProcessEntryFromSource();
  scratch = await mkdtemp(join(tmpdir(), "page-save-test-"));
});
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function createSaveHarness(
  options: {
    /** Without a worker nothing serves `page.bundle`. */
    worker?: boolean;
    processEntry?: string;
    limits?: Partial<PageBuildLimits>;
    builds?: (client: PageBuildClient) => PageBuildClient;
    waitMs?: number;
  } = {}
) {
  const harness = await createWorkspaceHarness();
  const { store, clientInstanceId, conversation, objectStore } = harness;
  const files = new MemoryObjectStorage();
  const service = new WorkspaceCommandService({
    store,
    objectStore,
    fileStore: objectStore,
    now: () => new Date().toISOString()
  });
  const client = createPageBuildClient({
    stores: store,
    pollIntervalMs: 20,
    ...(options.waitMs === undefined ? {} : { waitMs: options.waitMs })
  });
  const tool = createPageSaveTool({
    workspace: service.dependencies,
    builds: options.builds?.(client) ?? client
  });
  const execution = new InProcessToolExecution({
    registry: new ToolRegistry({ tools: [tool] }),
    getAgentToolNames: () => [tool.name]
  });
  const worker = createPostgresJobWorker({
    stores: store,
    clientInstanceId,
    logger: silent,
    handlers: createPageBundleJobs({
      clientInstanceId,
      stores: store,
      pages: { objects: files },
      workspaceObjects: objectStore,
      logger: silent,
      limits: options.limits,
      build: (input) =>
        runPageBuild({ ...input, processEntry: options.processEntry ?? processEntry })
    }).handlers
  });
  workers.push(worker);
  if (options.worker !== false) {
    worker.start();
  }
  const workspace = await store.executionWorkspaces.ensureExecutionWorkspace({
    clientInstanceId,
    conversationId: conversation.id,
    ownerUserId: harness.ownerUserId,
    now: new Date().toISOString()
  });
  let version = 0;

  return {
    ...harness,
    files,
    worker,
    /** Writes files of the workspace as the agent's file tools do: bytes, then the row. */
    async write(folder: string, contents: Record<string, string | { declaredBytes: number }>) {
      for (const [path, content] of Object.entries(contents)) {
        const bytes = new TextEncoder().encode(typeof content === "string" ? content : "");
        version += 1;
        const objectKey = `execution-workspaces/${workspace.id}/v${version}/${folder}/${path}`;
        await objectStore.put(objectKey, bytes);
        await store.executionWorkspaces.upsertWorkspaceFile({
          clientInstanceId,
          workspaceId: workspace.id,
          path: `${folder}/${path}`,
          objectKey,
          byteSize: typeof content === "string" ? bytes.byteLength : content.declaredBytes,
          checksum: createHash("sha256").update(bytes).digest("hex"),
          updatedAt: new Date().toISOString()
        });
      }
    },
    async save(name: string, directory: string) {
      const request = harness.createRequest("page.save", { name, directory });
      const decision = await execution.authorize(request, harness.context);
      if (decision.status !== "allowed") {
        throw new Error(`page.save was not allowed: ${decision.status}`);
      }
      const result = await execution.execute(
        { ...request, authorization: decision },
        harness.context
      );
      return {
        status: result.status,
        output: result.status === "success" ? saveOutputSchema.parse(result.output) : undefined,
        error: result.status === "failed" ? result.error : undefined
      };
    },
    async fileSets() {
      const pages = await store.pages.listPages({
        clientInstanceId,
        conversationId: conversation.id
      });
      const sets = await Promise.all(
        pages.map((page) => store.pages.listPageFileSets({ clientInstanceId, pageId: page.id }))
      );
      return sets.flat();
    },
    async queuedBuilds() {
      const summary = await store.jobs.summarizeByKind({ clientInstanceId });
      return summary.find((kind) => kind.kind === "page.bundle")?.queued ?? 0;
    }
  };
}

const reactPage = (routes: Record<string, string>) => ({
  "app.yaml": reactManifest,
  "src/routes/__root.tsx": rootRoute,
  ...Object.fromEntries(Object.entries(routes).map(([name, text]) => [`src/routes/${name}`, text]))
});

describe("page.save", () => {
  it("builds the folder into revision 1, and a second save into revision 2", async () => {
    const harness = await createSaveHarness();
    await harness.write("calculator", reactPage({ "index.tsx": fileRoute("/") }));
    await harness.write("other", { "notes.txt": "not part of the Page" });

    const first = await harness.save("Calculator", "calculator");

    expect(first).toMatchObject({ status: "success", output: { number: 1 } });
    expect(first.output?.errors).toBeUndefined();
    const [page] = await harness.store.pages.listPages({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id
    });
    if (!page) throw new Error("The save stored no Page");
    const stored = await harness.store.pages.getPageFileSet({
      clientInstanceId: harness.clientInstanceId,
      pageId: page.id
    });
    expect(stored).toMatchObject({
      id: first.output?.fileSetId,
      number: 1,
      kitVersion: "1.0.0",
      manifest: { id: "demo-page", entry: "index.html", pages: [{ path: "/" }] },
      createdByUserId: harness.ownerUserId
    });
    expect(stored?.sourceFiles.map((file) => file.path).sort()).toEqual([
      "app.yaml",
      "src/routes/__root.tsx",
      "src/routes/index.tsx"
    ]);
    expect(stored?.builtFiles.map((file) => file.path).sort()).toEqual(["app.js", "index.html"]);
    const script = new TextDecoder().decode(
      await readObjectBytes(
        harness.files,
        `pages/${first.output?.pageId}/${first.output?.fileSetId}/dist/app.js`
      )
    );
    expect(script).toContain("/app-runtime/kit/1.0.0/router.js");

    await harness.write("calculator", { "src/routes/history.tsx": fileRoute("/history") });
    const second = await harness.save("Calculator", "calculator");

    expect(second).toMatchObject({
      status: "success",
      output: { number: 2, pageId: first.output?.pageId }
    });
    expect(second.output?.fileSetId).not.toBe(first.output?.fileSetId);
    expect(await harness.queuedBuilds()).toBe(0);
  });

  it("returns a syntax error with file and line, stores no file set and uses up no number", async () => {
    const harness = await createSaveHarness();
    await harness.write(
      "broken",
      reactPage({
        "index.tsx": fileRoute("/"),
        "history.tsx": `import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/history")({
  component: () => <p>History</p
});
`
      })
    );

    const refused = await harness.save("Broken", "broken");

    expect(refused.status).toBe("success");
    expect(refused.output?.errors).toEqual([
      expect.objectContaining({ file: "src/routes/history.tsx", line: 4 })
    ]);
    expect(refused.output?.pageId).toBeUndefined();
    expect(await harness.fileSets()).toEqual([]);
    expect([...(await everyKey(harness.files))]).toEqual([]);

    await harness.write("broken", { "src/routes/history.tsx": fileRoute("/history") });
    expect(await harness.save("Broken", "broken")).toMatchObject({ output: { number: 1 } });
  });

  it("builds a Page whose route throws at import and writes a file, and never runs it", async () => {
    const harness = await createSaveHarness();
    const marker = join(scratch, "marker-save");
    await harness.write(
      "hostile",
      reactPage({
        "index.tsx": `import { createFileRoute } from "@tanstack/react-router";
globalThis.process.getBuiltinModule("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");
throw new Error("thrown at import");
export const Route = createFileRoute("/")({ component: () => <p>never</p> });
`
      })
    );

    expect(await harness.save("Hostile", "hostile")).toMatchObject({ output: { number: 1 } });
    expect(existsSync(marker)).toBe(false);
  });

  it("moves inline script and style of an HTML Page into files, and refuses an inline handler until it is a listener", async () => {
    const harness = await createSaveHarness();
    await harness.write("plain", {
      "app.yaml": htmlManifest,
      "index.html": `<!doctype html>
<head><style>body { color: teal; }</style></head>
<body>
  <button onclick="x()">Go</button>
  <script>window.x = () => { document.title = "went"; };</script>
</body>
`
    });

    const refused = await harness.save("Plain", "plain");

    expect(refused.output?.errors).toEqual([
      expect.objectContaining({
        code: "inline_event_handler",
        file: "index.html",
        element: "button",
        attribute: "onclick"
      })
    ]);
    expect(await harness.fileSets()).toEqual([]);

    await harness.write("plain", {
      "index.html": `<!doctype html>
<head><style>body { color: teal; }</style></head>
<body>
  <button id="go">Go</button>
  <script>document.getElementById("go").addEventListener("click", () => { document.title = "went"; });</script>
</body>
`
    });
    const saved = await harness.save("Plain", "plain");

    expect(saved).toMatchObject({ output: { number: 1 } });
    const prefix = `pages/${saved.output?.pageId}/${saved.output?.fileSetId}/dist/`;
    const builtKeys = [...(await everyKey(harness.files))]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
      .sort();
    expect(builtKeys).toEqual(["index.html", "index.inline-1.css", "index.inline-2.js"]);
    const html = new TextDecoder().decode(
      await readObjectBytes(harness.files, `${prefix}index.html`)
    );
    expect(html).not.toMatch(/<style|addEventListener/u);
    expect(html).toContain('href="./index.inline-1.css"');
    expect(html).toContain('src="./index.inline-2.js"');
  });

  it("queues no build for a folder that cannot be a Page", async () => {
    const harness = await createSaveHarness({ worker: false });
    await harness.write("empty", { "index.html": "<p>no manifest</p>" });
    await harness.write("reserved", { "app.yaml": htmlManifest, "__catalyst/guard.js": "1" });
    await harness.write("large", {
      "app.yaml": htmlManifest,
      "data.json": { declaredBytes: FILE_SET_MAX_FILE_BYTES + 1 }
    });

    expect((await harness.save("Empty", "empty")).output?.errors).toEqual([
      expect.objectContaining({ file: "app.yaml", code: "manifest_invalid" })
    ]);
    expect((await harness.save("Missing", "no-such-folder")).output?.errors).toEqual([
      expect.objectContaining({ file: "app.yaml" })
    ]);
    expect((await harness.save("Reserved", "reserved")).output?.errors).toEqual([
      expect.objectContaining({ file: "__catalyst/guard.js", code: "file_set_invalid" })
    ]);
    expect((await harness.save("Large", "large")).output?.errors).toEqual([
      expect.objectContaining({ file: "data.json", code: "file_set_too_large" })
    ]);
    expect(await harness.save("Outside", "../other")).toMatchObject({ status: "failed" });
    expect(await harness.queuedBuilds()).toBe(0);
    expect(await harness.fileSets()).toEqual([]);
  });

  it("fails the save when the build is killed at its time limit, and stores nothing", async () => {
    const hang = join(scratch, "hang.mjs");
    await writeFile(hang, "setInterval(() => undefined, 1000);\n");
    const harness = await createSaveHarness({ processEntry: hang, limits: { timeoutMs: 400 } });
    await harness.write("slow", { "app.yaml": htmlManifest, "index.html": "<p>x</p>" });

    const result = await harness.save("Slow", "slow");

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "handler_failed", message: expect.stringContaining("did not finish") }
    });
    expect(await harness.fileSets()).toEqual([]);
  });

  it("refuses a file that changed after the save took its snapshot", async () => {
    const harness = await createSaveHarness({
      builds: (client) => ({
        async build(input) {
          const changed = input.request.files.find((file) => file.path === "index.html");
          if (!changed) throw new Error("The snapshot holds no index.html");
          await harness.objectStore.put(changed.objectKey, new TextEncoder().encode("<p>y</p>"));
          return client.build(input);
        }
      })
    });
    await harness.write("moving", { "app.yaml": htmlManifest, "index.html": "<p>x</p>" });

    expect(await harness.save("Moving", "moving")).toMatchObject({
      status: "failed",
      error: { message: expect.stringContaining("'index.html' changed") }
    });
    expect(await harness.fileSets()).toEqual([]);
  });

  it("gives up when no worker takes the build, and a worker that comes later stores nothing", async () => {
    const harness = await createSaveHarness({ worker: false, waitMs: 300 });
    await harness.write("waiting", { "app.yaml": htmlManifest, "index.html": "<p>x</p>" });

    expect(await harness.save("Waiting", "waiting")).toMatchObject({
      status: "failed",
      error: { message: expect.stringContaining("not built in time") }
    });

    await harness.worker.runDue();
    expect(await harness.fileSets()).toEqual([]);
    expect(await harness.queuedBuilds()).toBe(0);
  });
});

describe("the apps module and the Agent Run worker", () => {
  const snapshot = (enabled: boolean) =>
    createModuleRegistry(platformModules).snapshot({ apps: { enabled } });

  it("refuses an assembly with the module on whose worker does not serve page.bundle", async () => {
    const harness = await createWorkspaceHarness();
    const { handlers } = createPageBundleJobs({
      clientInstanceId: harness.clientInstanceId,
      stores: harness.store,
      pages: { objects: new MemoryObjectStorage() },
      workspaceObjects: harness.objectStore,
      logger: silent
    });

    expect(() => assertAgentWorkerServesModuleJobKinds(snapshot(true), [])).toThrow(
      "'modules.apps.enabled' is true, but the Agent Run worker of this assembly does not serve the job kind 'page.bundle'"
    );
    expect(() => assertAgentWorkerServesModuleJobKinds(snapshot(true), handlers)).not.toThrow();
    expect(() => assertAgentWorkerServesModuleJobKinds(snapshot(false), [])).not.toThrow();
  });

  it("assembles the platform's Agent Run worker with the module on", async () => {
    const root = await mkdtemp(join(scratch, "files-"));
    const base = createTestConfig();
    const worker = await createClientInstanceAgentRunWorker({
      config: parseClientInstanceConfig({
        ...base,
        modules: { apps: { enabled: true } },
        infrastructure: {
          ...base.infrastructure,
          objectStorage: { files: { provider: "filesystem", root } }
        }
      }),
      env: {
        BETTER_AUTH_SECRET: "a-secret-of-the-instance-with-enough-characters",
        DATABASE_URL: await fileTestDatabaseUrl()
      },
      tools: []
    });
    await worker.close();
  });
});

async function everyKey(objects: MemoryObjectStorage): Promise<Set<string>> {
  const keys = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await objects.list("", cursor);
    page.objects.forEach((object) => keys.add(object.key));
    cursor = page.cursor;
  } while (cursor);
  return keys;
}
