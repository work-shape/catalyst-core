import { describe, expect, it } from "vitest";
import { toAttachmentFilePart } from "../packages/chat-ui/src/assistant-ui-adapter";
import { managedFileIdFromAttachmentContent } from "../packages/chat-ui/src/attachment-preview";

describe("chat attachment previews", () => {
  it("preserves the managed file id needed to open a committed attachment", () => {
    const part = toAttachmentFilePart({
      fileId: "file/with spaces",
      filename: "Input.pdf",
      mimeType: "application/pdf"
    });

    expect(part).toMatchObject({
      type: "file",
      filename: "Input.pdf",
      url: "vivd-file://file%2Fwith%20spaces"
    });
    expect(
      managedFileIdFromAttachmentContent([
        {
          type: "file",
          data: "vivd-file://file%2Fwith%20spaces",
          mimeType: "application/pdf"
        }
      ])
    ).toBe("file/with spaces");
  });

  it("does not treat ordinary external file URLs as managed preview targets", () => {
    expect(
      managedFileIdFromAttachmentContent([
        {
          type: "file",
          data: "https://example.test/input.pdf",
          mimeType: "application/pdf"
        }
      ])
    ).toBeUndefined();
  });
});
