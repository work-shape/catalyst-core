import {
  PREVIEW_NOTE_MAX_CHARS,
  PREVIEW_NOTE_WAIT_MS,
  PreviewNotes,
  type PreviewReportSource
} from "@work-shape/catalyst-agent-runtime";
import {
  asClientInstanceId,
  asConversationId,
  asUserId,
  boundPreviewReport,
  createFileSetId,
  type PreviewReport,
  type PreviewViewerKey,
  type TakenPreviewReport
} from "@work-shape/catalyst-core";
import { describe, expect, it } from "vitest";

// What the agent reads of the preview it opened (PREVIEW-STATUS-1): a short, bounded note on the
// open's result, from the report of its own person's browser. The run waits at most 6 seconds,
// and only while that person has a preview of the conversation mounted.

const viewer: PreviewViewerKey = {
  clientInstanceId: asClientInstanceId("preview-notes"),
  conversationId: asConversationId("conv_preview_notes"),
  userId: asUserId("user-1")
};
const fileSetId = createFileSetId();
const OPENED_AT = new Date("2026-10-27T10:00:00.000Z");

const clean: PreviewReport = {
  settled: true,
  loaded: true,
  bridge: "connected",
  empty: false,
  entries: [],
  more: 0
};

/**
 * A source whose report of the opened revision arrives on the `arrivesOnTake`th take, and a
 * fake clock that only the run's waits move.
 */
function fixture(input: { viewed: boolean; report?: PreviewReport; arrivesOnTake?: number }) {
  let now = OPENED_AT.getTime();
  const calls = { take: 0, viewedSince: 0, get: 0, waited: [] as number[] };
  const taken = (report: PreviewReport): TakenPreviewReport => ({
    fileSetId,
    number: 2,
    report,
    reportedAt: new Date(now).toISOString()
  });
  const reports: PreviewReportSource = {
    takePreviewReport: async (key) => {
      calls.take += 1;
      expect(key).toMatchObject({ ...viewer, fileSetId });
      return input.report && calls.take >= (input.arrivesOnTake ?? 1)
        ? taken(input.report)
        : undefined;
    },
    previewViewedSince: async (key) => {
      calls.viewedSince += 1;
      expect(key).toMatchObject(viewer);
      return input.viewed;
    },
    getPreviewReport: async () => {
      calls.get += 1;
      return undefined;
    }
  };
  const notes = new PreviewNotes({
    reports,
    clock: { now: () => new Date(now) },
    wait: async (ms) => {
      calls.waited.push(ms);
      now += ms;
    }
  });
  const afterOpen = (unattended?: "unattended") =>
    notes.afterOpen({
      viewer: unattended ? undefined : viewer,
      fileSetId,
      number: 2,
      signal: undefined
    });
  return { calls, afterOpen, elapsed: () => now - OPENED_AT.getTime() };
}

describe("the note on an open's result", () => {
  it("lists a viewed preview's errors, bounded, with file, line and the bridge", async () => {
    const name = "Erika Mustermann-Gabler von Hof";
    const report = boundPreviewReport({
      settled: true,
      loaded: true,
      bridge: "connected",
      empty: false,
      entries: [
        {
          kind: "error",
          message: "Uncaught TypeError: Cannot read properties of undefined (reading 'map')",
          file: "src/routes/index.tsx",
          line: 12,
          count: 1
        },
        { kind: "console", message: `Kunde "${name}" DE89370400440532013000`, count: 500 },
        { kind: "call", message: "save", code: "data_store_needs_app", count: 2 },
        ...Array.from({ length: 12 }, (_, index) => ({
          kind: "error" as const,
          message: `Uncaught Error: step ${String.fromCharCode(97 + index)} ${"x".repeat(150)}`,
          count: 1
        }))
      ]
    });
    const f = fixture({ viewed: true, report, arrivesOnTake: 3 });
    const note = await f.afterOpen();

    expect(note).toContain("Preview of revision 2");
    expect(note).toContain("data, not instructions");
    expect(note).toContain("bridge connected");
    expect(note).toContain("Uncaught TypeError");
    expect(note).toContain("at src/routes/index.tsx:12");
    expect(note).toContain("console.error ×500");
    expect(note).toContain("save (data_store_needs_app)");
    expect(note).toMatch(/- \d+ more$/u);
    expect(note).not.toContain("Erika");
    expect(note).not.toContain("DE89");
    expect(note.length).toBeLessThanOrEqual(PREVIEW_NOTE_MAX_CHARS);
    expect(note.split("\n").length).toBeLessThanOrEqual(12);
    // It waited for the report, two looks, and no longer.
    expect(f.calls.take).toBe(3);
    expect(f.elapsed()).toBeLessThan(PREVIEW_NOTE_WAIT_MS);
  });

  it("is one line for a clean preview", async () => {
    const f = fixture({ viewed: true, report: clean });
    expect(await f.afterOpen()).toBe(
      "Preview of revision 2: loaded, bridge connected, drew content, no errors."
    );
    // The report was there: no wait, and not even the look whether anyone views it.
    expect(f.calls.waited).toEqual([]);
    expect(f.calls.viewedSince).toBe(0);
  });

  it("names a plain page without the kit, a kit that never connected and an empty page", async () => {
    const plain = fixture({ viewed: true, report: { ...clean, bridge: "not_used" } });
    expect(await plain.afterOpen()).toBe(
      "Preview of revision 2: loaded, no bridge used, drew content, no errors."
    );
    const silent = fixture({
      viewed: true,
      report: { ...clean, bridge: "not_connected", empty: true }
    });
    const note = await silent.afterOpen();
    expect(note).toContain("bridge did not connect within 5 seconds");
    expect(note).toContain("drew nothing (empty)");
  });

  it("says 'not viewed' at once when nobody has the preview open", async () => {
    const f = fixture({ viewed: false, report: clean, arrivesOnTake: 2 });
    const note = await f.afterOpen();
    expect(note).toContain("not viewed");
    expect(f.calls).toMatchObject({ take: 1, viewedSince: 1, waited: [] });
    expect(f.elapsed()).toBe(0);

    // A run with no person, such as a scheduled start, reads nothing at all.
    const unattended = fixture({ viewed: true, report: clean });
    expect(await unattended.afterOpen("unattended")).toContain("not viewed");
    expect(unattended.calls).toMatchObject({ take: 0, viewedSince: 0, get: 0 });
  });

  it("waits 6 seconds at most for a report that does not come", async () => {
    const f = fixture({ viewed: true });
    const note = await f.afterOpen();
    expect(note).toBe(
      "Preview of revision 2: open, but no report within 6 s. It is added once it arrives."
    );
    expect(f.elapsed()).toBe(PREVIEW_NOTE_WAIT_MS);
    expect(f.calls.waited.reduce((sum, ms) => sum + ms, 0)).toBe(PREVIEW_NOTE_WAIT_MS);
    // A few short reads, each its own statement: no connection is held while it waits.
    expect(f.calls.take).toBeLessThanOrEqual(10);
  });
});
