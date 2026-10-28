import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  asAgentRunId,
  asConversationId,
  asMessageId,
  asUserId,
  isFileSetId,
  type ServerPreviewCaptureInput,
  type ServerPreviewCaptureOutcome
} from "@work-shape/catalyst-core";
import { createJobWorker } from "@work-shape/catalyst-client-assembly";
import { createChatServerJobs, requestServerPreviewCapture } from "@work-shape/catalyst-server";
import { mintAppContentToken, appContentPath } from "@work-shape/catalyst-server";
import { setupAppActions, type AppActionsInstance } from "./support/app-actions";
import { testServerOptions, callTestPath } from "./support/test-instance";
import { withTestSql } from "./support/test-sql";
import { clientInstanceId } from "./support/access-instance";
import { webp } from "./support/webp";

function requireValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}
let t: AppActionsInstance;
let duringCapture: (input: ServerPreviewCaptureInput) => Promise<ServerPreviewCaptureOutcome>;
describe("dark server preview requests", () => {
  beforeAll(async () => {
    t = await setupAppActions();
    requireValue(options().pages).previewCaptureService = {
      capture: (input) => duringCapture(input)
    };
  });
  afterAll(() => t.closeAll());
  const options = () => {
    const options = testServerOptions(t.instance);
    if (!options) throw Error("No options");
    return options;
  };
  const content = (path: string) =>
    callTestPath(t.instance, "GET", path, { "sec-fetch-dest": "iframe" });
  async function run(userId = t.admin.id) {
    const frame = await t.openPage(userId);
    const id = asAgentRunId(`run_${randomUUID()}`);
    const message = asMessageId(`msg_${randomUUID()}`);
    const conversationId = asConversationId(frame.conversationId);
    await t.stores.conversations.appendMessage({
      id: message,
      clientInstanceId,
      conversationId,
      role: "user",
      text: "Capture"
    });
    await t.stores.agentRuns.createAgentRun({
      id,
      clientInstanceId,
      conversationId,
      ownerUserId: userId,
      inputMessageId: message,
      agentName: "test",
      correlationId: "capture-test",
      status: "running",
      authorization: {
        principal: {
          kind: "user",
          id: userId,
          authSource: "test",
          displayLabel: "Person",
          clientInstanceId
        },
        subjectUserId: userId,
        scopes: ["run:start"]
      }
    });
    return { frame, id, conversationId };
  }
  async function ask(id: string, call = randomUUID()) {
    const request = await requestServerPreviewCapture(
      { clientInstanceId, stores: t.stores },
      { runId: id, toolCallId: call }
    );
    if (!("id" in request)) throw Error("Capture limit");
    return request.id;
  }
  async function work(id: string) {
    const worker = createJobWorker({
      stores: t.stores,
      clientInstanceId,
      handlers: createChatServerJobs(options()).handlers.filter(
        (handler) => handler.kind.kind === "preview.capture"
      ),
      logger: options().logger
    });
    worker.start();
    try {
      await expect
        .poll(
          async () =>
            (await t.stores.pages.getServerPreviewCapture({ clientInstanceId, id }))?.status,
          { timeout: 5000 }
        )
        .not.toMatch(/pending|answering/);
    } finally {
      await worker.stop();
    }
  }
  it("enqueues once with its row, excludes browser answers, serves only during capture and revokes the pictured address", async () => {
    const { id, frame } = await run();
    const call = randomUUID();
    const capture = await ask(id, call);
    expect(await ask(id, call)).toBe(capture);
    expect(
      await t.stores.pages.pendingPreviewCaptures({
        clientInstanceId,
        conversationId: asConversationId(frame.conversationId),
        userId: asUserId(t.admin.id),
        notBefore: new Date(Date.now() - 60_000).toISOString()
      })
    ).toEqual([]);
    await withTestSql(async (sql) => {
      const jobs =
        await sql`select subject,payload from platform_jobs where kind='preview.capture' and subject=${capture}`;
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.payload).toEqual({ captureId: capture });
    });
    let address = "";
    const operationsBefore = (await t.runs()).length;
    duringCapture = async (input) => {
      address = input.contentPath;
      expect(input.session).toBe(`capture:${capture}`);
      const response = await content(address);
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(input).not.toHaveProperty("person");
      expect(input).not.toHaveProperty("grant");
      return {
        status: "done",
        image: Buffer.from(webp(1280, 800)).toString("base64"),
        report: {
          settled: true,
          empty: false,
          entries: [
            {
              kind: "console",
              message: `address ${input.contentPath} https://example.test/a?token=private-value`,
              count: 1
            }
          ],
          more: 0
        },
        calls: [],
        blocked: []
      };
    };
    await work(capture);
    expect(
      (await t.stores.pages.getPreviewCapture({ clientInstanceId, id: capture }))?.status
    ).toBe("captured");
    expect((await content(address)).statusCode).not.toBe(200);
    const row = await t.stores.pages.getServerPreviewCapture({ clientInstanceId, id: capture });
    expect(row?.status).toBe("captured");
    expect((await t.runs()).length).toBe(operationsBefore);
    await withTestSql(async (sql) => {
      const [stored] =
        await sql`select server_diagnostics from preview_captures where id=${capture}`;
      expect(JSON.stringify(stored?.server_diagnostics)).not.toContain(address);
      expect(JSON.stringify(stored?.server_diagnostics)).not.toContain("private-value");
      expect(stored?.server_diagnostics).toMatchObject({ data: "none", report: { empty: false } });
    });
  });
  it("refuses after the deadline, even when the request row has not ended", async () => {
    const { id, frame } = await run();
    const capture = await ask(id);
    await t.stores.pages.claimServerPreviewCapture({
      clientInstanceId,
      id: capture,
      now: new Date().toISOString()
    });
    if (!isFileSetId(frame.proof.fileSetId)) throw Error("Invalid file set");
    const token = mintAppContentToken(
      requireValue(requireValue(options().pages).contentKey),
      clientInstanceId,
      {
        fileSetId: frame.proof.fileSetId,
        viewerId: t.admin.id,
        pageSessionId: `capture:${capture}`,
        expiresAt: Math.floor(Date.now() / 1000) + 25
      }
    );
    const address = appContentPath(frame.proof.fileSetId, token);
    expect((await content(address)).statusCode).toBe(200);
    await withTestSql(
      (sql) =>
        sql`update preview_captures set server_request=jsonb_set(server_request,'{deadline}',to_jsonb((now()-interval '6 seconds')::text)) where id=${capture}`
    );
    expect((await content(address)).statusCode).not.toBe(200);
  });
  it.each(["ended", "other-person", "other-conversation", "api-key", "service"])(
    "refuses a row not belonging to its live person run: %s",
    async (caseName) => {
      const { id, frame } = await run();
      if (caseName === "ended")
        await withTestSql((sql) => sql`update agent_runs set status='completed' where id=${id}`);
      if (caseName === "api-key")
        await withTestSql(
          (sql) =>
            sql`update agent_runs set authorization_context=jsonb_set(authorization_context,'{delegatedActor}', '{"kind":"api_key","id":"key","displayLabel":"key","authSource":"test"}'::jsonb) where id=${id}`
        );
      if (caseName === "service")
        await withTestSql(
          (sql) =>
            sql`update agent_runs set authorization_context=jsonb_set(authorization_context,'{principal,kind}', '"service"'::jsonb) where id=${id}`
        );
      if (!isFileSetId(frame.proof.fileSetId)) throw Error("Invalid file set");
      await expect(
        t.stores.pages.requestPreviewCapture({
          clientInstanceId,
          runId: id,
          toolCallId: randomUUID(),
          conversationId: asConversationId(
            caseName === "other-conversation" ? "conversation_other" : frame.conversationId
          ),
          userId: asUserId(caseName === "other-person" ? t.kai.id : t.admin.id),
          fileSetId: frame.proof.fileSetId,
          requestedAt: new Date().toISOString(),
          perRun: 3,
          perHour: 20,
          server: {
            deadline: new Date(Date.now() + 20_000).toISOString(),
            size: "desktop",
            theme: "light"
          }
        })
      ).rejects.toThrow();
      await withTestSql(async (sql) => {
        const [row] = await sql`select count(*)::int as n from preview_captures where run_id=${id}`;
        expect(row?.n).toBe(0);
      });
    }
  );
  it("rechecks the run after the request and refuses before the service is called", async () => {
    const { id } = await run();
    const capture = await ask(id);
    let called = false;
    duringCapture = async () => {
      called = true;
      return { status: "refused", code: "capture_failed" };
    };
    await withTestSql((sql) => sql`update agent_runs set status='completed' where id=${id}`);
    await work(capture);
    expect(called).toBe(false);
  });
  it("serves stub App content without reading saved storage and refuses its proof for App calls", async () => {
    const { id } = await run();
    const frame = await t.openApp(t.admin.id, "draft");
    if (!isFileSetId(frame.proof.fileSetId)) throw Error("No file set");
    const runRow = await t.stores.agentRuns.getAgentRun({ clientInstanceId, runId: id });
    const asked = await t.stores.pages.requestPreviewCapture({
      clientInstanceId,
      userId: asUserId(t.admin.id),
      conversationId: requireValue(runRow).conversationId,
      runId: id,
      toolCallId: randomUUID(),
      fileSetId: frame.proof.fileSetId,
      requestedAt: new Date().toISOString(),
      perRun: 3,
      perHour: 20,
      server: {
        deadline: new Date(Date.now() + 20_000).toISOString(),
        size: "desktop",
        theme: "light"
      }
    });
    if (!("id" in asked)) throw Error("Limit");
    await t.stores.pages.claimServerPreviewCapture({
      clientInstanceId,
      id: asked.id,
      now: new Date().toISOString()
    });
    const storage = {
      clientInstanceId,
      userId: asUserId(t.admin.id),
      appId: await t.assetId("app", "orders")
    };
    await t.stores.pages.mutateAppUserStorage({
      ...storage,
      mutation: { type: "set", key: "secret", value: "private-stored-value" }
    });
    const spy = vi.spyOn(t.stores.pages, "getAppUserStorage");
    const session = `capture:${asked.id}`;
    const token = mintAppContentToken(
      requireValue(requireValue(options().pages).contentKey),
      clientInstanceId,
      {
        fileSetId: frame.proof.fileSetId,
        viewerId: t.admin.id,
        pageSessionId: session,
        expiresAt: Math.floor(Date.now() / 1000) + 24,
        mode: "draft"
      }
    );
    const response = await content(appContentPath(frame.proof.fileSetId, token));
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("private-stored-value");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    const refused = await t.callAction(
      t.admin.id,
      { pageSessionId: session, proof: { fileSetId: frame.proof.fileSetId, token } },
      "load",
      { text: "capture must not call" }
    );
    expect(refused.statusCode).toBe(404);
    expect(t.refusal(refused)).toEqual({
      code: "NOT_FOUND",
      message: "The page session is not valid. Reload the page.",
      details: { reason: "session_invalid" }
    });
    expect(await t.stores.pages.getAppUserStorage(storage)).toEqual({
      secret: "private-stored-value"
    });
    await t.stores.pages.finishServerPreviewCapture({
      clientInstanceId,
      id: asked.id,
      answeredAt: new Date().toISOString(),
      outcome: { status: "refused", code: "capture_failed" }
    });
    expect((await content(appContentPath(frame.proof.fileSetId, token))).statusCode).not.toBe(200);
  });
  it("refuses apps.captures.call with the service token alone or a made-up grant", async () => {
    const credentials: Record<string, string>[] = [
      { authorization: "Bearer service-token" },
      { "x-capture-grant": "made-up" },
      { authorization: "Bearer service-token", "x-capture-grant": "made-up" }
    ];
    for (const headers of credentials)
      expect((await t.instance.call("apps.captures.call", { headers })).statusCode).toBe(403);
  });
  async function expectRefused(capture: string) {
    const service = vi.fn(async (): Promise<ServerPreviewCaptureOutcome> => ({
      status: "refused",
      code: "capture_failed"
    }));
    duringCapture = service;
    await work(capture);
    expect(service).not.toHaveBeenCalled();
    expect(
      (await t.stores.pages.getServerPreviewCapture({ clientInstanceId, id: capture }))?.status
    ).toBe("refused");
  }
  async function askForTarget(id: string, target?: { proof: { fileSetId: string } }) {
    const frame = target ?? (await t.openApp(t.admin.id, "draft"));
    if (!isFileSetId(frame.proof.fileSetId)) throw Error("No file set");
    const runRow = requireValue(
      await t.stores.agentRuns.getAgentRun({ clientInstanceId, runId: asAgentRunId(id) })
    );
    const asked = await t.stores.pages.requestPreviewCapture({
      clientInstanceId,
      userId: asUserId(requireValue(runRow.ownerUserId)),
      conversationId: runRow.conversationId,
      runId: id,
      toolCallId: randomUUID(),
      fileSetId: frame.proof.fileSetId,
      requestedAt: new Date().toISOString(),
      perRun: 3,
      perHour: 20,
      server: {
        deadline: new Date(Date.now() + 20_000).toISOString(),
        size: "desktop",
        theme: "light"
      }
    });
    if (!("id" in asked)) throw Error("Limit");
    return asked.id;
  }
  it("refuses a user disabled after requesting an otherwise accessible Page", async () => {
    const { id } = await run(t.kai.id);
    const capture = await ask(id);
    await t.stores.users.updateUser({
      clientInstanceId,
      userId: asUserId(t.kai.id),
      status: "disabled"
    });
    // Identity construction also rejects disabled users. Observe this guard's early exit
    // so that removing it cannot be masked by that later refusal.
    const identity = vi.spyOn(
      await import("@work-shape/catalyst-core"),
      "authenticatedUserFromRecord"
    );
    try {
      await expectRefused(capture);
      expect(identity).not.toHaveBeenCalled();
    } finally {
      identity.mockRestore();
      await t.stores.users.updateUser({
        clientInstanceId,
        userId: asUserId(t.kai.id),
        status: "active"
      });
    }
  });
  it("rechecks conversation access even when the run and Page still belong to it", async () => {
    const { id, conversationId } = await run(t.kai.id);
    const capture = await ask(id);
    // Keep run/row/file-set agreement intact, but make the private transcript another person's.
    await withTestSql(
      (sql) =>
        sql`update conversations set visibility='private', created_by_user_id=${t.admin.id} where id=${conversationId}`
    );
    await expectRefused(capture);
  });
  it("refuses a Page from another conversation", async () => {
    const { id } = await run(t.kai.id);
    const target = await t.openPage(t.admin.id);
    await expectRefused(await askForTarget(id, target));
  });
  it("refuses an App without write rights even when it is the conversation's subject", async () => {
    const { id, conversationId } = await run(t.kai.id);
    await t.stores.conversations.setConversationSubject({
      clientInstanceId,
      conversationId,
      subject: { kind: "app", name: "orders" }
    });
    await expectRefused(await askForTarget(id));
  });
  it("refuses an unrelated App even when the person holds its write right", async () => {
    const { id } = await run();
    await expectRefused(await askForTarget(id));
  });
  it.each(["subject", "created"])(
    "captures a writable App related through %s",
    async (relation) => {
      const { id, conversationId } = await run();
      if (relation === "subject") {
        await t.stores.conversations.setConversationSubject({
          clientInstanceId,
          conversationId,
          subject: { kind: "app", name: "orders" }
        });
      } else {
        await t.stores.conversations.recordCreatedAsset({
          clientInstanceId,
          conversationId,
          assetId: await t.assetId("app", "orders"),
          revision: 1,
          createdAt: new Date().toISOString()
        });
      }
      const service = vi.fn(async (): Promise<ServerPreviewCaptureOutcome> => ({
        status: "refused",
        code: "capture_failed"
      }));
      duringCapture = service;
      await work(await askForTarget(id));
      expect(service).toHaveBeenCalledOnce();
    }
  );
  it("enforces three requests per run even when the writer asks for a higher limit", async () => {
    const { id, frame } = await run();
    if (!isFileSetId(frame.proof.fileSetId)) throw Error("No file set");
    const request = {
      clientInstanceId,
      userId: asUserId(t.admin.id),
      conversationId: asConversationId(frame.conversationId),
      runId: id,
      fileSetId: frame.proof.fileSetId,
      requestedAt: new Date().toISOString(),
      perRun: 100,
      perHour: 100,
      server: {
        deadline: new Date(Date.now() + 20_000).toISOString(),
        size: "desktop" as const,
        theme: "light" as const
      }
    };
    for (let n = 0; n < 3; n++)
      expect(
        await t.stores.pages.requestPreviewCapture({ ...request, toolCallId: randomUUID() })
      ).toHaveProperty("id");
    expect(
      await t.stores.pages.requestPreviewCapture({ ...request, toolCallId: randomUUID() })
    ).toEqual({ refused: "capture_limit" });
  });
  it("enforces twenty requests per person per hour across runs", async () => {
    for (let n = 0; n < 21; n++) {
      const { id, frame } = await run(t.kai.id);
      if (!isFileSetId(frame.proof.fileSetId)) throw Error("No file set");
      const result = await t.stores.pages.requestPreviewCapture({
        clientInstanceId,
        userId: asUserId(t.kai.id),
        conversationId: asConversationId(frame.conversationId),
        runId: id,
        toolCallId: randomUUID(),
        fileSetId: frame.proof.fileSetId,
        requestedAt: new Date().toISOString(),
        perRun: 100,
        perHour: 100,
        server: {
          deadline: new Date(Date.now() + 20_000).toISOString(),
          size: "desktop",
          theme: "light"
        }
      });
      if (n < 20) expect(result).toHaveProperty("id");
      else expect(result).toEqual({ refused: "capture_limit" });
    }
  });
  it("keeps the service dark when the API client is absent", () => {
    expect(
      createChatServerJobs({
        ...options(),
        pages: { ...requireValue(options().pages), previewCaptureService: undefined }
      }).handlers.some((handler) => handler.kind.kind === "preview.capture")
    ).toBe(false);
  });
});
