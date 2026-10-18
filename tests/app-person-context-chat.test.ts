import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildPage } from "@work-shape/catalyst-app-build/build";
import { createPageBundleJobs } from "@work-shape/catalyst-server";
import { createFilesystemObjectStorage } from "@work-shape/catalyst-object-storage";
import { asClientInstanceId } from "@work-shape/catalyst-core";
import { createPostgresJobWorker } from "@work-shape/catalyst-postgres-store";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainRunEvents, injectStartConversationRun } from "./support/chat-server-run-harness";
import { createTestConfig } from "./support/fixtures";
import { json, startRestTestServer, type RestTestServer } from "./support/rest-test-server";
import { generateSecretStoreKey } from "./support/test-connector";
import { createTestInstance, type TestInstance } from "./support/test-instance";
import { silentTestLogger as silent } from "./support/model-gateway";

// Apps do not send person context yet, whoever calls an App's action. An agent in a chat that
// carries a published App action as its tool calls it as itself (origin `agent`), and the
// action still is the App's code: its call of a Connection that sends person context is
// refused before a request leaves. The agent's own call of the same Connection sends the
// person's mapped value as before. Fails without the App action's marker: the action ran
// and the outside system received the person's value.

const connection = "scoped-rest";
const header = "x-audience-context";
const appTool = "app.orders.load";
const directTool = `connection.${connection}.read`;
const keyVariable = "APP_CONTEXT_CHAT_SECRET_KEY";
const idSchema = z.object({ id: z.string() }).loose();
const messagesSchema = z.object({
  items: z.array(z.object({ role: z.string(), text: z.string() }))
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function world() {
  const workspaceObjectRoot = await mkdtemp(join(tmpdir(), "app-context-chat-workspaces-"));
  cleanups.push(() => rm(workspaceObjectRoot, { recursive: true, force: true }));
  const outside: RestTestServer = await startRestTestServer((request, response) =>
    json({ audience: request.headers[header] ?? null })(request, response)
  );
  cleanups.push(() => outside.close());
  const config = createTestConfig({
    toolNames: [appTool, directTool],
    // An App is built in the sandbox of an Execution Workspace on an assembled instance.
    executionWorkspaces: { enabled: true },
    workspaceObjectRoot,
    developmentAuth: {
      enabled: true,
      defaultUserId: "alice",
      users: [
        {
          id: "alice",
          externalUserId: "alice",
          displayLabel: "alice",
          roles: ["user", "admin", "superadmin"]
        }
      ]
    }
  });
  config.modules = {
    ...config.modules,
    assetManagement: { enabled: true },
    connections: { enabled: true },
    apps: { enabled: true }
  };
  config.secretStore = { keys: [{ id: "k1", ref: keyVariable }] };
  config.egress = {
    allow: [
      {
        protocol: "http",
        host: "127.0.0.1",
        port: outside.port,
        network: "private",
        cidrs: ["127.0.0.1/32"]
      }
    ]
  };
  // Pages keep their files in the files store; the build worker below writes there too.
  const filesRoot = await mkdtemp(join(tmpdir(), "app-context-chat-"));
  cleanups.push(() => rm(filesRoot, { recursive: true, force: true }));
  config.infrastructure.objectStorage = {
    ...config.infrastructure.objectStorage,
    files: { provider: "filesystem", root: filesRoot }
  };
  const app: TestInstance = await createTestInstance({
    config,
    env: {
      [keyVariable]: generateSecretStoreKey(),
      // The tokens that serve an App are signed with a key derived from it.
      CHAT_SESSION_TOKEN_SECRET: "app-context-chat-session-token-secret-32-chars"
    },
    tools: []
  });
  cleanups.push(() => app.close());
  const clientInstanceId = asClientInstanceId(config.clientInstance.id);

  // An App write waits for its build. No process of a test instance serves `page.bundle`.
  const builds = createPostgresJobWorker({
    stores: app.stores,
    clientInstanceId,
    logger: silent,
    handlers: createPageBundleJobs({
      clientInstanceId,
      stores: app.stores,
      pages: { objects: createFilesystemObjectStorage(filesRoot) },
      workspaceObjects: undefined,
      logger: silent,
      build: ({ files, signal }) => buildPage({ files, signal })
    }).handlers
  });
  builds.start();
  cleanups.push(() => builds.stop());

  const ok = async (response: ReturnType<TestInstance["call"]>) => {
    const answered = await response;
    expect(answered.statusCode, answered.body).toBe(200);
    return answered;
  };
  return { app, clientInstanceId, outside, ok };
}

describe("an agent that carries a published App action as its tool", () => {
  it("is refused the action's call of a Connection with person context, and its own call sends the value", async () => {
    const { app, clientInstanceId, outside, ok } = await world();
    // Saved now through the API, with person context and only agent exposure: the save's
    // refusal does not stand in its way, as it asks for App exposure.
    await ok(
      app.call("assets.put", {
        params: { kind: "connection", name: connection },
        payload: {
          expectedRevision: null,
          config: {
            name: connection,
            displayName: "Scoped REST",
            connectorType: "http_api",
            authScheme: "none",
            settings: { baseUrl: `http://127.0.0.1:${outside.port}`, personContextHeader: header },
            operations: [
              {
                name: "read",
                description: "Lists the clients visible to the acting identity.",
                method: "GET",
                path: "/clients",
                effect: "reading",
                exposure: ["agent"],
                enabled: true
              }
            ]
          }
        }
      })
    );
    const me = idSchema.parse((await ok(app.call("me.get", {}))).json()).id;
    await ok(
      app.call("connections.set_person_context", {
        params: { name: connection },
        payload: { subjectKind: "user", subjectId: me, value: "team-a", expectedRowVersion: null }
      })
    );
    const workspaceId = idSchema.parse(
      (await ok(app.call("workspaces.create", { payload: { name: "Sales" } }))).json()
    ).id;
    await ok(
      app.call("assets.put", {
        params: { kind: "app", name: "orders" },
        payload: {
          expectedRevision: null,
          workspaceId,
          files: [
            {
              path: "app.yaml",
              text: JSON.stringify({
                id: "orders",
                name: "Orders",
                kit: "1.1.0",
                entry: "index.html",
                connections: [connection]
              })
            },
            { path: "index.html", text: "<!doctype html><title>Orders</title>" },
            {
              path: "actions/load.action.yaml",
              text: [
                `connection: ${connection}`,
                "operation: read",
                "effect: reading",
                "description: Reads the clients.",
                "input:",
                "  schema: { type: object, properties: { text: { type: string } }, required: [text] }",
                "  mapping: {}",
                ""
              ].join("\n")
            }
          ]
        }
      })
    );
    await ok(
      app.call("assets.publish", {
        params: { kind: "app", name: "orders" },
        payload: { revision: 1, workspaceId }
      })
    );

    const say = async (text: string) => {
      const created = await ok(
        app.call("conversations.create", {
          payload: { title: "Orders", collaborationWorkspaceId: workspaceId }
        })
      );
      const conversationId = idSchema.parse(created.json()).id;
      const started = await injectStartConversationRun(app, conversationId, text);
      await drainRunEvents(app, conversationId, started.run.id);
      const messages = messagesSchema.parse(
        (await ok(app.call("conversations.messages.list", { params: { conversationId } }))).json()
      );
      return messages.items.filter((message) => message.role === "tool").at(-1)?.text ?? "";
    };
    const runsOf = async (operation: string) =>
      (await app.stores.operationRuns.list({ clientInstanceId })).filter(
        (run) => run.operation === operation
      );

    const refused = await say(`/tool ${appTool} ${JSON.stringify({ text: "chat" })}`);

    expect(refused).toContain("not available in Apps yet");
    expect(refused).not.toContain("team-a");
    expect(outside.requests).toHaveLength(0);
    expect(await runsOf(appTool)).toMatchObject([
      {
        status: "failed",
        origin: { kind: "agent", toolName: appTool },
        error: { reason: "person_context_app_unavailable" }
      }
    ]);

    const answered = await say(`/tool ${directTool} {}`);

    expect(answered).toContain("team-a");
    expect(outside.requests).toHaveLength(1);
    expect(outside.requests[0]?.headers[header]).toBe("team-a");
    expect(await runsOf(directTool)).toMatchObject([
      { status: "done", origin: { kind: "agent", toolName: directTool } }
    ]);
  });
});
