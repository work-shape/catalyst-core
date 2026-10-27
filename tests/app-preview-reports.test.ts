import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PREVIEW_REPORT_MAX_BYTES } from "@work-shape/catalyst-asset-schemas";
import {
  asConversationId,
  asUserId,
  isFileSetId,
  type PreviewReport
} from "@work-shape/catalyst-core";
import { createJobWorker } from "@work-shape/catalyst-client-assembly";
import { createChatServerJobs } from "@work-shape/catalyst-server";
import { clientInstanceId } from "./support/access-instance";
import { expectStatus, type AppFile } from "./support/app-instance";
import { setupAppActions, type AppActionsInstance, type Frame } from "./support/app-actions";
import { testServerOptions } from "./support/test-instance";

// What a preview reports of itself (PREVIEW-STATUS-1) is kept for the agent of the conversation
// the preview belongs to: scrubbed and bounded again on the server, one row per conversation
// and file set, gone after 24 hours and with the conversation. It is diagnostics: no Operation
// Run and no audit event holds it.

const NAME = "Erika Mustermann-Gabler von Hof";
const IBAN = "DE89370400440532013000";
const MAIL = "erika.mustermann@example.org";
const HOUR_MS = 60 * 60 * 1000;

/** A report as a browser could post it: inside the contract's bounds, but not scrubbed. */
const unscrubbed = (): PreviewReport => ({
  settled: true,
  loaded: true,
  bridge: "not_connected",
  empty: false,
  entries: [
    { kind: "console", message: `Kunde "${NAME}" ${IBAN}`, count: 500 },
    {
      kind: "error",
      message: `Uncaught Error: no row for ${MAIL} since 2026-10-27`,
      file: "https://chat.example.org/app-content/fs_x/secret-token.mac/assets/main.js",
      line: 3,
      count: 1
    },
    { kind: "call", message: "save", code: "data_store_needs_app", count: 2 }
  ],
  more: 0
});

/** A folder whose script imports the kit's client. */
const kitSource = (): AppFile[] => [
  {
    path: "app.yaml",
    text: JSON.stringify({ id: "kit-page", name: "Kit page", kit: "1.8.0", entry: "index.html" })
  },
  {
    path: "index.html",
    text: '<!doctype html><title>Kit</title><div id="root"></div><script type="module" src="./main.js"></script>'
  },
  {
    path: "main.js",
    text: 'import { getContext } from "@work-shape/catalyst-app-kit";\nvoid getContext();\n'
  }
];

describe("what a preview reports of itself", () => {
  let t: AppActionsInstance;
  beforeAll(async () => {
    t = await setupAppActions();
  });
  afterAll(() => t.closeAll());

  const report = (
    userId: string,
    frame: Frame,
    body: { report: PreviewReport; conversationId?: string }
  ) =>
    t.call(userId, "apps.sessions.report", {
      params: { pageSessionId: frame.pageSessionId },
      payload: { ...frame.proof, ...body }
    });
  const kept = (
    conversationId: string,
    fileSetId: string,
    notBefore = new Date(0),
    userId = t.admin.id
  ) => {
    if (!isFileSetId(fileSetId)) throw new Error("No file set id");
    return t.stores.pages.getPreviewReport({
      clientInstanceId,
      conversationId: asConversationId(conversationId),
      fileSetId,
      userId: asUserId(userId),
      notBefore: notBefore.toISOString()
    });
  };

  it("keeps a Page's report in its conversation, scrubbed again and under 2 KB", async () => {
    const frame = await t.openPage(t.admin.id);
    const answered = await report(t.admin.id, frame, { report: unscrubbed() });
    expectStatus(answered, 200);
    expect(answered.json()).toEqual({ stored: true });
    const stored = await kept(frame.conversationId, frame.proof.fileSetId);
    expect(stored?.report).toEqual({
      settled: true,
      loaded: true,
      // The folder is plain HTML: its build recorded that it uses no kit.
      bridge: "not_used",
      empty: false,
      entries: [
        { kind: "console", message: 'Kunde "…" …', count: 500 },
        {
          kind: "error",
          message: "Uncaught Error: no row for … since …",
          file: "assets/main.js",
          line: 3,
          count: 1
        },
        { kind: "call", message: "save", code: "data_store_needs_app", count: 2 }
      ],
      more: 0
    });
    const text = JSON.stringify(stored?.report);
    for (const data of ["Erika", IBAN, MAIL, "2026-10-27", "secret-token"]) {
      expect(text).not.toContain(data);
    }
    expect(new TextEncoder().encode(JSON.stringify(stored?.report)).byteLength).toBeLessThan(
      PREVIEW_REPORT_MAX_BYTES
    );

    // One row per conversation and file set: the next report takes its place.
    expectStatus(
      await report(t.admin.id, frame, {
        report: { ...unscrubbed(), entries: [], bridge: "connected" }
      }),
      200
    );
    expect((await kept(frame.conversationId, frame.proof.fileSetId))?.report.entries).toEqual([]);

    // Diagnostics, not a governance event.
    const runs = await t.stores.operationRuns.list({ clientInstanceId });
    expect(runs.filter((run) => run.operation.includes("report"))).toEqual([]);
    const events = await t.stores.audit.listAuditEvents({ clientInstanceId, limit: 1000 });
    expect(JSON.stringify(events)).not.toContain("Kunde");
    expect(JSON.stringify(events)).not.toContain("apps.sessions.report");
  });

  it("keeps the bridge a kit folder reports, and refuses a report beyond the bounds", async () => {
    const frame = await t.openPage(t.admin.id, kitSource());
    expectStatus(await report(t.admin.id, frame, { report: unscrubbed() }), 200);
    expect((await kept(frame.conversationId, frame.proof.fileSetId))?.report.bridge).toBe(
      "not_connected"
    );
    const tooMany = {
      ...unscrubbed(),
      entries: Array.from({ length: 11 }, () => ({
        kind: "error" as const,
        message: "x",
        count: 1
      }))
    };
    expectStatus(await report(t.admin.id, frame, { report: tooMany }), 422);
    const tooLong = {
      ...unscrubbed(),
      entries: [{ kind: "error" as const, message: "x".repeat(201), count: 1 }]
    };
    expectStatus(await report(t.admin.id, frame, { report: tooLong }), 422);
  });

  it("is refused to anyone but the viewer the frame's address was minted for", async () => {
    const frame = await t.openPage(t.admin.id);
    const refused = await report(t.kai.id, frame, { report: unscrubbed() });
    expectStatus(refused, 404);
    expect(t.refusal(refused).details).toMatchObject({ reason: "session_invalid" });
    expect(await kept(frame.conversationId, frame.proof.fileSetId)).toBeUndefined();
  });

  it("keeps an App draft's report only in a conversation about that App", async () => {
    const page = await t.openPage(t.admin.id);
    const conversationId = asConversationId(page.conversationId);
    const draft = await t.openApp(t.admin.id, "draft");
    const asked = { report: unscrubbed(), conversationId };
    expect((await report(t.admin.id, draft, asked)).json()).toEqual({ stored: false });

    await t.stores.conversations.setConversationSubject({
      clientInstanceId,
      conversationId,
      subject: { kind: "app", name: "orders" }
    });
    expect((await report(t.admin.id, draft, asked)).json()).toEqual({ stored: true });
    expect(await kept(conversationId, draft.proof.fileSetId)).toBeDefined();
    // Without a conversation a draft reports nowhere, and a published App never does.
    expect((await report(t.admin.id, draft, { report: unscrubbed() })).json()).toEqual({
      stored: false
    });
    const published = await t.openApp(t.admin.id, "published");
    expect((await report(t.admin.id, published, asked)).json()).toEqual({ stored: false });
    expect(await kept(conversationId, published.proof.fileSetId)).toBeUndefined();
  });

  it("forgets a report after 24 hours, and with its conversation", async () => {
    const frame = await t.openPage(t.admin.id);
    expectStatus(await report(t.admin.id, frame, { report: unscrubbed() }), 200);
    const written = await kept(frame.conversationId, frame.proof.fileSetId);
    if (!written) throw new Error("Nothing was kept");
    const reportedAt = new Date(written.reportedAt);

    // A read never answers a report older than a day, whether or not it was removed yet.
    const dayLater = new Date(reportedAt.getTime() + 24 * HOUR_MS + 1);
    expect(
      await kept(
        frame.conversationId,
        frame.proof.fileSetId,
        new Date(dayLater.getTime() - 24 * HOUR_MS)
      )
    ).toBeUndefined();

    // The hourly job removes it.
    const options = testServerOptions(t.instance);
    if (!options) throw new Error("No server options");
    const jobs = createChatServerJobs(options, { now: () => dayLater });
    const schedule = jobs.schedules.find((entry) => entry.kind.kind === "preview_reports.prune");
    expect(schedule).toMatchObject({ every: HOUR_MS, dueAtStart: true });
    const handler = jobs.handlers.find((entry) => entry.kind.kind === "preview_reports.prune");
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
    expect(await kept(frame.conversationId, frame.proof.fileSetId)).toBeUndefined();

    // A report goes with its conversation, and none is kept for a deleted one.
    const other = await t.openPage(t.admin.id);
    expectStatus(await report(t.admin.id, other, { report: unscrubbed() }), 200);
    expectStatus(
      await t.call(t.admin.id, "conversations.delete", {
        params: { conversationId: other.conversationId }
      }),
      200
    );
    expect(await kept(other.conversationId, other.proof.fileSetId)).toBeUndefined();
    if (!isFileSetId(other.proof.fileSetId)) throw new Error("No file set id");
    expect(
      await t.stores.pages.putPreviewReport({
        clientInstanceId,
        conversationId: asConversationId(other.conversationId),
        fileSetId: other.proof.fileSetId,
        userId: asUserId(t.admin.id),
        report: unscrubbed(),
        reportedAt: new Date().toISOString()
      })
    ).toBe(false);
  });
  it("keeps each viewer's report apart, and a run takes only its own person's, once", async () => {
    const frame = await t.openPage(t.admin.id);
    if (!isFileSetId(frame.proof.fileSetId)) throw new Error("No file set id");
    const conversationId = asConversationId(frame.conversationId);
    const fileSetId = frame.proof.fileSetId;
    const admin = { clientInstanceId, conversationId, userId: asUserId(t.admin.id) };
    const kai = { clientInstanceId, conversationId, userId: asUserId(t.kai.id) };
    const start = new Date(Date.now() - 1000).toISOString();
    const clean: PreviewReport = {
      settled: true,
      loaded: true,
      bridge: "connected",
      empty: false,
      entries: [],
      more: 0
    };
    const broken: PreviewReport = {
      ...clean,
      entries: [{ kind: "error", message: "Uncaught TypeError: x is undefined", count: 1 }]
    };
    const put = (viewer: typeof admin, report: PreviewReport) =>
      t.stores.pages.putPreviewReport({
        ...viewer,
        fileSetId,
        report,
        reportedAt: new Date().toISOString()
      });

    // Another member views the same revision: the run of the admin's turn does not see it.
    expect(await put(kai, broken)).toBe(true);
    expect(await t.stores.pages.previewViewedSince({ ...admin, since: start })).toBe(false);
    expect(await t.stores.pages.takePreviewReport({ ...admin, notBefore: start })).toBeUndefined();
    expect(
      await t.stores.pages.takePreviewReport({ ...admin, fileSetId, notBefore: start })
    ).toBeUndefined();

    // The admin's own view is a row of its own beside it.
    expect(await put(admin, clean)).toBe(true);
    expect(await t.stores.pages.previewViewedSince({ ...admin, since: start })).toBe(true);
    expect(await t.stores.pages.takePreviewReport({ ...admin, notBefore: start })).toMatchObject({
      fileSetId,
      number: 1,
      report: clean
    });
    expect((await kept(frame.conversationId, fileSetId, new Date(0), t.kai.id))?.report).toEqual(
      broken
    );

    // Noted once: the same report again, as after a reload, is not noted again; a new one is.
    expect(await t.stores.pages.takePreviewReport({ ...admin, notBefore: start })).toBeUndefined();
    await put(admin, clean);
    expect(await t.stores.pages.takePreviewReport({ ...admin, notBefore: start })).toBeUndefined();
    await put(admin, broken);
    expect(
      (await t.stores.pages.takePreviewReport({ ...admin, notBefore: start }))?.report
    ).toEqual(broken);
    // The open of a revision reads its report, noted or not; an unsettled one it does not take.
    expect(
      (await t.stores.pages.takePreviewReport({ ...admin, fileSetId, notBefore: start }))?.report
    ).toEqual(broken);
    await put(admin, { ...clean, settled: false });
    expect(
      await t.stores.pages.takePreviewReport({ ...admin, fileSetId, notBefore: start })
    ).toBeUndefined();

    // Kai's report goes with the conversation as the admin's does.
    expectStatus(
      await t.call(t.admin.id, "conversations.delete", {
        params: { conversationId: frame.conversationId }
      }),
      200
    );
    expect(await kept(frame.conversationId, fileSetId, new Date(0), t.kai.id)).toBeUndefined();
  });
});
