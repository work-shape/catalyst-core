import { describe, expect, it } from "vitest";
import {
  partitionAttachments,
  planAttachmentGroup
} from "../packages/chat-ui/src/message-attachments";

describe("sent message attachment grouping", () => {
  it("keeps short stacks inline", () => {
    expect(planAttachmentGroup(4, false)).toEqual({ layout: "inline", visible: 4, hidden: 0 });
  });

  it("does not invent overflow when a grouped card has fewer files than its capacity", () => {
    expect(planAttachmentGroup(5, false)).toEqual({ layout: "card", visible: 5, hidden: 0 });
    expect(planAttachmentGroup(6, false)).toEqual({ layout: "card", visible: 6, hidden: 0 });
  });

  it("collapses long stacks into a card that reveals the remainder on demand", () => {
    expect(planAttachmentGroup(17, false)).toEqual({ layout: "card", visible: 6, hidden: 11 });
    expect(planAttachmentGroup(17, true)).toEqual({ layout: "card", visible: 17, hidden: 0 });
  });

  it("groups only the files so image attachments keep their thumbnails", () => {
    expect(
      partitionAttachments([
        { type: "file", name: "0. Fragebogen.pdf", contentType: "application/pdf" },
        { type: "image", name: "scan.png", contentType: "image/png" },
        { type: "document", name: "1. Datenschutz.pdf" },
        { type: "file", name: "photo.jpeg" }
      ])
    ).toEqual({ images: [1, 3], files: [0, 2] });
  });
});
