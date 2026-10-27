import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  asAgentRunId,
  asConversationId,
  asManagedArtifactId,
  asToolCallId,
  asUserId,
  isFileSetId,
  type PreviewReport,
  type ToolExecutionContext,
  type ToolHandlerResult,
  type ToolHandlerSuccessResult
} from "@work-shape/catalyst-core";
import {
  createJobWorker,
  createPreviewCaptureObjectReader
} from "@work-shape/catalyst-client-assembly";
import { createChatServerJobs } from "@work-shape/catalyst-server";
import {
  createPreviewCaptureTool,
  PREVIEW_CAPTURE_TOOL_NAME
} from "@work-shape/catalyst-tool-execution";
import { clientInstanceId } from "./support/access-instance";
import { expectStatus } from "./support/app-instance";
import { setupAppActions, type AppActionsInstance, type Frame } from "./support/app-actions";
import { testServerOptions } from "./support/test-instance";
import { webp } from "./support/webp";

// A picture of the preview a run asks for (PREVIEW-SEE-1), on the real store and routes: the
// run's request waits for the browser of the person whose turn it serves, that person's
// interface finds it and answers with the proof of their own frame of that revision, and the
// picture becomes an artifact of the conversation that only the model and the run's work read.
// Nobody else's browser can answer, a preview that reaches data through a personal connection
// is never pictured, and no audit event, Operation Run or log line holds a picture.

const HOUR_MS = 60 * 60 * 1000;
const pendingSchema = z.object({
  captures: z.array(z.object({ id: z.string(), fileSetId: z.string() }))
});
const viewed: PreviewReport = {
  settled: true,
  loaded: true,
  bridge: "not_used",
  empty: false,
  entries: [],
  more: 0
};

type OpenedPage = Frame & { pageId: string; conversationId: string };

/** The tool's result, which a refusal is too: the tool never fails a call. */
async function succeeded(
  result: Promise<ToolHandlerResult> | ToolHandlerResult
): Promise<ToolHandlerSuccessResult> {
  const answered = await result;
  if (answered.status !== "success") throw new Error(`The tool failed: ${answered.error.code}`);
  return answered;
}

describe("a picture of the preview", () => {
  let t: AppActionsInstance;
  let calls = 0;
  beforeAll(async () => {
    t = await setupAppActions();
  });
  afterAll(() => t.closeAll());

  const report = (userId: string, frame: OpenedPage) =>
    t.call(userId, "apps.sessions.report", {
      params: { pageSessionId: frame.pageSessionId },
      payload: { ...frame.proof, report: viewed }
    });
  const pending = (userId: string, conversationId: string) =>
    t.call(userId, "apps.preview_captures.pending", { params: { conversationId } });
  const answer = (
    userId: string,
    frame: Frame,
    captureId: string,
    body: { image: string } | { unavailable: true }
  ) =>
    t.call(userId, "apps.sessions.capture", {
      params: { pageSessionId: frame.pageSessionId, captureId },
      payload: { ...frame.proof, ...body }
    });
  const pendingIds = async (userId: string, conversationId: string) => {
    const response = await pending(userId, conversationId);
    expectStatus(response, 200);
    return pendingSchema.parse(response.json()).captures;
  };

  const contextFor = (userId: string, conversationId: string): ToolExecutionContext => {
    calls += 1;
    return {
      locale: "de",
      clientInstanceId,
      correlationId: "corr_capture",
      user: {
        id: userId,
        externalUserId: userId,
        displayLabel: userId,
        roles: ["user"],
        permissionRefs: [],
        clientInstanceId,
        authSource: "test"
      },
      toolRequest: {
        toolName: PREVIEW_CAPTURE_TOOL_NAME,
        toolCallId: asToolCallId(`call_${calls}`),
        agentRunId: asAgentRunId(`run_capture_${calls}`),
        conversationId: asConversationId(conversationId),
        agentName: "builder",
        input: {}
      }
    };
  };

  /** The tool, with a browser that does what an interface does on its first wait. */
  const toolWith = (browser: () => Promise<void>) => {
    let asked = false;
    return createPreviewCaptureTool({
      captures: t.stores.pages,
      wait: async (ms) => {
        if (!asked) {
          asked = true;
          await browser();
        }
        await new Promise((done) => setTimeout(done, Math.min(ms, 20)));
      }
    });
  };

  it("takes the person's picture of their own frame and keeps it for the model and the run's work only", async () => {
    const frame = await t.openPage(t.admin.id);
    expectStatus(await report(t.admin.id, frame), 200);
    const picture = webp(1280, 900, 20_000);
    let answered: unknown;
    const tool = toolWith(async () => {
      // Another member sees the same run event: no request is theirs.
      expectStatus(await pending(t.kai.id, frame.conversationId), 404);
      const [request] = await pendingIds(t.admin.id, frame.conversationId);
      if (!request) throw new Error("No request");
      expect(request.fileSetId).toBe(frame.proof.fileSetId);
      // Kai cannot answer it with the admin's frame either.
      expectStatus(
        await answer(t.kai.id, frame, request.id, {
          image: Buffer.from(webp(10, 10)).toString("base64")
        }),
        404
      );
      const response = await answer(t.admin.id, frame, request.id, {
        image: Buffer.from(picture).toString("base64")
      });
      expectStatus(response, 200);
      answered = response.json();
      // Answered once: a second answer is not taken.
      expect(
        (
          await answer(t.admin.id, frame, request.id, {
            image: Buffer.from(picture).toString("base64")
          })
        ).json()
      ).toEqual({ accepted: false });
    });
    const result = await succeeded(tool.execute({}, contextFor(t.admin.id, frame.conversationId)));
    expect(answered).toEqual({ accepted: true });
    expect(result.output).toEqual({ captured: true, revision: 1, width: 1280, height: 900 });
    const [artifact] = result.artifacts ?? [];
    expect(artifact).toMatchObject({
      kind: "image.webp",
      mimeType: "image/webp",
      modelVisibility: { type: "image", mimeType: "image/webp" }
    });
    if (!artifact) throw new Error("No artifact");

    // An artifact of the conversation, shown to the model and in the run's work, not a file.
    const stored = await t.stores.files.getManagedArtifact({
      clientInstanceId,
      artifactId: artifact.artifactId
    });
    expect(stored).toMatchObject({
      conversationId: frame.conversationId,
      status: "available",
      byteSize: picture.byteLength,
      metadata: { source: "preview_capture", purpose: "inspection", width: 1280, height: 900 }
    });
    const reader = createPreviewCaptureObjectReader({
      clientInstanceId,
      files: t.stores.files,
      objects: t.objects
    });
    const read = await reader.readArtifact({ clientInstanceId, artifactId: artifact.artifactId });
    expect(Buffer.from(read.bytes).equals(Buffer.from(picture))).toBe(true);
    // The reader takes only pictures of previews: any other artifact is another reader's.
    await expect(
      reader.readArtifact({ clientInstanceId, artifactId: asManagedArtifactId("artifact_unknown") })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // No audit event, Operation Run or request of the routes holds the picture or its request.
    const runs = await t.stores.operationRuns.list({ clientInstanceId });
    expect(runs.filter((run) => /capture/u.test(run.operation))).toEqual([]);
    const events = JSON.stringify(
      await t.stores.audit.listAuditEvents({ clientInstanceId, limit: 1000 })
    );
    expect(events).not.toContain("preview_capture");
    expect(events).not.toContain(artifact.artifactId);

    // The picture goes with its conversation.
    if (!stored) throw new Error("Not stored");
    expect(t.objects.has(stored.objectKey)).toBe(true);
    expectStatus(
      await t.call(t.admin.id, "conversations.delete", {
        params: { conversationId: frame.conversationId }
      }),
      200
    );
    expect(t.objects.has(stored.objectKey)).toBe(false);
    await expect(
      reader.readArtifact({ clientInstanceId, artifactId: artifact.artifactId })
    ).rejects.toMatchObject({
      code: "NOT_FOUND"
    });
  });

  it("answers preview_not_viewed when only another member views the conversation", async () => {
    const frame = await t.openPage(t.admin.id);
    if (!isFileSetId(frame.proof.fileSetId)) throw new Error("No file set id");
    // Kai's browser reported the same revision: it is not the admin's.
    await t.stores.pages.putPreviewReport({
      clientInstanceId,
      conversationId: asConversationId(frame.conversationId),
      fileSetId: frame.proof.fileSetId,
      userId: asUserId(t.kai.id),
      report: viewed,
      reportedAt: new Date().toISOString()
    });
    const started = Date.now();
    const result = await succeeded(
      toolWith(() => Promise.resolve()).execute({}, contextFor(t.admin.id, frame.conversationId))
    );
    expect(result.output).toMatchObject({ captured: false, code: "preview_not_viewed" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("answers only from a frame of the revision asked for, in the conversation asked in", async () => {
    const frame = await t.openPage(t.admin.id);
    const other = await t.openPage(t.admin.id);
    expectStatus(await report(t.admin.id, frame), 200);
    let refusedOther: unknown;
    const tool = toolWith(async () => {
      const [request] = await pendingIds(t.admin.id, frame.conversationId);
      if (!request) throw new Error("No request");
      // The admin's frame of another conversation's Page cannot answer it.
      refusedOther = (
        await answer(t.admin.id, other, request.id, {
          image: Buffer.from(webp(100, 100)).toString("base64")
        })
      ).json();
      // A picture beyond the bounds is refused, and the request ends at once.
      const tooWide = await answer(t.admin.id, frame, request.id, {
        image: Buffer.from(webp(1281, 100)).toString("base64")
      });
      expectStatus(tooWide, 422);
    });
    const result = await succeeded(tool.execute({}, contextFor(t.admin.id, frame.conversationId)));
    expect(refusedOther).toEqual({ accepted: false });
    expect(result.output).toMatchObject({ captured: false, code: "capture_unavailable" });
    expect(t.objects.keys().filter((key) => key.includes(frame.conversationId))).toEqual([]);

    // A body well beyond 400 KB is refused before anything is read.
    const tooLarge = await answer(t.admin.id, frame, "pcap_any", {
      image: Buffer.from(webp(100, 100, 401_000)).toString("base64")
    });
    expectStatus(tooLarge, 422);
  });

  it("answers capture_unavailable for a browser that cannot take a picture", async () => {
    const frame = await t.openPage(t.admin.id);
    expectStatus(await report(t.admin.id, frame), 200);
    const tool = toolWith(async () => {
      const [request] = await pendingIds(t.admin.id, frame.conversationId);
      if (!request) throw new Error("No request");
      expect((await answer(t.admin.id, frame, request.id, { unavailable: true })).json()).toEqual({
        accepted: true
      });
    });
    const result = await succeeded(tool.execute({}, contextFor(t.admin.id, frame.conversationId)));
    expect(result.output).toMatchObject({ captured: false, code: "capture_unavailable" });
  });

  it("never pictures a preview that reaches data through a personal connection", async () => {
    const frame = await t.openPage(t.admin.id);
    expectStatus(await report(t.admin.id, frame), 200);
    // The Connection `crm` the Page's actions call is one each person signs in to.
    const registry = t.operationCalls.registry;
    const resolveMany = registry.resolveMany.bind(registry);
    const spy = vi.spyOn(registry, "resolveMany").mockImplementation(async (names) => {
      const resolved = await resolveMany(names);
      return new Map(
        [...resolved].map(([name, definition]) => [
          name,
          name.includes("crm") ? { ...definition, personalConnection: true as const } : definition
        ])
      );
    });
    try {
      let listed: unknown;
      const tool = toolWith(async () => {
        listed = await pendingIds(t.admin.id, frame.conversationId);
      });
      const result = await succeeded(
        tool.execute({}, contextFor(t.admin.id, frame.conversationId))
      );
      expect(listed).toEqual([]);
      expect(result.output).toMatchObject({ captured: false, code: "preview_personal_data" });

      // A picture sent anyway, to a request the browser took before, is dropped as it came.
      if (!isFileSetId(frame.proof.fileSetId)) throw new Error("No file set id");
      const viewer = {
        clientInstanceId,
        conversationId: asConversationId(frame.conversationId),
        userId: asUserId(t.admin.id)
      };
      const asked = await t.stores.pages.requestPreviewCapture({
        ...viewer,
        runId: "run_personal",
        toolCallId: "call_personal",
        fileSetId: frame.proof.fileSetId,
        requestedAt: new Date().toISOString(),
        perRun: 3,
        perHour: 20
      });
      if (!("id" in asked)) throw new Error("Refused");
      expect(
        (
          await answer(t.admin.id, frame, asked.id, {
            image: Buffer.from(webp(100, 100)).toString("base64")
          })
        ).json()
      ).toEqual({ accepted: true });
      expect(await t.stores.pages.getPreviewCapture({ clientInstanceId, id: asked.id })).toEqual({
        status: "refused",
        code: "preview_personal_data"
      });
      expect(t.objects.keys().filter((key) => key.includes(frame.conversationId))).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("counts three pictures a run and twenty a person an hour, and forgets requests after a day", async () => {
    const frame = await t.openPage(t.kai.id);
    if (!isFileSetId(frame.proof.fileSetId)) throw new Error("No file set id");
    const fileSetId = frame.proof.fileSetId;
    const viewer = {
      clientInstanceId,
      conversationId: asConversationId(frame.conversationId),
      userId: asUserId(t.kai.id)
    };
    const start = Date.parse("2026-10-27T08:00:00.000Z");
    const ask = (runId: string, toolCallId: string, at: number) =>
      t.stores.pages.requestPreviewCapture({
        ...viewer,
        runId,
        toolCallId,
        fileSetId,
        requestedAt: new Date(at).toISOString(),
        perRun: 3,
        perHour: 20
      });
    const outcomes = [];
    for (const call of ["a", "b", "c", "d"]) outcomes.push(await ask("run_limit_1", call, start));
    expect(outcomes.map((outcome) => ("id" in outcome ? "asked" : outcome.refused))).toEqual([
      "asked",
      "asked",
      "asked",
      "capture_limit"
    ]);
    // The same call asked again is the same request, not a new one.
    expect(await ask("run_limit_1", "a", start)).toEqual(outcomes[0]);
    for (let run = 2; run <= 18; run += 1) {
      expect(await ask(`run_limit_${run}`, "a", start + run)).toHaveProperty("id");
    }
    expect(await ask("run_limit_19", "a", start + 100)).toEqual({ refused: "capture_limit" });
    // An hour later the person may look again.
    expect(await ask("run_limit_20", "a", start + HOUR_MS + 1)).toHaveProperty("id");

    // The hourly job of the preview's reports removes requests older than a day.
    const options = testServerOptions(t.instance);
    if (!options) throw new Error("No server options");
    const dayLater = new Date(start + HOUR_MS + 24 * HOUR_MS + 2);
    const jobs = createChatServerJobs(options, { now: () => dayLater });
    const handler = jobs.handlers.find((entry) => entry.kind.kind === "preview_reports.prune");
    const schedule = jobs.schedules.find((entry) => entry.kind.kind === "preview_reports.prune");
    if (!handler || !schedule) throw new Error("No prune job");
    const worker = createJobWorker({
      stores: t.stores,
      clientInstanceId,
      logger: options.logger,
      handlers: [handler],
      schedules: [schedule]
    });
    await worker.runDue();
    await worker.stop();
    const first = outcomes[0];
    if (!first || !("id" in first)) throw new Error("Not asked");
    expect(
      await t.stores.pages.getPreviewCapture({ clientInstanceId, id: first.id })
    ).toBeUndefined();
  });
});
