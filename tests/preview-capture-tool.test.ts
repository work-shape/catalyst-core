import { describe, expect, it } from "vitest";
import { z } from "zod";
import { materializeModelTools } from "@work-shape/catalyst-agent-runtime";
import {
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  createFileSetId,
  asManagedArtifactId,
  asToolCallId,
  isPreviewCaptureWithinBounds,
  PREVIEW_CAPTURE_MAX_BYTES,
  readWebpSize,
  type FileSetId,
  type PagesStore,
  type PreviewCaptureState,
  type ToolExecutionContext,
  type ToolHandlerResult,
  type ToolHandlerSuccessResult
} from "@work-shape/catalyst-core";
import {
  createPreviewCaptureTool,
  PREVIEW_CAPTURE_TOOL_NAME,
  ToolRegistry
} from "@work-shape/catalyst-tool-execution";
import { agent } from "./support/data-tools-fixture";
import { webp } from "./support/webp";

// The run's side of a picture of the preview (PREVIEW-SEE-1): `preview.capture` asks the
// browser of the person whose turn the run serves, waits up to 10 seconds for the answer, and
// returns the picture as an image only the model of this run reads. The store and the browser
// are fakes here; `app-preview-captures.test.ts` runs the same on the real store and routes.

const clientInstanceId = asClientInstanceId("test-client");
const conversationId = asConversationId("conv_capture");
const fileSetId = createFileSetId();

type Captures = Pick<
  PagesStore,
  "viewedPreview" | "requestPreviewCapture" | "getPreviewCapture" | "settlePreviewCapture"
>;

interface Row {
  userId: string;
  runId: string;
  toolCallId: string;
  state: PreviewCaptureState;
}

/** A store of requests in memory, with the viewers it has seen and the limits it counts. */
function fakeStore(viewers: Record<string, FileSetId | undefined>): Captures & {
  rows: Map<string, Row>;
} {
  const rows = new Map<string, Row>();
  return {
    rows,
    viewedPreview: (input) => Promise.resolve(viewers[input.userId]),
    requestPreviewCapture: (input) => {
      const own = [...rows.values()];
      if (
        own.filter((row) => row.runId === input.runId).length >= input.perRun ||
        own.filter((row) => row.userId === input.userId).length >= input.perHour
      ) {
        return Promise.resolve({ refused: "capture_limit" as const });
      }
      const id = `pcap_${rows.size + 1}`;
      rows.set(id, {
        userId: input.userId,
        runId: input.runId,
        toolCallId: input.toolCallId,
        state: { status: "pending" }
      });
      return Promise.resolve({ id });
    },
    getPreviewCapture: ({ id }) => Promise.resolve(rows.get(id)?.state),
    settlePreviewCapture: ({ id, from, outcome }) => {
      const row = rows.get(id);
      if (!row || !(from as readonly string[]).includes(row.state.status)) {
        return Promise.resolve(false);
      }
      row.state =
        outcome.status === "captured"
          ? { ...outcome, number: 3 }
          : { status: "refused", code: outcome.code };
      return Promise.resolve(true);
    }
  };
}

function contextFor(
  userId: string,
  toolCallId = "call_1",
  further: Partial<ToolExecutionContext> = {}
): ToolExecutionContext {
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
      toolCallId: asToolCallId(toolCallId),
      agentRunId: asAgentRunId("run_capture"),
      conversationId,
      agentName: "builder",
      input: {}
    },
    ...further
  };
}

/**
 * A clock that moves only when the tool waits, and a browser that answers on the n-th wait:
 * what the person's interface does once it saw the run call the tool.
 */
function harness(store: ReturnType<typeof fakeStore>, browser?: (waits: number) => void) {
  let now = Date.parse("2026-10-27T10:00:00.000Z");
  let waits = 0;
  const tool = createPreviewCaptureTool({
    captures: store,
    now: () => new Date(now),
    wait: (ms) => {
      waits += 1;
      now += ms;
      browser?.(waits);
      return Promise.resolve();
    }
  });
  return {
    run: (context: ToolExecutionContext) => tool.execute({}, context),
    elapsed: () => now - Date.parse("2026-10-27T10:00:00.000Z")
  };
}

/** The browser of the person answers the newest pending request with a picture. */
function answersWithPicture(store: ReturnType<typeof fakeStore>, onWait = 2) {
  return (waits: number) => {
    if (waits !== onWait) return;
    for (const [, row] of store.rows) {
      if (row.state.status === "pending") {
        row.state = {
          status: "captured",
          artifactId: asManagedArtifactId("artifact_capture"),
          width: 1280,
          height: 900,
          number: 3
        };
      }
    }
  };
}

/** The tool's result, which a refusal is too: the tool never fails a call. */
async function succeeded(
  result: Promise<ToolHandlerResult> | ToolHandlerResult
): Promise<ToolHandlerSuccessResult> {
  const answered = await result;
  if (answered.status !== "success") throw new Error(`The tool failed: ${answered.error.code}`);
  return answered;
}

describe("preview.capture", () => {
  it("returns the person's picture as an image only the model of this run reads", async () => {
    const store = fakeStore({ "user-1": fileSetId });
    const { run, elapsed } = harness(store, answersWithPicture(store));
    const result = await succeeded(run(contextFor("user-1")));
    expect(result.output).toEqual({ captured: true, revision: 3, width: 1280, height: 900 });
    expect(result.artifacts).toEqual([
      {
        artifactId: "artifact_capture",
        kind: "image.webp",
        filename: "preview-revision-3.webp",
        mimeType: "image/webp",
        modelVisibility: { type: "image", mimeType: "image/webp" },
        metadata: { previewCapture: true, revision: 3 }
      }
    ]);
    // The trace of the call names the outcome, never the picture.
    expect(JSON.stringify(result.auditSummary)).not.toContain("artifact_capture");
    expect(elapsed()).toBeLessThan(1_000);
    // The request was the run's, for the person and the revision they view.
    expect([...store.rows.values()]).toMatchObject([
      { userId: "user-1", runId: "run_capture", toolCallId: "call_1" }
    ]);
  });

  it("answers preview_not_viewed at once when the person has no preview open", async () => {
    // Another member views the same conversation: the run of user-1's turn does not use it.
    const store = fakeStore({ "user-2": fileSetId });
    const { run, elapsed } = harness(store, answersWithPicture(store, 1));
    const result = await succeeded(run(contextFor("user-1")));
    expect(result.output).toMatchObject({ captured: false, code: "preview_not_viewed" });
    expect(result.artifacts ?? []).toEqual([]);
    expect(store.rows.size).toBe(0);
    expect(elapsed()).toBe(0);
  });

  it("asks nobody for a run with nobody at the screen", async () => {
    const store = fakeStore({ "user-1": fileSetId });
    const { run } = harness(store);
    for (const further of [
      { unattended: true },
      { subagent: true },
      { workflowAgent: true }
    ] as const) {
      const result = await succeeded(run(contextFor("user-1", "call_1", further)));
      expect(result.output).toMatchObject({ captured: false, code: "preview_not_viewed" });
    }
    const { toolRequest: _none, ...withoutRequest } = contextFor("user-1");
    expect((await succeeded(run(withoutRequest))).output).toMatchObject({
      code: "preview_not_viewed"
    });
    expect(store.rows.size).toBe(0);
  });

  it("ends the request after 10 seconds without an answer, and takes no later answer", async () => {
    const store = fakeStore({ "user-1": fileSetId });
    const { run, elapsed } = harness(store);
    const result = await succeeded(run(contextFor("user-1")));
    expect(result.output).toMatchObject({ captured: false, code: "preview_not_viewed" });
    expect(elapsed()).toBe(10_000);
    const [row] = [...store.rows.values()];
    expect(row?.state).toEqual({ status: "refused", code: "preview_not_viewed" });
  });

  it("waits a little longer for a picture the browser is already storing", async () => {
    const store = fakeStore({ "user-1": fileSetId });
    const { run, elapsed } = harness(store, (waits) => {
      const [row] = [...store.rows.values()];
      // The browser takes the request just before the wait ends, and stores it 2 seconds later.
      if (row && waits === 33) row.state = { status: "answering" };
      if (row && waits === 40) {
        row.state = {
          status: "captured",
          artifactId: asManagedArtifactId("artifact_late"),
          width: 800,
          height: 600,
          number: 3
        };
      }
    });
    const result = await succeeded(run(contextFor("user-1")));
    expect(result.output).toMatchObject({ captured: true, width: 800 });
    expect(elapsed()).toBeGreaterThan(10_000);
    expect(elapsed()).toBeLessThanOrEqual(15_000);
  });

  it("passes on the browser's and the store's refusals in plain words", async () => {
    const store = fakeStore({ "user-1": fileSetId });
    const { run } = harness(store, () => {
      for (const row of store.rows.values()) {
        if (row.state.status === "pending") {
          row.state = { status: "refused", code: "capture_unavailable" };
        }
      }
    });
    const unavailable = await succeeded(run(contextFor("user-1", "call_safari")));
    expect(unavailable.output).toMatchObject({ captured: false, code: "capture_unavailable" });
    expect(JSON.stringify(unavailable.output)).toMatch(/Safari/u);

    // The limits are the store's: three per run.
    const limited = fakeStore({ "user-1": fileSetId });
    const answer = answersWithPicture(limited, 1);
    const second = harness(limited, () => answer(1));
    const codes = [];
    for (const call of ["a", "b", "c", "d"]) {
      const result = await succeeded(second.run(contextFor("user-1", call)));
      const output = z
        .object({ captured: z.boolean(), code: z.string().optional() })
        .parse(result.output);
      codes.push(output.code ?? "captured");
    }
    expect(codes).toEqual(["captured", "captured", "captured", "capture_limit"]);
  });
});

describe("the picture's bounds", () => {
  it("reads a WebP's size from its header and refuses anything beyond the bounds", () => {
    expect(readWebpSize(webp(1280, 1600))).toEqual({ width: 1280, height: 1600 });
    expect(isPreviewCaptureWithinBounds(webp(1280, 1600))).toEqual({ width: 1280, height: 1600 });
    expect(isPreviewCaptureWithinBounds(webp(1281, 900))).toBeUndefined();
    expect(isPreviewCaptureWithinBounds(webp(1280, 1601))).toBeUndefined();
    expect(isPreviewCaptureWithinBounds(webp(800, 600, PREVIEW_CAPTURE_MAX_BYTES))).toEqual({
      width: 800,
      height: 600
    });
    expect(
      isPreviewCaptureWithinBounds(webp(800, 600, PREVIEW_CAPTURE_MAX_BYTES + 2))
    ).toBeUndefined();
    // A PNG, and a WebP whose container length is not its own, are no picture.
    const png = new Uint8Array(64);
    png.set([0x89, 0x50, 0x4e, 0x47]);
    expect(isPreviewCaptureWithinBounds(png)).toBeUndefined();
    const cut = webp(800, 600, 100).subarray(0, 90);
    expect(isPreviewCaptureWithinBounds(cut)).toBeUndefined();
  });
});

describe("offering preview.capture", () => {
  const tool = createPreviewCaptureTool({ captures: fakeStore({}) });
  const toolRegistry = new ToolRegistry({ tools: [tool] });
  const builder = agent("builder", [PREVIEW_CAPTURE_TOOL_NAME]);

  it("is offered only to a model that reads images", () => {
    const names = (imageInput?: boolean) =>
      materializeModelTools({
        agent: builder,
        capabilities: { nativeTools: [], ...(imageInput === undefined ? {} : { imageInput }) },
        toolRegistry
      }).map((offered) => offered.name);
    expect(names(true)).toEqual([PREVIEW_CAPTURE_TOOL_NAME]);
    expect(names(false)).toEqual([]);
    expect(names()).toEqual([]);
  });
});
