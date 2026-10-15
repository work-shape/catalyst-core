import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  APP_ACTION_LIST_MAX_APPS,
  APP_ACTION_TOOL_MAX_APPS,
  createAppActionOperationSource,
  createAppActionToolSource
} from "@work-shape/catalyst-server";
import { createConnectionToolSource } from "@work-shape/catalyst-connections";
import {
  APP_ACTION_CALLS_PER_MINUTE_PER_SESSION,
  type RateLimiter,
  type RateLimitRule
} from "@work-shape/catalyst-core";
import { clientInstanceId } from "./support/access-instance";
import { expectStatus } from "./support/app-instance";
import {
  action,
  appSource,
  resultSchema,
  setupAppActions,
  type AppActionsInstance,
  type Frame
} from "./support/app-actions";
import { agentOrigin } from "./support/connection-operations";
import { getTestJobs } from "./support/test-instance";

// What the first build of S3-42 left open, on real rows: which view a frame's address was
// made for, the workspace of a call, a call that waited for an approval and is executed
// when its App changed meanwhile, the listing of the source, its two limits and the limit of
// one page session. Each test says what it fails on without the fix round.

describe("a frame's call when the App changes around it", () => {
  let t: AppActionsInstance;
  let crm: string;
  /** The keys the limiter refuses, and every key it was asked for with its rule. */
  const limiter = {
    refused: new Set<string>(),
    asked: [] as { key: string; rule: RateLimitRule }[]
  };
  const rateLimiter: RateLimiter = {
    consume(key, rule) {
      limiter.asked.push({ key, rule });
      return Promise.resolve(
        limiter.refused.has(key)
          ? { allowed: false, retryAfterMs: 12_300 }
          : { allowed: true, retryAfterMs: 0 }
      );
    }
  };

  beforeAll(async () => {
    t = await setupAppActions({ rateLimiter });
    crm = t.crm;
  });
  afterAll(() => t.closeAll());

  /** A further App of the same files, with revision 1 published. */
  const publishApp = async (name: string) => {
    expectStatus(await t.putApp(t.admin.id, name, appSource("published", name)), 200);
    expectStatus(await t.publish(t.admin.id, name, 1), 200);
  };
  const approvalOnWrite = [{ operation: "connection.crm.write", value: "approval" }] as const;
  /** A changing call of `kai` that waits for an approval. Returns its run and its request. */
  const hold = async (frame: Frame, key: string) => {
    t.state.centralSettings = [...approvalOnWrite];
    try {
      const response = await t.callAction(
        t.kai.id,
        frame,
        "save",
        { note: key },
        { "idempotency-key": key }
      );
      expectStatus(response, 200);
      const answer = resultSchema.parse(response.json());
      expect(answer.status).toBe("pending_approval");
      const run = await t.runOf(answer.runId);
      if (run.approvalRequestId === undefined) throw new Error("The run names no request");
      return { runId: run.id, requestId: run.approvalRequestId };
    } finally {
      t.state.centralSettings = [];
    }
  };
  /** The administrator approves, and the job that executes the call runs. */
  const approve = async (requestId: string) => {
    expectStatus(
      await t.call(t.admin.id, "approval_requests.decide", {
        params: { requestId },
        payload: { decision: "approve" }
      }),
      200
    );
    await getTestJobs(t.instance).runDue();
  };
  const requestOf = (requestId: string) =>
    t.stores.approvals.getApprovalRequest({ clientInstanceId, requestId });

  // Fails without the fix: the view was read from the file set, and right after a publish the
  // draft and the published revision are one file set, so `/edit` ran the change.
  it("keeps a draft in safe mode where the draft and the published revision are one file set", async () => {
    await publishApp("fresh");
    const draft = await t.openApp(t.admin.id, "draft", "fresh");
    const published = await t.openApp(t.admin.id, "published", "fresh");
    expect(draft.proof.fileSetId).toBe(published.proof.fileSetId);
    const before = { handed: t.handed.length, runs: (await t.runs()).length };

    const inDraft = await t.callAction(
      t.admin.id,
      draft,
      "save",
      { note: "x" },
      { "idempotency-key": "fresh-draft" }
    );

    // The named action is simulated (ADR-0031).
    expectStatus(inDraft, 200);
    expect(inDraft.json()).toMatchObject({ status: "dry_run" });
    expect(await t.runOf(inDraft.headers["operation-run-id"])).toMatchObject({
      target: "dry_run",
      status: "done"
    });
    expect(t.handed.length).toBe(before.handed);
    expect((await t.runs()).length - before.runs).toBe(1);
    // The published view of the same file set carries the change out.
    const inPublished = await t.callAction(
      t.admin.id,
      published,
      "save",
      { note: "x" },
      { "idempotency-key": "fresh-published" }
    );
    expectStatus(inPublished, 200);
    expect(t.handed.length - before.handed).toBe(1);
  });

  // Fails without the fix: the call carried no workspace, the Connection has none, so a
  // setting narrowed to the App's workspace was skipped and the call ran.
  it("applies a setting that is narrowed to the App's workspace to a named action", async () => {
    const frame = await t.openApp(t.admin.id, "published");
    const handed = t.handed.length;
    t.state.centralSettings = [
      { operation: "connection.crm.echo", value: "deny", workspaceId: t.workspaceId }
    ];
    try {
      const named = await t.callAction(t.admin.id, frame, "load", { text: "x" });

      expect(named.statusCode).toBe(403);
      expect(t.refusal(named).code).toBe("POLICY_DENIED");
      expect(await t.runOf(named.headers["operation-run-id"])).toMatchObject({
        status: "denied",
        workspaceId: t.workspaceId
      });
      expect(t.handed.length).toBe(handed);
    } finally {
      t.state.centralSettings = [];
    }
    // Another workspace's setting does not hold it.
    t.state.centralSettings = [
      { operation: "connection.crm.echo", value: "deny", workspaceId: "cw_another" }
    ];
    try {
      expectStatus(await t.callAction(t.admin.id, frame, "load", { text: "x" }), 200);
    } finally {
      t.state.centralSettings = [];
    }
  });

  // Fails without the fix round in its last lines: the request said `declared_default` for a
  // call that waits because of what the Connection's operation asks.
  it("executes a held action once it is approved, with the mapped input and as the person who called it", async () => {
    await publishApp("approved");
    await t.withRight(t.kai.id, "connection.use", { assetId: crm }, async () => {
      const frame = await t.openApp(t.kai.id, "published", "approved");
      const handed = t.handed.length;
      const held = await hold(frame, "approved-1");
      expect(t.handed.length).toBe(handed);
      expect((await requestOf(held.requestId))?.payload).toMatchObject({ heldBy: "policy_floor" });

      await approve(held.requestId);

      expect(t.handed.length - handed).toBe(1);
      expect(t.executed.at(-1)).toMatchObject({
        operation: "write",
        input: { note: "approved-1", source: "app" }
      });
      expect(await t.runOf(held.runId)).toMatchObject({
        operation: "app.approved.save",
        status: "done",
        actor: { kind: "user", id: t.kai.id },
        origin: { kind: "app", appName: "approved" }
      });
    });
  });

  // Fails without the fix: the approved call was resolved from the latest published App, so
  // it ran the mapping of a revision the approver never read.
  it("does not execute a held action after its App was published again, and says why", async () => {
    await publishApp("pinned");
    await t.withRight(t.kai.id, "connection.use", { assetId: crm }, async () => {
      const frame = await t.openApp(t.kai.id, "published", "pinned");
      const held = await hold(frame, "pinned-1");
      // Revision 2 maps the same action to another input, and becomes the published one.
      const changed = appSource("published", "pinned").map((file) =>
        file.path === "actions/save.action.yaml"
          ? {
              path: file.path,
              text: action([
                "connection: crm",
                "operation: write",
                "effect: changing",
                "input:",
                "  schema: { type: object, properties: { note: { type: string } }, required: [note] }",
                '  mapping: { note: "{{note}}", source: another }'
              ])
            }
          : file
      );
      expectStatus(await t.putApp(t.admin.id, "pinned", changed), 200);
      expectStatus(await t.publish(t.admin.id, "pinned", 2), 200);
      const handed = t.handed.length;

      await approve(held.requestId);

      expect(t.handed.length).toBe(handed);
      expect(await t.runOf(held.runId)).toMatchObject({
        status: "failed",
        error: { code: "CONFLICT", message: expect.stringContaining("published again") }
      });
      expect((await requestOf(held.requestId))?.applyResult).toMatchObject({
        execution: "refused",
        error: { message: expect.stringContaining("published again") }
      });
    });
  });

  // Fails without the fix: an agent's call named no revision, so after a republish the
  // approved call ran the new revision's mapping, which the approver never read.
  it("does not execute an agent's held action after its App was published again", async () => {
    // Its action stands for an operation agents may call, and changes something.
    const files = (source: string) =>
      appSource("published", "agent-pinned").map((file) =>
        file.path === "actions/save.action.yaml"
          ? {
              path: file.path,
              text: action([
                "connection: erp",
                "operation: write",
                "effect: changing",
                "input:",
                "  schema: { type: object, properties: { note: { type: string } }, required: [note] }",
                `  mapping: { note: "{{note}}", source: ${source} }`
              ])
            }
          : file
      );
    expectStatus(await t.putApp(t.admin.id, "agent-pinned", files("first")), 200);
    expectStatus(await t.publish(t.admin.id, "agent-pinned", 1), 200);
    const toolName = "app.agent-pinned.save";
    const tools = createAppActionToolSource({
      clientInstanceId,
      store: t.stores.configAssets,
      modules: { isEnabled: () => true },
      targetTools: createConnectionToolSource(t.sourceDeps)
    });
    // The tool an agent's call is made with names the revision it was read from, and the
    // runner puts it into the origin of the call.
    const [tool] = await tools.describe([toolName], {});
    expect(tool).toMatchObject({ name: toolName, effect: "changing" });
    const toolRevisionId = tool?.revisionId;
    if (toolRevisionId === undefined) throw new Error("The tool names no revision");
    t.state.agentTools.set("assistant", [toolName]);

    const erp = await t.assetId("connection", "erp");
    await t.withRight(t.kai.id, "connection.use", { assetId: erp }, async () => {
      const origin = { ...agentOrigin(toolName), toolRevisionId };
      // The setting stays until the approval was applied: an agent's changing call is refused
      // as policy without it, and then nothing would show what the pin holds back.
      t.state.centralSettings = [{ operation: "connection.erp.write", value: "approval" }];
      try {
        const held = await t.invoke(
          t.kai,
          toolName,
          { note: "agent" },
          { origin, effect: "changing", idempotencyKey: "agent-pinned-1" }
        );
        expect(held.result.status).toBe("pending_approval");
        const run = await t.runOf(held.run.id);
        expect(run.origin).toMatchObject({ kind: "agent", toolRevisionId });
        if (run.approvalRequestId === undefined) throw new Error("The run names no request");
        expectStatus(await t.putApp(t.admin.id, "agent-pinned", files("second")), 200);
        expectStatus(await t.publish(t.admin.id, "agent-pinned", 2), 200);

        await approve(run.approvalRequestId);

        expect(t.executed).toEqual([]);
        expect(await t.runOf(run.id)).toMatchObject({
          status: "failed",
          error: { code: "CONFLICT", message: expect.stringContaining("published again") }
        });
      } finally {
        t.state.centralSettings = [];
      }
    });
  });

  it("does not execute a held call after its caller lost the App", async () => {
    await publishApp("revoked");
    await t.withRight(t.kai.id, "connection.use", { assetId: crm }, async () => {
      const frame = await t.openApp(t.kai.id, "published", "revoked");
      const named = await hold(frame, "revoked-named");
      // A member uses the Apps of the workspace by being a member, so leaving it is how the
      // right goes.
      const membership = {
        clientInstanceId,
        collaborationWorkspaceId: t.workspaceId,
        userId: t.kai.id
      };
      await t.stores.workspaces.removeMembership(membership);
      const handed = t.handed.length;
      try {
        await approve(named.requestId);
      } finally {
        await t.stores.workspaces.addMembership({ ...membership, role: "member" });
      }

      expect(t.handed.length).toBe(handed);
      expect(await t.runOf(named.runId)).toMatchObject({
        operation: "app.revoked.save",
        status: "denied",
        denial: { kind: "forbidden", action: "app.use" }
      });
    });
  });

  it("does not execute a held call after its App was removed", async () => {
    await publishApp("removed");
    await t.withRight(t.kai.id, "connection.use", { assetId: crm }, async () => {
      const frame = await t.openApp(t.kai.id, "published", "removed");
      const held = await hold(frame, "removed-named");
      expectStatus(
        await t.call(t.admin.id, "assets.delete", {
          params: { kind: "app", name: "removed" },
          payload: { expectedRevision: 1, workspaceId: t.workspaceId }
        }),
        200
      );
      const handed = t.handed.length;

      await approve(held.requestId);

      expect(t.handed.length).toBe(handed);
      expect(await t.runOf(held.runId)).toMatchObject({
        operation: "app.removed.save",
        status: "failed",
        error: { code: "NOT_FOUND" }
      });
    });
  });

  // Covers what the first round left untested and passes before it too: the agent's call is
  // the person's, so a person who may not use the App is refused through the agent as well.
  it("refuses an agent's call of an action for a person who may not use the App", async () => {
    const outsider = await t.stores.users.createUser({
      clientInstanceId,
      displayLabel: "Outsider",
      roles: ["user"],
      permissions: []
    });
    await t.grant(outsider.id, "connection.use", { assetId: crm });
    t.state.agentTools.set("assistant", ["app.orders.load"]);

    const outcome = await t.invoke(
      outsider,
      "app.orders.load",
      { text: "agent" },
      { origin: agentOrigin("app.orders.load") }
    );

    expect(outcome.result).toMatchObject({
      status: "denied",
      reason: { kind: "forbidden", action: "app.use" }
    });
    expect(t.executed).toEqual([]);
  });

  // Fails without the fix: the listing read every active App without its published content,
  // found no action in any of them and answered nothing.
  it("lists the actions of published Apps from Postgres, and says so where it leaves Apps out", async () => {
    const whole = await t.operationCalls.registry.list();
    const names = whole.operations.map((operation) => operation.name);
    // `agent-only` stands for an operation that exists, so it is listed like the others.
    expect(names).toEqual(
      expect.arrayContaining(["app.orders.load", "app.orders.save", "app.orders.agent-only"])
    );
    expect(whole.truncated).toEqual([]);
    expect(APP_ACTION_LIST_MAX_APPS).toBe(2000);

    // With a limit of one App the first by name is listed and the listing names its limit.
    const limited = await createAppActionOperationSource({
      clientInstanceId,
      store: t.stores.configAssets,
      modules: { isEnabled: () => true },
      registry: t.operationCalls.registry,
      policy: t.operationCalls.deps.policy,
      listMaxApps: 1
    }).list({});
    const published = (
      await t.stores.configAssets.listPublishedConfigAssets({
        clientInstanceId,
        kind: "app",
        limit: 100
      })
    ).map((asset) => asset.name);
    expect(published.length).toBeGreaterThan(1);
    expect(new Set(limited.operations.map((operation) => operation.name.split(".")[1]))).toEqual(
      new Set([published[0]])
    );
    expect(limited.truncated).toEqual([
      { prefix: "app.", limit: 1, limitName: "APP_ACTION_LIST_MAX_APPS" }
    ]);
  });

  // Fails without the fix: `can` resolved each action's operation by name, two reads each.
  it("reads a Connection once for the `can` map, whatever the number of actions that name it", async () => {
    const frame = await t.openApp(t.admin.id, "published");
    const reads = vi.mocked(t.stores.configAssets.getConfigAsset);
    const count = (kind: string) =>
      reads.mock.calls.filter(([input]) => input.kind === kind).length;
    const before = { connection: count("connection"), app: count("app") };

    const can = await t.can(t.admin.id, frame);

    // `load` and `save` are on `crm`, `agent-only` on `erp`: two Connections, three actions.
    // The App was asked with the frame's address and is not read again for each action.
    expect(Object.keys(can)).toHaveLength(3);
    expect({
      connection: count("connection") - before.connection,
      app: count("app") - before.app
    }).toEqual({ connection: 2, app: 0 });
  });

  // Fails without the fix: the names of the Apps after the limit were dropped without a word.
  it("describes the tools of the first Apps by name up to the limit and warns of the rest", async () => {
    await publishApp("aaa-first");
    const warn = vi.fn();
    const tools = createAppActionToolSource({
      clientInstanceId,
      store: t.stores.configAssets,
      modules: { isEnabled: () => true },
      targetTools: createConnectionToolSource(t.sourceDeps),
      logger: { warn },
      maxApps: 1
    });

    const described = await tools.describe(["app.orders.load", "app.aaa-first.load"], {});

    expect(described.map((tool) => tool.name)).toEqual(["app.aaa-first.load"]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "app_action.tools_left_out",
        namedApps: 2,
        leftOutApps: 1,
        limit: 1,
        limitName: "APP_ACTION_TOOL_MAX_APPS"
      }),
      expect.any(String)
    );
    expect(APP_ACTION_TOOL_MAX_APPS).toBe(50);
  });

  // Covers what the first round left untested: the limit of one page session.
  it("refuses a call over the limit of its page session before anything is read, and names the wait", async () => {
    const frame = await t.openApp(t.admin.id, "published");
    const key = `app-session:${frame.pageSessionId}`;
    expectStatus(await t.callAction(t.admin.id, frame, "load", { text: "x" }), 200);
    expect(limiter.asked).toContainEqual({
      key,
      rule: { limit: APP_ACTION_CALLS_PER_MINUTE_PER_SESSION, windowMs: 60_000 }
    });
    const before = { handed: t.handed.length, runs: (await t.runs()).length };

    limiter.refused.add(key);
    const responses = [
      await t.callAction(t.admin.id, frame, "load", { text: "x" }),
      await t.callAction(t.admin.id, frame, "load", { text: "y" })
    ];

    for (const response of responses) {
      expect(response.statusCode).toBe(429);
      expect(t.refusal(response)).toMatchObject({
        code: "RATE_LIMITED",
        details: { reason: "rate_limited", retryAfterSeconds: 13 }
      });
    }
    expect({ handed: t.handed.length, runs: (await t.runs()).length }).toEqual(before);
    // Another page session of the same person is not held by it.
    const other = await t.openApp(t.admin.id, "published");
    expectStatus(await t.callAction(t.admin.id, other, "load", { text: "x" }), 200);
  });
});
