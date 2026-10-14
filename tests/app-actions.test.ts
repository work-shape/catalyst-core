import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAppActionToolSource } from "@vivd-catalyst/chat-server";
import { createConnectionToolSource } from "@vivd-catalyst/connections";
import { APP_ACTION_INPUT_MAX_BYTES } from "@vivd-catalyst/core";
import { clientInstanceId } from "./support/access-instance";
import { expectStatus } from "./support/app-instance";
import {
  action,
  appSource,
  resultSchema,
  setupAppActions,
  type AppActionsInstance
} from "./support/app-actions";
import { agentOrigin, operationOf } from "./support/connection-operations";
import { withTestSql } from "./support/test-sql";

// A named action of a Page or an App, called by its frame through the interface, on real rows:
// the real build compiles the action, the real call path runs it, and the Connector type
// records what it was handed. `kai` is a member of the App's workspace and holds nothing else.
//
// Every test here fails without the change: before it the instance had no route a frame's call
// could reach, no operation `app.<id>.<action>` resolved, and the manifest of a stored App
// held no compiled action.

describe("a call a frame makes through the interface", () => {
  let t: AppActionsInstance;
  let crm: string;
  beforeAll(async () => {
    t = await setupAppActions();
    crm = t.crm;
  });
  afterAll(() => t.closeAll());

  const openApp: AppActionsInstance["openApp"] = (...args) => t.openApp(...args);
  const openPage: AppActionsInstance["openPage"] = (...args) => t.openPage(...args);
  const callAction: AppActionsInstance["callAction"] = (...args) => t.callAction(...args);
  const callConnection: AppActionsInstance["callConnection"] = (...args) =>
    t.callConnection(...args);
  const can: AppActionsInstance["can"] = (...args) => t.can(...args);
  const refusal: AppActionsInstance["refusal"] = (response) => t.refusal(response);
  const runs: AppActionsInstance["runs"] = () => t.runs();
  const runOf: AppActionsInstance["runOf"] = (id) => t.runOf(id);
  const withRight: AppActionsInstance["withRight"] = (...args) => t.withRight(...args);

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
      const page = await openPage(t.kai.id);
      const { pageId } = page;
      const frames = {
        page: { viewer: t.kai.id, frame: page },
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
        // Fix round 7 and 13: the refusal names its run, and says that it is the missing
        // right to use a Connection, so the interface words it in the viewer's language. The
        // Connection's label is told to who may read the Connection, here the builder, and
        // never to a member who may not. Fails without: neither field was sent.
        expect(refusal(response).details, where).toEqual({
          action: "connection.use",
          reason: expect.any(String),
          connectionUseDenied: true,
          frame: where === "page" ? "page" : "app",
          operationRunId: response.headers["operation-run-id"],
          ...(viewer === builder.id ? { connectionLabel: expect.any(String) } : {})
        });
        expect(t.handed.length, where).toBe(handed);
        expect(await runOf(response.headers["operation-run-id"]), where).toMatchObject({
          // A Page's action runs under the Page's own id, never as `app.<manifest id>.…`:
          // the manifest id is free text and could be the name of a published App.
          operation: where === "page" ? `page_action.${pageId}.load` : "app.orders.load",
          status: "denied",
          actor: { kind: "user", id: viewer },
          denial: { kind: "forbidden", action: "connection.use" }
        });
        expect((await can(viewer, frame)).load, where).toBe("deny");
      }
    }
  });

  // A draft of an App simulates a changing action instead (ADR-0031): app-draft-safe-mode.test.ts.
  it("carries out no changing action in a Page: draft_safe_mode, no run and no call", async () => {
    const frame = await openPage(t.admin.id);
    const before = { handed: t.handed.length, runs: (await runs()).length };

    const response = await callAction(
      t.admin.id,
      frame,
      "save",
      { note: "x" },
      { "idempotency-key": "safe-page" }
    );

    expect(response.statusCode).toBe(409);
    expect(refusal(response)).toMatchObject({
      code: "CONFLICT",
      details: { reason: "draft_safe_mode" }
    });
    expect(response.headers["operation-run-id"]).toBeUndefined();
    expect({ handed: t.handed.length, runs: (await runs()).length }).toEqual(before);
    // The frame is told so before it asks, and a read stays possible.
    expect(await can(t.admin.id, frame)).toMatchObject({ save: "deny", load: "allow" });
    expectStatus(await callAction(t.admin.id, frame, "load", { text: "read" }), 200);
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
      targetTools: createConnectionToolSource(t.sourceDeps)
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
        effect: "reading",
        // The published revision the description was read from, which pins a held call.
        revisionId: expect.stringMatching(/^cfgr_/)
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

  // The write of an App is checked against the Connection as it is then. This is the rule of
  // the call itself, for a Connection whose operation came to change something afterwards.
  // Fails without it: the action would run the change as a read, with no Idempotency-Key and
  // from a draft.
  it("refuses a stored reading action at the call once the operation it stands for changes something, before the connector runs", async () => {
    const crmOperations = (echo: "reading" | "changing") => ({
      operations: [
        operationOf("echo", { effect: echo, exposure: ["bridge", "agent"] }),
        operationOf("write", { effect: "changing", exposure: ["bridge"] })
      ]
    });
    await t.seed("crm", crmOperations("changing"));
    try {
      for (const mode of ["draft", "published"] as const) {
        const frame = await openApp(t.admin.id, mode);
        const before = t.handed.length;

        expect((await can(t.admin.id, frame)).load).toBe("deny");
        const response = await callAction(t.admin.id, frame, "load", { text: "weak" });

        expect(response.statusCode, mode).toBe(409);
        expect(refusal(response), mode).toMatchObject({
          code: "CONFLICT",
          message:
            "The action 'load' is declared reading and the operation it calls changes something. Declare the action changing.",
          details: { reason: "action_effect_too_weak" }
        });
        expect(t.handed.length, mode).toBe(before);
      }
    } finally {
      // The Connection as every other test of the file reads it.
      await t.seed("crm", crmOperations("reading"));
    }
    const frame = await openApp(t.admin.id, "published");
    expectStatus(await callAction(t.admin.id, frame, "load", { text: "strong" }), 200);
  });
});
