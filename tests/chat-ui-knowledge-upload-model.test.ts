import { describe, expect, it } from "vitest";
import {
  nextUpload,
  queueUploads,
  retryUpload,
  settleUpload,
  uploadableFile,
  uploadFormats
} from "@work-shape/catalyst-chat-ui/build-area";

// The queue of uploads of one Add dialog (ACCEPT-FIX-1, F1), as pure functions.

const file = (name: string, size = 10, type = "") => ({ name, size, type });
let counter = 0;
const newId = () => `up_${++counter}`;

describe("the upload queue of a Knowledge Base", () => {
  it("reads text formats where the instance names none", () => {
    expect(uploadFormats(undefined)).toEqual(["txt", "markdown"]);
    expect(uploadFormats([])).toEqual(["txt", "markdown"]);
    expect(uploadFormats(["txt", "markdown", "pdf", "docx"])).toEqual([
      "txt",
      "markdown",
      "pdf",
      "docx"
    ]);
  });

  it("refuses before sending a format the instance does not read and a file over 25 MiB", () => {
    const text = ["txt", "markdown"];
    expect(uploadableFile(file("a.md"), text)).toEqual({ uploadable: true });
    expect(uploadableFile(file("a.pdf"), text)).toMatchObject({ uploadable: false });
    expect(uploadableFile(file("a.pdf"), [...text, "pdf"])).toEqual({ uploadable: true });
    expect(uploadableFile(file("a.csv"), [...text, "pdf"])).toMatchObject({ uploadable: false });
    expect(uploadableFile(file("a.txt", 25 * 1024 * 1024 + 1), text)).toEqual({
      uploadable: false,
      reason: "knowledge.addTooLarge"
    });
  });

  it("sends one file at a time, and Retry sends again only a failed one", () => {
    let queue = queueUploads([], [file("a.txt"), file("b.txt"), file("c.pdf")], ["txt"], newId);
    expect(queue.map((item) => item.state)).toEqual(["waiting", "waiting", "failed"]);

    const first = nextUpload(queue);
    expect(first?.name).toBe("a.txt");
    queue = settleUpload(queue, first?.id ?? "", { state: "uploading" });
    expect(nextUpload(queue)).toBeUndefined();
    queue = settleUpload(queue, first?.id ?? "", { state: "added" });

    const second = nextUpload(queue);
    queue = settleUpload(queue, second?.id ?? "", {
      state: "failed",
      failure: { message: "refused" }
    });
    expect(nextUpload(queue)).toBeUndefined();

    // An added file and one refused before sending stay as they are.
    const refusedId = queue[2]?.id ?? "";
    expect(retryUpload(queue, first?.id ?? "", ["txt"], newId)).toEqual(queue);
    expect(retryUpload(queue, refusedId, ["txt"], newId)).toEqual(queue);

    // The instance answered the failure: its run would answer it again, so a new key.
    queue = retryUpload(queue, second?.id ?? "", ["txt"], newId);
    const again = nextUpload(queue);
    expect(again).toMatchObject({ id: second?.id, name: "b.txt", state: "waiting" });
    expect(again?.key).not.toBe(second?.key);
    expect(queue[1]?.failure).toBeUndefined();
  });

  it("keeps the key of a call that got no answer, so its run answers instead of a second add", () => {
    let queue = queueUploads([], [file("a.txt")], ["txt"], newId);
    const sent = nextUpload(queue);
    queue = settleUpload(queue, sent?.id ?? "", {
      state: "failed",
      failure: { message: "offline" },
      unanswered: true
    });
    queue = retryUpload(queue, sent?.id ?? "", ["txt"], newId);
    expect(nextUpload(queue)).toMatchObject({ key: sent?.key, state: "waiting" });
    expect(queue[0]?.unanswered).toBeUndefined();
  });
});
