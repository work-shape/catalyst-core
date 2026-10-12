import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { buildPage } from "@vivd-catalyst/app-build/build";
import { createAppActionToolSource, storePageFileSet } from "@vivd-catalyst/chat-server";
import { createConnectionToolSource } from "@vivd-catalyst/connections";
import {
  APP_ACTION_INPUT_MAX_BYTES,
  asConversationId,
  type OperationRun
} from "@vivd-catalyst/core";
import { clientInstanceId, errorSchema } from "./support/access-instance";
import { expectStatus, setupAppInstance, type AppFile } from "./support/app-instance";
import { agentOrigin, fixtureOn, operationOf } from "./support/connection-operations";
import { pageFiles } from "./support/page-build";
import { withTestSql } from "./support/test-sql";

// A named action of a Page or an App, called by its frame through the interface, on real rows:
// the real build compiles the action, the real call path runs it, and the Connector type
// records what it was handed. `kai` is a member of the App's workspace and holds nothing else.
//
// Every test here fails without the change: before it the instance had no route a frame's call
// could reach, no operation `app.<id>.<action>` resolved, and the manifest of a stored App
// held no compiled action.

const action = (lines: string[]) => `${lines.join("\n")}\n`;
const text = {
  schema: "  schema: { type: object, properties: { text: { type: string } }, required: [text] }",
  mapping: '  mapping: { text: "{{text}}" }'
};

/** An App with a reading action, a changing one and one on an operation agents alone reach. */
function appSource(marker: string, id = "orders"): AppFile[] {
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
        text.schema,
        text.mapping
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
        text.schema,
        text.mapping
      ])
    }
  ];
}

const frameSchema = z.looseObject({
  url: z.string(),
  fileSetId: z.string(),
  pageSessionId: z.string()
});
const resultSchema = z.object({
  runId: z.string(),
  status: z.enum(["done", "pending_approval"]),
  result: z.unknown().optional()
});

/** What the interface holds of a frame: the page session and what proves it to the instance. */
interface Frame {
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

describe("a call a frame makes through the interface", () => {
  type Instance = Awaited<ReturnType<typeof setup>>;
  let t: Instance;
  let crm: string;

  const setup = () =>
    fixtureOn((options) =>
      setupAppInstance({
        modules: options.modules,
        furtherKinds: options.furtherKinds,
        server: options.server,
        // The real build, in this process: it compiles the action files into the manifest.
        build: ({ files, signal }) => buildPage({ files, signal })
      })
    );

  beforeAll(async () => {
    t = await setup();
    crm = await t.seed("crm", {
      operations: [
        operationOf("echo", { exposure: ["bridge", "agent"] }),
        operationOf("write", { effect: "changing", exposure: ["bridge"] })
      ]
    });
    await t.seed("erp", { operations: [operationOf("echo", { exposure: ["agent"] })] });
    await t.seed("hidden", { operations: [operationOf("echo", { exposure: ["bridge"] })] });
    for (const name of ["crm", "erp", "hidden"]) {
      await t.grant(t.admin.id, "connection.use", { assetId: await t.assetId("connection", name) });
    }
    // Revision 1 is published. Revision 2 is a draft with other files.
    expectStatus(await t.putApp(t.admin.id, "orders", appSource("published")), 200);
    expectStatus(await t.publish(t.admin.id, "orders", 1), 200);
    expectStatus(await t.putApp(t.admin.id, "orders", appSource("draft")), 200);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await t.close();
  });

  const openApp = async (userId: string, mode: "draft" | "published") => {
    const response = await t.call(userId, "apps.preview", {
      params: { app: "orders" },
      payload: { mode }
    });
    expectStatus(response, 200);
    return frameOf(response.json());
  };
  /** A Page with the same actions in a conversation of `userId`, and its frame for them. */
  const openPage = async (userId: string) => {
    const created = await t.expectOk(userId, "conversations.create", {
      payload: { title: "Orders" }
    });
    const conversation = z.object({ id: z.string() }).parse(created.json());
    const sourceFiles = pageFiles(
      Object.fromEntries(
        appSource("page", "orders-page").flatMap((file) =>
          "text" in file ? [[file.path, file.text]] : []
        )
      )
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
    return frameOf(response.json());
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
  const callConnection = (
    userId: string,
    frame: Frame,
    target: { connection: string; operation: string },
    input: unknown
  ) =>
    t.call(userId, "apps.sessions.call_connection", {
      params: { pageSessionId: frame.pageSessionId, ...target },
      payload: { ...frame.proof, input }
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
      (run) => run.operation.startsWith("app.") || run.operation.startsWith("connection.")
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

  it("reads through a published action for a member who may use the Connection: one run each call, with the origin app and no model call", async () => {
    await withRight(t.kai.id, "connection.use", { assetId: crm }, async () => {
      const frame = await openApp(t.kai.id, "published");
      const before = { executed: t.handed.length, runs: (await runs()).length };

      const response = await callAction(t.kai.id, frame, "load", { text: "s3-42-marker" });

      expectStatus(response, 200);
      const answer = resultSchema.parse(response.json());
      expect(answer).toEqual({
        runId: response.headers["operation-run-id"],
        status: "done",
        result: { text: "s3-42-marker" }
      });
      // The connector was handed the mapped input and the credential of the Connection.
      expect(t.executed.at(-1)).toEqual({
        operation: "echo",
        input: { text: "s3-42-marker" },
        secret: t.secret
      });
      const run = await runOf(answer.runId);
      expect(run).toMatchObject({
        operation: "app.orders.load",
        effect: "reading",
        status: "done",
        actor: { kind: "user", id: t.kai.id },
        workspaceId: t.workspaceId,
        origin: {
          kind: "app",
          actionName: "load",
          pageSessionId: frame.pageSessionId,
          appRevisionId: expect.any(String),
          target: { connection: "crm", operation: "echo" }
        }
      });
      // The run names what was touched and holds neither the input nor the result.
      expect(run.output).toBeUndefined();
      expect(JSON.stringify(run)).not.toContain("s3-42-marker");

      // A refresh is one more call: one more run, and nothing else.
      const again = await callAction(t.kai.id, frame, "load", { text: "s3-42-marker" });
      expectStatus(again, 200);
      expect(resultSchema.parse(again.json()).runId).not.toBe(answer.runId);
      expect((await runs()).length - before.runs).toBe(2);
      expect(t.handed.length - before.executed).toBe(2);
      const kept = await withTestSql(async (sql) => ({
        usage: await sql`select count(*)::int as count from model_usage_events`,
        audit:
          await sql`select count(*)::int as count from audit_events where audit_events::text like '%s3-42-marker%'`
      }));
      expect(kept.usage[0]?.count).toBe(0);
      expect(kept.audit[0]?.count).toBe(0);
    });
  });

  it("refuses a viewer without the right on the Connection, in a Page, a draft and a published App alike, before the connector runs", async () => {
    // `kai` may open the Page and the published App. A draft is shown to somebody who writes
    // the App: a builder who holds the rights of the kind and is denied this Connection.
    const builder = await t.stores.users.createUser({
      clientInstanceId,
      displayLabel: "Builder",
      roles: ["user", "admin"],
      permissions: []
    });
    await t.grant(builder.id, "connection.use", { assetId: crm }, "deny");
    {
      const frames = {
        page: { viewer: t.kai.id, frame: await openPage(t.kai.id) },
        draft: { viewer: builder.id, frame: await openApp(builder.id, "draft") },
        published: { viewer: t.kai.id, frame: await openApp(t.kai.id, "published") }
      };
      for (const [where, { viewer, frame }] of Object.entries(frames)) {
        const handed = t.handed.length;

        const response = await callAction(viewer, frame, "load", { text: "hello" });

        expect(response.statusCode, where).toBe(403);
        expect(refusal(response), where).toMatchObject({
          code: "FORBIDDEN",
          details: { action: "connection.use" }
        });
        expect(t.handed.length, where).toBe(handed);
        expect(await runOf(response.headers["operation-run-id"]), where).toMatchObject({
          operation: where === "page" ? "app.orders-page.load" : "app.orders.load",
          status: "denied",
          actor: { kind: "user", id: viewer },
          denial: { kind: "forbidden", action: "connection.use" }
        });
        expect((await can(viewer, frame)).load, where).toBe("deny");
      }
    }
  });

  it("carries out no changing action in a draft or a Page: draft_safe_mode, no run and no call", async () => {
    const frames = {
      page: await openPage(t.admin.id),
      draft: await openApp(t.admin.id, "draft")
    };
    for (const [where, frame] of Object.entries(frames)) {
      const before = { handed: t.handed.length, runs: (await runs()).length };

      const response = await callAction(
        t.admin.id,
        frame,
        "save",
        { note: "x" },
        { "idempotency-key": `safe-${where}` }
      );

      expect(response.statusCode, where).toBe(409);
      expect(refusal(response), where).toMatchObject({
        code: "CONFLICT",
        details: { reason: "draft_safe_mode" }
      });
      expect(response.headers["operation-run-id"], where).toBeUndefined();
      expect({ handed: t.handed.length, runs: (await runs()).length }, where).toEqual(before);
      // The frame is told so before it asks, and a read stays possible.
      expect(await can(t.admin.id, frame), where).toMatchObject({ save: "deny", load: "allow" });
      expectStatus(await callAction(t.admin.id, frame, "load", { text: "read" }), 200);
    }
  });

  it("asks a changing action of a published App for an Idempotency-Key, and runs two calls with one key once", async () => {
    const frame = await openApp(t.admin.id, "published");
    const before = { handed: t.handed.length, runs: (await runs()).length };

    const withoutKey = await callAction(t.admin.id, frame, "save", { note: "first" });
    expect(withoutKey.statusCode).toBe(422);
    expect(refusal(withoutKey).message).toContain("Idempotency-Key");
    expect({ handed: t.handed.length, runs: (await runs()).length }).toEqual(before);

    const key = { "idempotency-key": "save-once" };
    const first = await callAction(t.admin.id, frame, "save", { note: "first" }, key);
    const second = await callAction(t.admin.id, frame, "save", { note: "first" }, key);

    expectStatus(first, 200);
    expectStatus(second, 200);
    const answer = resultSchema.parse(first.json());
    expect(answer).toMatchObject({ status: "done", result: { note: "first", source: "app" } });
    expect(resultSchema.parse(second.json())).toEqual(answer);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(t.handed.length - before.handed).toBe(1);
    expect((await runs()).length - before.runs).toBe(1);
    expect(await runOf(answer.runId)).toMatchObject({
      operation: "app.orders.save",
      effect: "changing",
      status: "done",
      origin: { kind: "app", target: { connection: "crm", operation: "write" } }
    });
    // The same key with another input is another call and is refused.
    const other = await callAction(t.admin.id, frame, "save", { note: "second" }, key);
    expect(refusal(other).code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("refuses an operation that is exposed to agents alone, as an action and as a Connection call", async () => {
    const frame = await openApp(t.admin.id, "published");
    const handed = t.handed.length;
    const asAction = await callAction(t.admin.id, frame, "agent-only", { text: "x" });
    const direct = await callConnection(
      t.admin.id,
      frame,
      { connection: "erp", operation: "echo" },
      { text: "x" }
    );

    for (const response of [asAction, direct]) {
      expect(response.statusCode).toBe(403);
      expect(refusal(response)).toMatchObject({
        code: "FORBIDDEN",
        details: { action: "connection_exposure:bridge", reason: "no_grant" }
      });
      expect(await runOf(response.headers["operation-run-id"])).toMatchObject({
        status: "denied"
      });
    }
    expect(t.handed.length).toBe(handed);
    expect((await can(t.admin.id, frame))["agent-only"]).toBe("deny");
  });

  it("calls an operation of a listed Connection as that operation's own run, and none of a Connection the manifest does not list", async () => {
    const frame = await openApp(t.admin.id, "published");

    const listed = await callConnection(
      t.admin.id,
      frame,
      { connection: "crm", operation: "echo" },
      { text: "direct" }
    );
    expectStatus(listed, 200);
    const answer = resultSchema.parse(listed.json());
    expect(answer.result).toEqual({ text: "direct" });
    expect(await runOf(answer.runId)).toMatchObject({
      operation: "connection.crm.echo",
      status: "done",
      origin: {
        kind: "app",
        actionName: "connections.call",
        pageSessionId: frame.pageSessionId,
        target: { connection: "crm", operation: "echo" }
      }
    });

    const before = { handed: t.handed.length, runs: (await runs()).length };
    const unlisted = await callConnection(
      t.admin.id,
      frame,
      { connection: "hidden", operation: "echo" },
      { text: "direct" }
    );
    expect(unlisted.statusCode).toBe(403);
    expect(refusal(unlisted).details).toEqual({ reason: "connection_not_declared" });
    expect({ handed: t.handed.length, runs: (await runs()).length }).toEqual(before);
  });

  it("is never looser than the Connection's operation: an approval set on it holds the action's call, whatever is set on the action", async () => {
    const frame = await openApp(t.admin.id, "published");
    const handed = t.handed.length;
    t.state.centralSettings = [
      { operation: "connection.crm.write", value: "approval" },
      { operation: "app.*", value: "allow" }
    ];
    try {
      expect(await can(t.admin.id, frame)).toMatchObject({ save: "approval", load: "allow" });

      const response = await callAction(
        t.admin.id,
        frame,
        "save",
        { note: "held" },
        { "idempotency-key": "save-held" }
      );

      expectStatus(response, 200);
      const answer = resultSchema.parse(response.json());
      expect(answer).toEqual({ runId: answer.runId, status: "pending_approval" });
      expect(await runOf(answer.runId)).toMatchObject({
        operation: "app.orders.save",
        status: "pending_approval"
      });
      expect(t.handed.length).toBe(handed);
    } finally {
      t.state.centralSettings = [];
    }
    expect((await can(t.admin.id, frame)).save).toBe("confirm");
  });

  it("takes a call from the person the frame's address was made for, and from nobody else", async () => {
    const frame = await openApp(t.kai.id, "published");
    const before = (await runs()).length;
    const refused = [
      // Another person with the address of `kai`.
      await callAction(t.admin.id, frame, "load", { text: "x" }),
      // Another page session than the address names.
      await callAction(t.kai.id, { ...frame, pageSessionId: "another" }, "load", { text: "x" }),
      // The token under another file set.
      await callAction(
        t.kai.id,
        {
          ...frame,
          proof: { ...frame.proof, fileSetId: (await openApp(t.admin.id, "draft")).proof.fileSetId }
        },
        "load",
        { text: "x" }
      )
    ];
    for (const response of refused) {
      expect(response.statusCode).toBe(404);
      expect(refusal(response).details).toEqual({ reason: "session_invalid" });
    }
    expect((await runs()).length).toBe(before);
  });

  it("refuses an action the manifest does not name and an input that does not fit, before a run exists", async () => {
    const frame = await openApp(t.admin.id, "published");
    const before = { handed: t.handed.length, runs: (await runs()).length };

    const unknown = await callAction(t.admin.id, frame, "drop-all", {});
    expect(unknown.statusCode).toBe(404);
    expect(refusal(unknown).details).toEqual({ reason: "action_unknown" });

    for (const input of [{}, { text: 5 }, { text: "x", admin: true }]) {
      const invalid = await callAction(t.admin.id, frame, "load", input);
      expect(invalid.statusCode, JSON.stringify(input)).toBe(422);
      expect(refusal(invalid).details, JSON.stringify(input)).toMatchObject({
        reason: "input_invalid"
      });
    }
    const large = await callAction(t.admin.id, frame, "load", {
      text: "x".repeat(APP_ACTION_INPUT_MAX_BYTES)
    });
    expect(large.statusCode).toBe(422);
    expect(refusal(large)).toMatchObject({
      message: expect.stringContaining("APP_ACTION_INPUT_MAX_BYTES"),
      details: { reason: "input_invalid" }
    });
    expect({ handed: t.handed.length, runs: (await runs()).length }).toEqual(before);
  });

  it("lets an agent that lists the action call the published one as a tool, as the person in its chat", async () => {
    const tools = createAppActionToolSource({
      clientInstanceId,
      store: t.stores.configAssets,
      modules: { isEnabled: () => true },
      connectionTools: createConnectionToolSource(t.sourceDeps)
    });
    // `save` stands for an operation agents are not exposed to, and `missing` for nothing.
    expect(
      await tools.describe(
        ["app.orders.load", "app.orders.save", "app.orders.agent-only", "app.orders.missing"],
        {}
      )
    ).toEqual([
      {
        name: "app.orders.load",
        description: "Reads one row.",
        inputJsonSchema: expect.objectContaining({ required: ["text"] }),
        effect: "reading"
      },
      expect.objectContaining({ name: "app.orders.agent-only", effect: "reading" })
    ]);

    await withRight(t.kai.id, "connection.use", { assetId: crm }, async () => {
      const origin = agentOrigin("app.orders.load");
      const unlisted = await t.invoke(t.kai, "app.orders.load", { text: "agent" }, { origin });
      expect(unlisted.result).toMatchObject({ status: "denied" });

      t.state.agentTools.set("assistant", ["app.orders.load"]);
      const listed = await t.invoke(t.kai, "app.orders.load", { text: "agent" }, { origin });

      expect(listed.result).toMatchObject({ status: "done", output: { text: "agent" } });
      expect(listed.run).toMatchObject({
        operation: "app.orders.load",
        actor: { kind: "user", id: t.kai.id },
        origin: { kind: "agent", toolName: "app.orders.load" }
      });
    });
    // Without the right on the Connection the same call is refused with the right named.
    const refused = await t.invoke(
      t.kai,
      "app.orders.load",
      { text: "agent" },
      { origin: agentOrigin("app.orders.load") }
    );
    expect(refused.result).toMatchObject({
      status: "denied",
      reason: { kind: "forbidden", action: "connection.use" }
    });
  });

  it("refuses to store an App whose action says it reads where the Connection's operation changes", async () => {
    const files = appSource("weak", "weak").map((file) =>
      file.path === "actions/load.action.yaml"
        ? {
            path: file.path,
            text: action(["connection: crm", "operation: write", "effect: reading"])
          }
        : file
    );

    const response = await t.putApp(t.admin.id, "weak", files);

    expect(response.statusCode).toBe(422);
    expect(JSON.stringify(response.json())).toContain("Declare the action changing");
  });
});
