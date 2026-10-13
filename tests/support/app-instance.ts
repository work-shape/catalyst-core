import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { z } from "zod";
import {
  createAppAssetKind,
  createAssetRepoCommitClient,
  createAssetRepoJobs,
  createPageBuildClient,
  createPageBundleJobs,
  createSandboxAssetRepo,
  createSandboxPageBuild,
  deriveAppContentKey,
  storePageFileSet,
  type AssetRepoCommitRunner,
  type PageBuildRunner,
  type WorkflowAssetKind
} from "@vivd-catalyst/chat-server";
import {
  asConversationId,
  assetObjectPrefix,
  type CollaborationWorkspaceId,
  type JobWorker,
  type Logger
} from "@vivd-catalyst/core";
import { createPostgresJobWorker } from "@vivd-catalyst/postgres-store";
import { LocalWorkspaceCommandProcessExecutor } from "@vivd-catalyst/tool-execution";
import {
  SCOPES_HEADER,
  clientInstanceId,
  recordAuthAdapter,
  setupAccessInstance,
  type AccessInstance,
  type AccessInstanceOptions
} from "./access-instance";
import { MemoryObjectStorage } from "./memory-object-storage";
import type { TestCallInput } from "./operations";
import { assetRepoCommandFromSource } from "./asset-repo";
import { pageBuildCommandFromSource } from "./page-build";
import { callTestPath, type TestServerOptions } from "./test-instance";

// An instance with the kind `app`: the `files` store in memory, the worker that builds an
// App's files on Postgres, and a Shared Workspace with one member. `admin` holds the rights of
// the kind through the role; `kai` is a member of the workspace and holds nothing else; `lena`
// is outside it.

const silent: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => silent
};

const text = (value: string) => new TextEncoder().encode(value);
export const sha256 = (value: string | Uint8Array) =>
  createHash("sha256")
    .update(typeof value === "string" ? text(value) : value)
    .digest("hex");

/** One source file as a write carries it. */
export type AppFile = { path: string; text: string } | { path: string; base64: string };

/** A manifest as JSON text, which is YAML too: the stand-in build reads it without a parser. */
function appManifest(overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ id: "offers", name: "Offers", kit: "1.0.0", entry: "index.html", ...overrides })}\n`;
}

/** The source set of a plain HTML App whose page shows `marker`. */
export function appFiles(marker: string, manifest: Record<string, unknown> = {}): AppFile[] {
  return [
    { path: "app.yaml", text: appManifest(manifest) },
    { path: "index.html", text: `<!doctype html><title>Offers</title><p>${marker}</p>` }
  ];
}

const manifestSchema = z.object({
  id: z.string(),
  name: z.string(),
  kit: z.string(),
  entry: z.string(),
  connections: z.array(z.string()).optional()
});

/**
 * A build that needs no sandbox: it reads the manifest and hands every other file on as built.
 * What a real build does to a Page is the subject of the build's own tests.
 */
const standInBuild: PageBuildRunner = async ({ files }) => {
  const manifestFile = files.find((file) => file.path === "app.yaml");
  const manifest = manifestSchema.parse(
    JSON.parse(new TextDecoder().decode(manifestFile?.bytes ?? text("{}")))
  );
  return {
    status: "built",
    manifest,
    kitVersion: manifest.kit,
    files: files.filter((file) => file.path !== "app.yaml").map((file) => ({ ...file }))
  };
};

export interface AppInstanceOptions {
  /** `sandbox` builds with the real command, as a process. The stand-in when left out. */
  build?: "sandbox" | PageBuildRunner;
  /** Without a worker nothing serves `page.bundle`. */
  worker?: boolean;
  /**
   * What makes the commits of repositories: the real command with the git of this machine when
   * left out, a runner of the test's own, or `false` for an instance where nothing serves
   * `asset_repo.commit`.
   */
  commits?: AssetRepoCommitRunner | false;
  /** The `files` store, where a test watches or fails what is put. */
  objects?: MemoryObjectStorage;
  /** Replaces `APP_BUILD_WAIT_MS`. */
  assetWaitMs?: number;
  /**
   * The sign-in takes a token beside the ambient test header, as an instance with keys does: a
   * call that carries `authorization` is then a call of the CLI.
   */
  explicitCredentials?: boolean;
  /** Kinds registered beside agent, skill and app. */
  furtherKinds?: WorkflowAssetKind[];
  /** The App kind with something of the test's own, such as an `authorizeLive`. */
  appKind?: WorkflowAssetKind;
  /** Modules that are on beside `apps`, such as `{ connections: { enabled: true } }`. */
  modules?: AccessInstanceOptions["modules"];
  /** Further server options, such as a policy or an audit recorder of the test's own. */
  server?: (
    ...input: Parameters<NonNullable<AccessInstanceOptions["server"]>>
  ) => Partial<TestServerOptions>;
  /** Registers the operations of a further module, such as the routes of `workflows`. */
  register?: AccessInstanceOptions["register"];
}

export interface AppInstance extends AccessInstance {
  objects: MemoryObjectStorage;
  /** The Shared Workspace the Apps of a test belong to. `kai` is a member, `lena` is not. */
  workspaceId: CollaborationWorkspaceId;
  /** Writes an App from files as `userId`. Creates it where it does not exist. */
  putApp(
    userId: string,
    name: string,
    files: AppFile[],
    input?: Pick<TestCallInput, "headers">
  ): ReturnType<AccessInstance["call"]>;
  publish(userId: string, name: string, revision: number): ReturnType<AccessInstance["call"]>;
  /** The App as `assets.list` shows it to the administrator. */
  listed(
    name: string
  ): Promise<{ revision: number; draftRevision?: number; publishedRevision?: number }>;
  /** The document a frame is answered at the address `apps.preview` gave. */
  open(url: string): Promise<{ status: number; body: string }>;
  /**
   * A Page with one revision in a conversation of the administrator, stored as a save stores
   * it. With `conversationId` the Page of that conversation gets its next revision instead.
   * `shared` puts a new conversation into the Shared Workspace, where `kai` reads it.
   */
  storePage(
    marker: string,
    manifest?: Record<string, unknown>,
    options?: { conversationId?: string; kitVersion?: string; shared?: boolean }
  ): Promise<{ conversationId: string; pageId: string }>;
  /** Every object below the prefix of one asset. */
  objectKeys(assetId: string): string[];
  close(): Promise<void>;
}

const listedSchema = z.object({
  items: z.array(
    z.looseObject({
      name: z.string(),
      revision: z.number(),
      draftRevision: z.number().optional(),
      publishedRevision: z.number().optional()
    })
  )
});

export async function setupAppInstance(options: AppInstanceOptions = {}): Promise<AppInstance> {
  const objects = options.objects ?? new MemoryObjectStorage();
  const pages = { objects, contentKey: deriveAppContentKey("content-secret-".repeat(4)) };
  const access = await setupAccessInstance({
    modules: { ...options.modules, apps: { enabled: true } },
    furtherKinds: [options.appKind ?? createAppAssetKind(), ...(options.furtherKinds ?? [])],
    server: (stores, config) => ({
      pages: {
        ...pages,
        assetBuilds: createPageBuildClient({
          stores,
          pollIntervalMs: 20,
          ...(options.assetWaitMs === undefined ? {} : { assetWaitMs: options.assetWaitMs })
        }),
        assetRepo: createAssetRepoCommitClient({
          stores,
          pollIntervalMs: 20,
          // An instance without the worker says so at once.
          ...(options.commits === false
            ? { unclaimedMs: 100, workerCheckIntervalMs: 20, waitMs: 5_000 }
            : {})
        })
      },
      allowedOrigins: ["https://ui.example.test"],
      ...(options.explicitCredentials
        ? { authAdapter: { ...recordAuthAdapter(stores), credentialMode: "explicit" as const } }
        : {}),
      ...options.server?.(stores, config)
    }),
    ...(options.register ? { register: options.register } : {})
  });
  const { stores, instance, admin, kai } = access;
  let scratch: string | undefined;
  let build: PageBuildRunner = standInBuild;
  if (options.build === "sandbox") {
    scratch = await mkdtemp(join(tmpdir(), "app-build-test-"));
    build = createSandboxPageBuild({
      sandbox: new LocalWorkspaceCommandProcessExecutor(),
      tempRoot: join(scratch, "builds"),
      command: await pageBuildCommandFromSource()
    });
  } else if (options.build) {
    build = options.build;
  }
  let worker: JobWorker | undefined;
  if (options.worker !== false) {
    worker = createPostgresJobWorker({
      stores,
      clientInstanceId,
      logger: silent,
      handlers: createPageBundleJobs({
        clientInstanceId,
        stores,
        pages: { objects },
        workspaceObjects: undefined,
        logger: silent,
        build
      }).handlers
    });
    worker.start();
  }
  let committer: JobWorker | undefined;
  if (options.commits !== false) {
    scratch ??= await mkdtemp(join(tmpdir(), "app-build-test-"));
    committer = createPostgresJobWorker({
      stores,
      clientInstanceId,
      logger: silent,
      handlers: createAssetRepoJobs({
        clientInstanceId,
        stores,
        objects,
        workspaceObjects: undefined,
        logger: silent,
        commit:
          options.commits ??
          createSandboxAssetRepo({
            sandbox: new LocalWorkspaceCommandProcessExecutor(),
            tempRoot: join(scratch, "commits"),
            command: `'${process.execPath}' '${await assetRepoCommandFromSource()}'`
          })
      }).handlers
    });
    committer.start();
  }
  const workspaceId = await access.sharedWorkspace("Sales");
  await stores.workspaces.addMembership({
    clientInstanceId,
    collaborationWorkspaceId: workspaceId,
    userId: kai.id,
    role: "member"
  });

  return {
    ...access,
    objects,
    workspaceId,
    putApp: (userId, name, files, input = {}) =>
      access.call(userId, "assets.put", {
        ...input,
        params: { kind: "app", name },
        payload: { files, workspaceId }
      }),
    publish: (userId, name, revision) =>
      access.call(userId, "assets.publish", {
        params: { kind: "app", name },
        payload: { revision, workspaceId }
      }),
    async listed(name) {
      const response = await access.expectOk(admin.id, "assets.list", {
        params: { kind: "app" },
        query: { workspaceId }
      });
      const found = listedSchema.parse(response.json()).items.find((item) => item.name === name);
      if (!found) throw new Error(`No App '${name}' in the list`);
      return found;
    },
    async open(url) {
      const response = await callTestPath(instance, "GET", url, { "sec-fetch-dest": "iframe" });
      return { status: response.statusCode, body: response.body };
    },
    async storePage(marker, manifest = {}, options = {}) {
      const conversationId =
        options.conversationId ??
        z.object({ id: z.string() }).parse(
          (
            await access.expectOk(admin.id, "conversations.create", {
              payload: {
                title: "Offers",
                ...(options.shared ? { collaborationWorkspaceId: workspaceId } : {})
              }
            })
          ).json()
        ).id;
      const kit = options.kitVersion ?? "1.0.0";
      const html = text(`<!doctype html><title>Offers</title><p>${marker}</p>`);
      const stored = await storePageFileSet(
        { clientInstanceId, stores, pages },
        {
          conversationId: asConversationId(conversationId),
          pageName: "Offers",
          kitVersion: kit,
          manifest: { id: "offers-page", name: "Offers", kit, entry: "index.html", ...manifest },
          sourceFiles: [
            {
              path: "app.yaml",
              bytes: text(appManifest({ id: "offers-page", kit, ...manifest }))
            },
            { path: "index.html", bytes: html }
          ],
          builtFiles: [{ path: "index.html", bytes: html }]
        }
      );
      return { conversationId, pageId: stored.page.id };
    },
    objectKeys: (assetId) =>
      objects.keys().filter((key) => key.startsWith(assetObjectPrefix(assetId))),
    async close() {
      await worker?.stop();
      await committer?.stop();
      await instance.close();
      if (scratch) await rm(scratch, { recursive: true, force: true });
    }
  };
}

/** A call with a credential that carries these scopes and no other. */
export function withScopes(...scopes: string[]): Pick<TestCallInput, "headers"> {
  return { headers: { [SCOPES_HEADER]: scopes.join(" ") } };
}

/** The response of a write that carried files. */
export const fileWriteSchema = z.looseObject({
  version: z.number(),
  revision: z.number(),
  fileSetId: z.string(),
  files: z.array(z.object({ path: z.string(), sha256: z.string(), bytes: z.number() }))
});

export const previewSchema = z.looseObject({
  url: z.string(),
  fileSetId: z.string(),
  number: z.number(),
  revision: z.number(),
  interfacePath: z.string()
});

export function expectStatus(
  response: Awaited<ReturnType<AccessInstance["call"]>>,
  status: number
): void {
  expect(response.statusCode, response.body).toBe(status);
}
