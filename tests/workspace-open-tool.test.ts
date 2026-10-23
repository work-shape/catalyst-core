import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { RELEASED_KIT_VERSIONS, type PageBuildLimits } from "@work-shape/catalyst-app-build";
import {
  createPageBuildClient,
  createPageBundleJobs,
  createSandboxPageBuild,
  PAGE_BUILD_NO_WORKER_MESSAGE,
  pageBundleJob
} from "@work-shape/catalyst-server";
import {
  createPageBuildId,
  FILE_SET_MAX_FILE_BYTES,
  readObjectBytes,
  type JobWorker,
  type Logger,
  type PageBuildClient,
  type PageBuildId
} from "@work-shape/catalyst-core";
import { createPostgresJobWorker } from "@work-shape/catalyst-postgres-store";
import {
  createWorkspaceOpenTool,
  LocalWorkspaceCommandProcessExecutor,
  ToolRegistry,
  WorkspaceCommandService
} from "@work-shape/catalyst-tool-execution";
import { MemoryObjectStorage } from "./support/memory-object-storage";
import {
  fileRoute,
  htmlManifest,
  pageBuildCommandFromSource,
  reactManifest,
  rootRoute
} from "./support/page-build";
import { createTestToolRunner } from "./support/tool-runner";
import { createWorkspaceHarness } from "./support/workspace-tools-harness";

// Opening a file or folder in the preview through the tool an agent calls: the folder in the
// conversation's Execution Workspace is snapshotted, built by the `page.bundle` job as a command
// in the sandbox and stored as a file set of the conversation's preview of that path. The job worker here is the executor's, on Postgres; the sandbox is the
// local one, which runs the command as a process.

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
const openOutputSchema = z.looseObject({
  pageId: z.string().optional(),
  number: z.number().optional(),
  fileSetId: z.string().optional(),
  title: z.string().optional(),
  errors: z.array(issueSchema).optional()
});

let buildCommand: string;
let scratch: string;
const workers: JobWorker[] = [];

beforeAll(async () => {
  buildCommand = await pageBuildCommandFromSource();
  scratch = await mkdtemp(join(tmpdir(), "workspace-open-test-"));
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
    /** Replaces the build command, as shell text. */
    command?: string;
    limits?: Partial<PageBuildLimits>;
    builds?: (client: PageBuildClient) => PageBuildClient;
    waitMs?: number;
    /** After how long without a claim a save concludes that no worker takes builds. */
    unclaimedMs?: number;
    /** Runs before each object of a built Page is stored. */
    beforeStore?: () => Promise<void>;
  } = {}
) {
  const harness = await createWorkspaceHarness();
  const { store, clientInstanceId, conversation, objectStore } = harness;
  const files = new HookedObjectStorage(options.beforeStore);
  let buildsRun = 0;
  const service = new WorkspaceCommandService({
    store,
    objectStore,
    fileStore: objectStore,
    now: () => new Date().toISOString()
  });
  const client = createPageBuildClient({
    stores: store,
    pollIntervalMs: 20,
    ...(options.waitMs === undefined ? {} : { waitMs: options.waitMs }),
    ...(options.unclaimedMs === undefined
      ? {}
      : { unclaimedMs: options.unclaimedMs, workerCheckIntervalMs: 20 })
  });
  const tool = createWorkspaceOpenTool({
    workspace: service.dependencies,
    builds: options.builds?.(client) ?? client
  });
  const execution = createTestToolRunner({
    registry: new ToolRegistry({ tools: [tool] }),
    getAgentToolNames: () => [tool.name]
  });
  const sandboxBuild = createSandboxPageBuild({
    sandbox: new LocalWorkspaceCommandProcessExecutor(),
    tempRoot: join(scratch, "builds"),
    command: options.command ?? buildCommand
  });
  const { handlers } = createPageBundleJobs({
    clientInstanceId,
    stores: store,
    pages: { objects: files },
    workspaceObjects: objectStore,
    logger: silent,
    ...(options.limits ? { limits: options.limits } : {}),
    build: (input) => {
      buildsRun += 1;
      return sandboxBuild(input);
    }
  });
  const worker = createPostgresJobWorker({
    stores: store,
    clientInstanceId,
    logger: silent,
    handlers
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
    subject: async () =>
      (await store.conversations.getConversation(clientInstanceId, conversation.id))?.subject,
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
    async open(path: string) {
      const request = harness.createRequest("workspace.open", { path });
      const result = await execution(request, harness.context);
      return {
        status: result.status,
        output: result.status === "success" ? openOutputSchema.parse(result.output) : undefined,
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
    buildsRun: () => buildsRun,
    /**
     * A build client that queues the build as a save does and then delivers its job by hand,
     * as often as the test says, in place of a worker. It answers what the row holds after.
     */
    deliveredByHand(
      deliver: (
        run: (control?: { stopBeforeCommit: boolean }) => Promise<void>,
        buildId: PageBuildId
      ) => Promise<void>,
      job: { subject?: string; concurrencyKey?: string } = {}
    ): PageBuildClient {
      return {
        async build(input) {
          const buildId = createPageBuildId();
          await store.pages.createPageBuild({
            clientInstanceId,
            id: buildId,
            conversationId: input.conversationId,
            request: input.request,
            createdAt: new Date().toISOString()
          });
          const queued = await store.jobs.enqueue(
            pageBundleJob,
            { buildId },
            {
              clientInstanceId,
              subject: job.subject ?? buildId,
              concurrencyKey: job.concurrencyKey ?? input.conversationId
            }
          );
          const [handler] = handlers;
          if (!handler) throw new Error("No handler serves page.bundle");
          const run = (control?: { stopBeforeCommit: boolean }) =>
            handler.bind(queued).run({
              leaseToken: "by-hand",
              signal: new AbortController().signal,
              attempt: 1,
              logger: silent,
              transaction: (fn) =>
                store.transaction(async (stores) => {
                  const result = await fn(stores);
                  if (control?.stopBeforeCommit) throw new Error("the worker was stopped");
                  return result;
                })
            });
          await deliver(run, buildId);
          const row = await store.pages.getPageBuild({ clientInstanceId, buildId });
          // `stored` is the result of an asset's build, which this client never queues.
          return row?.result && row.result.status !== "stored"
            ? row.result
            : { status: "failed", message: "The build has no result." };
        }
      };
    },
    async pages() {
      return store.pages.listPages({ clientInstanceId, conversationId: conversation.id });
    },
    async queuedBuilds() {
      const summary = await store.jobs.summarizeByKind({ clientInstanceId });
      return summary.find((kind) => kind.kind === "page.bundle")?.queued ?? 0;
    }
  };
}

type SaveHarness = Awaited<ReturnType<typeof createSaveHarness>>;

/** The harness's own build client, for a harness that is being made when it is asked for. */
function later(harness: () => SaveHarness): Pick<SaveHarness, "deliveredByHand"> {
  return {
    deliveredByHand: (...args) => ({
      build: (input) =>
        harness()
          .deliveredByHand(...args)
          .build(input)
    })
  };
}

/** An object store whose writes a test can interrupt or precede with something. */
class HookedObjectStorage extends MemoryObjectStorage {
  constructor(private readonly beforePut?: () => Promise<void>) {
    super();
  }

  override async put(...args: Parameters<MemoryObjectStorage["put"]>): Promise<void> {
    await this.beforePut?.();
    await super.put(...args);
  }
}

const reactPage = (routes: Record<string, string>) => ({
  "app.yaml": reactManifest,
  "src/routes/__root.tsx": rootRoute,
  ...Object.fromEntries(Object.entries(routes).map(([name, text]) => [`src/routes/${name}`, text]))
});

describe("workspace.open", () => {
  it("keeps its opening sentence and tells the agent where fonts and libraries belong", async () => {
    const harness = await createWorkspaceHarness();
    const tool = createWorkspaceOpenTool({
      workspace: new WorkspaceCommandService({
        store: harness.store,
        objectStore: harness.objectStore,
        fileStore: harness.objectStore
      }).dependencies,
      builds: {
        build: async () => {
          throw new Error("Description only");
        }
      }
    });
    expect(tool.description).toMatch(/^Show an HTML file or a folder/u);
    expect(tool.description).toContain(`which is ${RELEASED_KIT_VERSIONS.at(-1)} for a new App`);
    for (const rule of [
      "allow-scripts allow-forms allow-downloads",
      "without allow-same-origin",
      "form-action 'none'",
      "localStorage",
      "storage.get/set",
      "Data Stores",
      "Network",
      "SecurityError"
    ])
      expect(tool.description).toContain(rule);
    expect(tool.description).toContain(
      "Put fonts and libraries in the App's folder or use the kit's; an outside address (Google Fonts, Adobe Fonts or a CDN) will not load."
    );
  });
  it("builds the folder into revision 1, and a second open into revision 2", async () => {
    const harness = await createSaveHarness();
    await harness.write("calculator", reactPage({ "index.tsx": fileRoute("/") }));
    await harness.write("other", { "notes.txt": "not part of the Page" });

    const first = await harness.open("calculator");

    expect(first).toMatchObject({ status: "success", output: { number: 1 } });
    expect(first.output?.errors).toBeUndefined();
    // A preview belongs to its conversation and is no subject of it: an open moves nothing the
    // conversation is about, so it may still be moved into a shared workspace for everyone.
    expect(await harness.subject()).toBeUndefined();
    const [page] = await harness.store.pages.listPages({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id
    });
    if (!page) throw new Error("The open stored no preview");
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
    const second = await harness.open("calculator");

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

    const refused = await harness.open("broken");

    expect(refused.status).toBe("success");
    expect(refused.output?.errors).toEqual([
      expect.objectContaining({ file: "src/routes/history.tsx", line: 4 })
    ]);
    expect(refused.output?.pageId).toBeUndefined();
    expect(await harness.subject()).toBeUndefined();
    expect(await harness.fileSets()).toEqual([]);
    expect([...(await everyKey(harness.files))]).toEqual([]);

    await harness.write("broken", { "src/routes/history.tsx": fileRoute("/history") });
    expect(await harness.open("broken")).toMatchObject({ output: { number: 1 } });
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

    expect(await harness.open("hostile")).toMatchObject({ output: { number: 1 } });
    expect(existsSync(marker)).toBe(false);
  });

  // Check 53 of apps-and-pages: an HTML file opens as it is, and an open keeps nothing. Fails
  // without the plain manifest of the build: a folder without app.yaml was refused.
  it("opens a loose index.html as plain HTML, and leaves no asset, App or App revision", async () => {
    const harness = await createSaveHarness();
    await harness.write("weather", { "index.html": "<!doctype html><h1>Hamburg</h1>" });

    const opened = await harness.open("weather/index.html");

    expect(opened).toMatchObject({ status: "success", output: { number: 1 } });
    const [page] = await harness.pages();
    if (!page) throw new Error("The open stored no preview");
    expect(page.name).toBe("weather/index.html");
    const stored = await harness.store.pages.getPageFileSet({
      clientInstanceId: harness.clientInstanceId,
      pageId: page.id
    });
    expect(stored).toMatchObject({
      kitVersion: RELEASED_KIT_VERSIONS.at(-1),
      manifest: { id: "index", entry: "index.html" }
    });
    expect(stored?.builtFiles.map((file) => file.path)).toContain("index.html");
    // The folder of a later open of the same path has no manifest either: the build's own
    // stands in for it, so the folder opens again as it is.
    expect(await harness.open("weather")).toMatchObject({ output: { number: 1 } });
    expect(await harness.subject()).toBeUndefined();
    const assets = await harness.store.configAssets.listActiveConfigAssets({
      clientInstanceId: harness.clientInstanceId
    });
    expect(assets.filter((asset) => asset.kind === "app")).toEqual([]);
  });

  // OPEN-1f: what Save as app proposes. Fails without it: the open answered no name, and the
  // dialog proposed the path.
  it("answers the name the folder gives itself: its manifest's, else its HTML title, else none", async () => {
    const harness = await createSaveHarness();
    await harness.write("calculator", reactPage({ "index.tsx": fileRoute("/") }));
    await harness.write("offers", {
      "app.yaml": htmlManifest,
      "index.html": "<!doctype html><title>Not the manifest's</title><h1>Offers</h1>"
    });
    await harness.write("weather", {
      "index.html": "<!doctype html><title>\n  Wetter &amp; Wind </title><h1>Hamburg</h1>"
    });
    await harness.write("plain", { "index.html": "<!doctype html><h1>Hamburg</h1>" });

    expect((await harness.open("calculator")).output?.title).toBe("Demo Page");
    expect((await harness.open("offers")).output?.title).toBe("Demo Page");
    expect((await harness.open("weather/index.html")).output?.title).toBe("Wetter & Wind");
    const untitled = await harness.open("plain");
    expect(untitled).toMatchObject({ status: "success", output: { number: 1 } });
    // The manifest the build gives plain HTML names its entry file, which is no name.
    expect(untitled.output).not.toHaveProperty("title");
  });

  it("refuses to open a file that is no HTML, and builds nothing for it", async () => {
    const harness = await createSaveHarness({ worker: false });
    await harness.write("data", { "rows.csv": "a,b\n1,2\n" });

    expect((await harness.open("data/rows.csv")).output?.errors).toEqual([
      expect.objectContaining({ file: "data/rows.csv", code: "file_invalid" })
    ]);
    expect(await harness.queuedBuilds()).toBe(0);
  });

  // Ran the file before the refusal matched the route generator's own pattern.
  it("refuses a route config the generator would run, by any prefix and in any folder, and stores nothing", async () => {
    const harness = await createSaveHarness();
    const marker = join(scratch, "marker-virtual");
    const payload = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\nmodule.exports = [];\n`;
    await harness.write("bypass", {
      ...reactPage({ "index.tsx": fileRoute("/") }),
      "src/routes/sub/a__virtual.js": payload
    });

    expect((await harness.open("bypass")).output?.errors).toEqual([
      expect.objectContaining({ file: "src/routes/sub/a__virtual.js", code: "routes_invalid" })
    ]);
    expect(existsSync(marker)).toBe(false);
    expect(await harness.fileSets()).toEqual([]);
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

    const refused = await harness.open("plain");

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
    const saved = await harness.open("plain");

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

  it("queues no build for a path that cannot be shown", async () => {
    const harness = await createSaveHarness({ worker: false });
    await harness.write("empty", { "notes.txt": "no manifest and no index.html" });
    await harness.write("reserved", { "app.yaml": htmlManifest, "__catalyst/guard.js": "1" });
    await harness.write("large", {
      "app.yaml": htmlManifest,
      "data.json": { declaredBytes: FILE_SET_MAX_FILE_BYTES + 1 }
    });

    expect((await harness.open("empty")).output?.errors).toEqual([
      expect.objectContaining({ file: "app.yaml", code: "manifest_invalid" })
    ]);
    expect((await harness.open("no-such-folder")).output?.errors).toEqual([
      expect.objectContaining({ file: "app.yaml" })
    ]);
    expect((await harness.open("reserved")).output?.errors).toEqual([
      expect.objectContaining({ file: "__catalyst/guard.js", code: "file_set_invalid" })
    ]);
    expect((await harness.open("large")).output?.errors).toEqual([
      expect.objectContaining({ file: "data.json", code: "file_set_too_large" })
    ]);
    expect(await harness.open("../other")).toMatchObject({ status: "failed" });
    expect(await harness.queuedBuilds()).toBe(0);
    expect(await harness.fileSets()).toEqual([]);
  });

  it("fails the save when the build is killed at its time limit, and stores nothing", async () => {
    const harness = await createSaveHarness({ command: "sleep 30 #", limits: { timeoutMs: 200 } });
    await harness.write("slow", { "app.yaml": htmlManifest, "index.html": "<p>x</p>" });

    const result = await harness.open("slow");

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

    expect(await harness.open("moving")).toMatchObject({
      status: "failed",
      error: { message: expect.stringContaining("'index.html' changed") }
    });
    expect(await harness.fileSets()).toEqual([]);
  });

  it("gives up when no worker takes the build, and a worker that comes later stores nothing", async () => {
    const harness = await createSaveHarness({ worker: false, waitMs: 300 });
    await harness.write("waiting", { "app.yaml": htmlManifest, "index.html": "<p>x</p>" });

    expect(await harness.open("waiting")).toMatchObject({
      status: "failed",
      error: { message: expect.stringContaining("not built in time") }
    });

    await harness.worker.runDue();
    expect(await harness.fileSets()).toEqual([]);
    expect(await harness.queuedBuilds()).toBe(0);
  });
});

describe("one save and its one revision", () => {
  const page = { "app.yaml": htmlManifest, "index.html": "<p>x</p>" };

  it("publishes one revision when the worker stops as it publishes and the job is delivered again, and again", async () => {
    const harness = await createSaveHarness({
      worker: false,
      builds: () =>
        later(() => harness).deliveredByHand(async (run) => {
          // The files are stored and the write of the revision is under way when it ends.
          await expect(run({ stopBeforeCommit: true })).rejects.toThrow("the worker was stopped");
          expect(await harness.fileSets()).toEqual([]);
          await run();
          // Delivered once more after it was published: the result is there, nothing is built.
          await run();
        })
    });
    await harness.write("once", page);

    const saved = await harness.open("once");

    expect(saved.output).toMatchObject({ number: 1 });
    expect((await harness.fileSets()).map((set) => set.number)).toEqual([1]);
    expect(harness.buildsRun()).toBe(2);
  });

  it("leaves nothing behind when the worker stops while it stores, and the next delivery publishes one revision", async () => {
    let stores = 0;
    const harness = await createSaveHarness({
      worker: false,
      // The second object of the first delivery is never written.
      beforeStore: async () => {
        stores += 1;
        if (stores === 2) throw new Error("the worker was stopped");
      },
      builds: () =>
        later(() => harness).deliveredByHand(async (run, buildId) => {
          await expect(run()).rejects.toThrow("the worker was stopped");
          expect(await harness.fileSets()).toEqual([]);
          expect(await harness.pages()).toEqual([]);
          expect((await harness.files.list("")).objects).toEqual([]);
          const row = await harness.store.pages.getPageBuild({
            clientInstanceId: harness.clientInstanceId,
            buildId
          });
          expect(row?.result).toBeUndefined();
          await run();
        })
    });
    await harness.write("stopped", page);

    const saved = await harness.open("stopped");

    expect(saved.output).toMatchObject({ number: 1 });
    expect((await harness.fileSets()).map((set) => set.number)).toEqual([1]);
  });

  it("publishes no revision for a save that gave up while the built files were stored", async () => {
    let gaveUp: (() => Promise<boolean>) | undefined;
    const harness = await createSaveHarness({
      worker: false,
      // The handler has looked at the row already when the first object is written.
      beforeStore: async () => {
        await gaveUp?.();
        gaveUp = undefined;
      },
      builds: () =>
        later(() => harness).deliveredByHand(async (run, buildId) => {
          gaveUp = () =>
            harness.store.pages.finishPageBuild({
              clientInstanceId: harness.clientInstanceId,
              buildId,
              result: { status: "failed", message: "The save gave up." },
              finishedAt: new Date().toISOString()
            });
          await run();
        })
    });
    await harness.write("late", page);

    expect(await harness.open("late")).toMatchObject({
      status: "failed",
      error: { message: expect.stringContaining("The save gave up.") }
    });
    expect(await harness.fileSets()).toEqual([]);
    expect(await harness.pages()).toEqual([]);
    expect((await harness.files.list("")).objects).toEqual([]);
  });

  it("does nothing for a job whose subject or key is not that of the build it names", async () => {
    for (const forged of [
      { subject: "pbuild_of-another-save" },
      { concurrencyKey: "conv_other" }
    ]) {
      const harness = await createSaveHarness({
        worker: false,
        builds: () => later(() => harness).deliveredByHand((run) => run(), forged)
      });
      await harness.write("forged", page);

      expect(await harness.open("forged")).toMatchObject({
        status: "failed",
        error: { message: expect.stringContaining("The build has no result.") }
      });
      expect(harness.buildsRun()).toBe(0);
      expect(await harness.fileSets()).toEqual([]);
    }
  });
});

describe("a save on an instance where no worker takes builds", () => {
  it("fails with the reason as soon as the build has waited unclaimed, long before the wait is over", async () => {
    const harness = await createSaveHarness({ worker: false, unclaimedMs: 200 });
    await harness.write("unserved", { "app.yaml": htmlManifest, "index.html": "<p>x</p>" });
    const started = Date.now();

    const result = await harness.open("unserved");

    expect(result).toMatchObject({
      status: "failed",
      error: { message: PAGE_BUILD_NO_WORKER_MESSAGE }
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    await harness.worker.runDue();
    expect(await harness.fileSets()).toEqual([]);
  });

  it("builds a save that waited behind builds that ended back to back for longer than the unclaimed time", async () => {
    // One conversation builds one Page at a time, so these builds run one after the other
    // and between two of them none is running.
    const harness = await createSaveHarness({
      command: `sleep 0.3 && ${buildCommand}`,
      unclaimedMs: 500
    });
    const names = ["first", "second", "third"];
    for (const name of names) {
      await harness.write(name, { "app.yaml": htmlManifest, "index.html": `<p>${name}</p>` });
    }
    const started = Date.now();

    const results = await Promise.all(names.map((name) => harness.open(name)));

    expect(results.map((result) => result.error?.message)).toEqual(names.map(() => undefined));
    expect(results.map((result) => result.status)).toEqual(names.map(() => "success"));
    expect(Date.now() - started).toBeGreaterThan(500 + 300);
    expect(await harness.fileSets()).toHaveLength(names.length);
  }, 60_000);

  it("waits for a build that a worker is running, however long it has been queued", async () => {
    const harness = await createSaveHarness({ command: "sleep 0.6 #", unclaimedMs: 200 });
    await harness.write("slow", { "app.yaml": htmlManifest, "index.html": "<p>x</p>" });

    const result = await harness.open("slow");

    // The build ran to its end, which here is a command that wrote nothing.
    expect(result.error?.message).not.toBe(PAGE_BUILD_NO_WORKER_MESSAGE);
    expect(result).toMatchObject({ status: "failed" });
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
