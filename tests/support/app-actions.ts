import { vi } from "vitest";
import { z } from "zod";
import type { PageBuildOutcome } from "@work-shape/catalyst-app-build";
import { buildPage } from "@work-shape/catalyst-app-build/build";
import { storePageFileSet } from "@work-shape/catalyst-server";
import { asConversationId, type OperationRun, type RateLimiter } from "@work-shape/catalyst-core";
import { clientInstanceId, errorSchema } from "./access-instance";
import {
  expectStatus,
  setupAppInstance,
  type AppFile,
  type AppInstanceOptions
} from "./app-instance";
import { fixtureOn, operationOf } from "./connection-operations";
import { pageFiles } from "./page-build";

// What the tests of a frame's calls share: an instance with Apps and Connections on real
// rows, the real build that compiles the action files, the App `orders` with a published
// revision and a draft, and the calls the interface makes for a frame.

export const action = (lines: string[]) => `${lines.join("\n")}\n`;
const actionText = {
  schema: "  schema: { type: object, properties: { text: { type: string } }, required: [text] }",
  mapping: '  mapping: { text: "{{text}}" }'
};

/** An App with a reading action, a changing one and one on an operation agents alone reach. */
export function appSource(marker: string, id = "orders"): AppFile[] {
  return [
    {
      path: "app.yaml",
      text: JSON.stringify({
        id,
        name: "Orders",
        kit: "1.1.0",
        entry: "index.html",
        connections: ["crm", "erp"]
      })
    },
    { path: "index.html", text: `<!doctype html><title>Orders</title><p>${marker}</p>` },
    {
      path: "actions/load.action.yaml",
      text: action([
        "connection: crm",
        "operation: echo",
        "effect: reading",
        "description: Reads one row.",
        "input:",
        actionText.schema,
        actionText.mapping
      ])
    },
    {
      path: "actions/save.action.yaml",
      text: action([
        "connection: crm",
        "operation: write",
        "effect: changing",
        "input:",
        "  schema: { type: object, properties: { note: { type: string } }, required: [note] }",
        '  mapping: { note: "{{note}}", source: app }'
      ])
    },
    {
      path: "actions/agent-only.action.yaml",
      text: action([
        "connection: erp",
        "operation: echo",
        "effect: reading",
        "input:",
        actionText.schema,
        actionText.mapping
      ])
    }
  ];
}

const frameSchema = z.looseObject({
  url: z.string(),
  fileSetId: z.string(),
  pageSessionId: z.string()
});
export const resultSchema = z.object({
  runId: z.string(),
  status: z.enum(["done", "pending_approval"]),
  result: z.unknown().optional()
});

/** What the interface holds of a frame: the page session and what proves it to the instance. */
export interface Frame {
  pageSessionId: string;
  proof: { fileSetId: string; token: string };
}

function frameOf(preview: unknown): Frame {
  const { url, fileSetId, pageSessionId } = frameSchema.parse(preview);
  const segments = url.split("/").filter(Boolean);
  const token = segments[segments.indexOf(fileSetId) + 1];
  if (token === undefined) throw new Error("The address holds no token");
  return { pageSessionId, proof: { fileSetId, token } };
}

/** What a test adds to the instance: a limiter of its own, and what a further module brings. */
export interface AppActionsOptions extends Pick<
  AppInstanceOptions,
  "furtherKinds" | "modules" | "register"
> {
  /** What the real build answered, changed: a build is a sandboxed process that is not trusted. */
  tamper?(built: PageBuildOutcome): PageBuildOutcome;
  rateLimiter?: RateLimiter;
  /** The person context header the Connector type `test` sends. None when absent. */
  personContextHeader?: string;
  /** Further server options, made with the ones the fixture built, such as its call path. */
  server?: (
    stores: Parameters<NonNullable<AppInstanceOptions["server"]>>[0],
    config: Parameters<NonNullable<AppInstanceOptions["server"]>>[1],
    built: ReturnType<NonNullable<AppInstanceOptions["server"]>>
  ) => ReturnType<NonNullable<AppInstanceOptions["server"]>>;
}

const instance = (further: AppActionsOptions) =>
  fixtureOn(
    (options) =>
      setupAppInstance({
        modules: { ...options.modules, ...further.modules },
        furtherKinds: [...(options.furtherKinds ?? []), ...(further.furtherKinds ?? [])],
        server: (stores, config, kinds) => {
          const built = {
            ...options.server?.(stores, config, kinds),
            ...(further.rateLimiter ? { rateLimiter: further.rateLimiter } : {})
          };
          return { ...built, ...further.server?.(stores, config, built) };
        },
        ...(further.register ? { register: further.register } : {}),
        // The real build, in this process: it compiles the action files into the manifest.
        build: async ({ files, signal }) => {
          const built = await buildPage({ files, signal });
          return further.tamper?.(built) ?? built;
        }
      }),
    further.personContextHeader === undefined
      ? {}
      : { personContextHeader: further.personContextHeader }
  );
type Base = Awaited<ReturnType<typeof instance>>;
type Called = Awaited<ReturnType<Base["call"]>>;

/** The calls the interface makes for a frame, and what the tests read of them. */
interface AppActionHelpers {
  /** The asset id of the Connection `crm`. */
  crm: string;
  openApp(userId: string, mode: "draft" | "published", app?: string): Promise<Frame>;
  /**
   * A Page in a conversation of `userId`, and its frame: with the actions of the App `orders`
   * unless the test brings the Page's files.
   */
  openPage(userId: string, source?: AppFile[]): Promise<Frame & { pageId: string }>;
  callAction(
    userId: string,
    frame: Frame,
    name: string,
    input: unknown,
    headers?: Record<string, string>
  ): Promise<Called>;
  can(userId: string, frame: Frame): Promise<Record<string, string>>;
  refusal(response: { json(): unknown }): z.infer<typeof errorSchema>["error"];
  /** Every run of an action of an App or a Page and of a Connection operation. */
  runs(): Promise<OperationRun[]>;
  runOf(id: unknown): Promise<OperationRun>;
  /** Runs `work` while `userId` holds a right, and takes the right back. */
  withRight(
    userId: string,
    right: string,
    scope: { assetId: string } | { workspaceId: string },
    work: () => Promise<void>
  ): Promise<void>;
  closeAll(): Promise<void>;
}

export type AppActionsInstance = Base & AppActionHelpers;

/**
 * The instance with the Connections `crm`, `erp` and `hidden`, the App `orders` and the calls
 * of a frame. `kai` is a member of the App's workspace and holds nothing else.
 */
export async function setupAppActions(
  further: AppActionsOptions = {}
): Promise<AppActionsInstance> {
  const t = await instance(further);

  const crm = await t.seed("crm", {
    operations: [
      operationOf("echo", { exposure: ["bridge", "agent"] }),
      operationOf("write", { effect: "changing", exposure: ["bridge"] })
    ]
  });
  await t.seed("erp", {
    operations: [
      operationOf("echo", { exposure: ["agent"] }),
      operationOf("write", { effect: "changing", exposure: ["agent"] })
    ]
  });
  await t.seed("hidden", { operations: [operationOf("echo", { exposure: ["bridge"] })] });
  for (const name of ["crm", "erp", "hidden"]) {
    await t.grant(t.admin.id, "connection.use", { assetId: await t.assetId("connection", name) });
  }
  // Revision 1 is published. Revision 2 is a draft with other files.
  expectStatus(await t.putApp(t.admin.id, "orders", appSource("published")), 200);
  expectStatus(await t.publish(t.admin.id, "orders", 1), 200);
  expectStatus(await t.putApp(t.admin.id, "orders", appSource("draft")), 200);

  const openApp = async (userId: string, mode: "draft" | "published", app = "orders") => {
    const response = await t.call(userId, "apps.preview", {
      params: { app },
      payload: { mode }
    });
    expectStatus(response, 200);
    return frameOf(response.json());
  };
  const openPage = async (userId: string, source = appSource("page", "orders-page")) => {
    const created = await t.expectOk(userId, "conversations.create", {
      payload: { title: "Orders" }
    });
    const conversation = z.object({ id: z.string() }).parse(created.json());
    const sourceFiles = pageFiles(
      Object.fromEntries(source.flatMap((file) => ("text" in file ? [[file.path, file.text]] : [])))
    );
    const built = await buildPage({ files: sourceFiles });
    if (built.status !== "built") throw new Error(JSON.stringify(built.errors));
    const stored = await storePageFileSet(
      { clientInstanceId, stores: t.stores, pages: { objects: t.objects } },
      {
        conversationId: asConversationId(conversation.id),
        pageName: "Orders",
        kitVersion: built.kitVersion,
        manifest: built.manifest,
        sourceFiles,
        builtFiles: built.files
      }
    );
    const response = await t.call(userId, "pages.preview", {
      params: { conversationId: conversation.id, pageId: stored.page.id },
      payload: { fileSetId: stored.fileSet.id }
    });
    expectStatus(response, 200);
    return { ...frameOf(response.json()), pageId: stored.page.id };
  };

  const callAction = (
    userId: string,
    frame: Frame,
    name: string,
    input: unknown,
    headers: Record<string, string> = {}
  ) =>
    t.call(userId, "apps.sessions.call_action", {
      params: { pageSessionId: frame.pageSessionId, name },
      payload: { ...frame.proof, input },
      headers
    });
  const can = async (userId: string, frame: Frame) => {
    const response = await t.call(userId, "apps.sessions.context", {
      params: { pageSessionId: frame.pageSessionId },
      payload: frame.proof
    });
    expectStatus(response, 200);
    return z.object({ can: z.record(z.string(), z.string()) }).parse(response.json()).can;
  };
  const refusal = (response: { json(): unknown }) => errorSchema.parse(response.json()).error;
  /** Every run the instance holds that is not one of an asset write or a grant. */
  const runs = async (): Promise<OperationRun[]> =>
    (await t.stores.operationRuns.list({ clientInstanceId })).filter(
      (run) =>
        run.operation.startsWith("app.") ||
        run.operation.startsWith("page_action.") ||
        run.operation.startsWith("connection.")
    );
  const runOf = async (id: unknown) => {
    const run = (await runs()).find((candidate) => candidate.id === id);
    if (!run) throw new Error(`No run '${String(id)}'`);
    return run;
  };
  /** Runs `work` while `userId` holds a right, and takes the right back. */
  const withRight = async (
    userId: string,
    right: string,
    scope: { assetId: string } | { workspaceId: string },
    work: () => Promise<void>
  ) => {
    const grantId = await t.grant(userId, right, scope);
    try {
      await work();
    } finally {
      await t.stores.access.deleteGrant({ clientInstanceId, grantId });
    }
  };

  return {
    ...t,
    crm,
    openApp,
    openPage,
    callAction,
    can,
    refusal,
    runs,
    runOf,
    withRight,
    async closeAll() {
      vi.restoreAllMocks();
      await t.close();
    }
  };
}
