import { APP_BRIDGE_MARK, APP_BRIDGE_VERSION } from "@work-shape/catalyst-api-contract";
import { describe, expect, it, vi } from "vitest";
import {
  answerPreviewCaptures,
  bytesToBase64,
  createPageBridge,
  FRAME_CAPTURE_TIMEOUT_MS,
  registerPreviewCaptureTarget,
  type ArrivedMessage,
  type FrameCapture
} from "@work-shape/catalyst-chat-ui/pages";

// The interface's side of a picture of the preview (PREVIEW-SEE-1): the bridge asks the guard
// in the frame and takes only its frame's answer, and the interface answers only the requests
// the instance lists for this person, from a frame of the revision each names.

function frames() {
  const posted: unknown[] = [];
  const page = { postMessage: (message: unknown) => posted.push(message) };
  const holder = { length: 1, 0: page };
  const from = (source: unknown, data: unknown, origin = "null"): ArrivedMessage => ({
    data,
    origin,
    source
  });
  return { posted, page, holder, from };
}

function bridgeOf(holder: { length: number; [index: number]: unknown }) {
  return createPageBridge({
    frame: () => holder,
    session: "s-1",
    context: () => {
      throw new Error("not asked");
    },
    onNavigate: () => undefined,
    onResize: () => undefined
  });
}

const result = (body: object) => ({
  [APP_BRIDGE_MARK]: APP_BRIDGE_VERSION,
  type: "capture_result",
  ...body
});

describe("asking a frame for a picture", () => {
  it("asks the guard without a greeting and takes only its own frame's answer", async () => {
    const { posted, page, holder, from } = frames();
    const bridge = bridgeOf(holder);
    const asked = bridge.capture("r-1");
    expect(posted).toEqual([
      { [APP_BRIDGE_MARK]: APP_BRIDGE_VERSION, type: "capture", requestId: "r-1" }
    ]);
    const image = new Uint8Array([1, 2, 3]).buffer;
    // Another window, and an answer to another request, are not taken.
    bridge.receive(
      from({ postMessage() {} }, result({ requestId: "r-1", image, width: 10, height: 10 }))
    );
    bridge.receive(from(page, result({ requestId: "r-2", image, width: 10, height: 10 })));
    bridge.receive(from(page, result({ requestId: "r-1", image, width: 10, height: 20 })));
    await expect(asked).resolves.toEqual({ image, width: 10, height: 20 });
  });

  it("cannot take one from a frame that does not answer, or answers beyond the bounds", async () => {
    vi.useFakeTimers();
    try {
      const { page, holder, from } = frames();
      const bridge = bridgeOf(holder);
      const silent = bridge.capture("r-1");
      vi.advanceTimersByTime(FRAME_CAPTURE_TIMEOUT_MS);
      await expect(silent).resolves.toEqual({ unavailable: true });

      const tooLarge = bridge.capture("r-2");
      bridge.receive(
        from(
          page,
          result({ requestId: "r-2", image: new ArrayBuffer(400_001), width: 10, height: 10 })
        )
      );
      bridge.receive(from(page, result({ requestId: "r-2", unavailable: true })));
      await expect(tooLarge).resolves.toEqual({ unavailable: true });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("answering the instance's requests", () => {
  const picture: FrameCapture = {
    image: new Uint8Array([82, 73, 70, 70]).buffer,
    width: 4,
    height: 2
  };

  it("answers each listed request from the mounted frame of its revision, and no other", async () => {
    const answers: unknown[] = [];
    const target = (conversationId: string | undefined, fileSetId: string) =>
      registerPreviewCaptureTarget({
        conversationId,
        fileSetId,
        capture: () => Promise.resolve(picture),
        answer: (captureId, capture) => {
          answers.push({ fileSetId, captureId, capture });
          return Promise.resolve();
        }
      });
    const unregister = [
      target("conv-1", "fset-a"),
      target("conv-2", "fset-b"),
      target(undefined, "fset-c")
    ];
    const asked: string[] = [];
    const client = {
      apps: {
        preview_captures: {
          pending: ({ params }: { params: { conversationId: string } }) => {
            asked.push(params.conversationId);
            return Promise.resolve({
              captures: [
                { id: "pcap-1", fileSetId: "fset-a" },
                // A revision of another conversation's frame is not this one's to answer.
                { id: "pcap-2", fileSetId: "fset-b" },
                { id: "pcap-3", fileSetId: "fset-c" },
                { id: "pcap-4", fileSetId: "fset-none" }
              ]
            });
          }
        }
      }
    };
    await answerPreviewCaptures(client, "conv-1", () => Promise.resolve());
    expect(asked).toEqual(["conv-1"]);
    expect(answers).toEqual([
      { fileSetId: "fset-a", captureId: "pcap-1", capture: picture },
      { fileSetId: "fset-c", captureId: "pcap-3", capture: picture }
    ]);
    unregister.forEach((remove) => remove());
  });

  it("asks again a few times while the request is on its way, then stops", async () => {
    let reads = 0;
    const client = {
      apps: {
        preview_captures: {
          pending: () => {
            reads += 1;
            return Promise.resolve({ captures: [] });
          }
        }
      }
    };
    await answerPreviewCaptures(client, "conv-1", () => Promise.resolve());
    expect(reads).toBe(4);
  });

  it("sends the picture's bytes as base64", () => {
    expect(bytesToBase64(new Uint8Array([82, 73, 70, 70]).buffer)).toBe("UklGRg==");
  });
});
