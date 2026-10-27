import type { ApiClient } from "@work-shape/catalyst-api-client";
import type { FrameCapture } from "./bridge-host";

// The picture a run asks of the preview the person has open (PREVIEW-SEE-1). The interface
// learns of the request when it sees the run call `preview.capture`, asks the instance for its
// own requests of that conversation, and answers each from the mounted frame of the revision
// it names. The instance gives a person only the requests of runs that serve their turn, and
// takes an answer only with the proof of that person's own frame of that revision: another
// member who has the same conversation open finds no request and can answer none.

/** One mounted preview that can be asked for a picture. */
export interface PreviewCaptureTarget {
  /** The conversation the frame reports for; none where the instance takes the frame's own. */
  conversationId: string | undefined;
  fileSetId: string;
  capture(requestId: string): Promise<FrameCapture>;
  /** Sends the frame's answer to the request, with the frame's proof. */
  answer(captureId: string, capture: FrameCapture): Promise<unknown>;
}

const targets = new Set<PreviewCaptureTarget>();
const answering = new Set<string>();

/** Makes a mounted preview one that can be asked; the function returned unmounts it. */
export function registerPreviewCaptureTarget(target: PreviewCaptureTarget): () => void {
  targets.add(target);
  return () => {
    targets.delete(target);
  };
}

/**
 * After a run called the tool: the request reaches the instance's store about when the event
 * does, so it is asked for a few times before the interface gives up. The run then answers
 * `preview_not_viewed` itself.
 */
const PENDING_READS_MS = [0, 600, 1_500, 3_000];

/** The one call the interface makes here: its own requests of a conversation. */
type CaptureClient = {
  apps: { preview_captures: Pick<ApiClient["apps"]["preview_captures"], "pending"> };
};

/** Answers the requests the instance holds for this person in this conversation. */
export async function answerPreviewCaptures(
  client: CaptureClient,
  conversationId: string,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms))
): Promise<void> {
  for (const delay of PENDING_READS_MS) {
    if (delay > 0) await wait(delay);
    let pending: { id: string; fileSetId: string }[];
    try {
      ({ captures: pending } = await client.apps.preview_captures.pending({
        params: { conversationId }
      }));
    } catch {
      return;
    }
    const fresh = pending.filter((request) => !answering.has(request.id));
    if (fresh.length > 0) {
      await Promise.all(fresh.map((request) => answerOne(conversationId, request)));
      return;
    }
  }
}

async function answerOne(
  conversationId: string,
  request: { id: string; fileSetId: string }
): Promise<void> {
  const target = [...targets].find(
    (candidate) =>
      candidate.fileSetId === request.fileSetId &&
      (candidate.conversationId === undefined || candidate.conversationId === conversationId)
  );
  // No frame of that revision is mounted here: another tab of the same person may have one.
  if (!target) return;
  answering.add(request.id);
  try {
    const capture = await target.capture(request.id);
    await target.answer(request.id, capture);
  } catch {
    // The run answers that nobody looked once its wait ends.
  } finally {
    answering.delete(request.id);
  }
}

/** Bytes as base64, in pieces small enough for one call each. */
export function bytesToBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let at = 0; at < view.length; at += 0x8000) {
    binary += String.fromCharCode(...view.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}
