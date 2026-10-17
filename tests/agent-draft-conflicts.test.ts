import { AppError } from "@work-shape/catalyst-core";
import { platformAssetWriteRefusal } from "@work-shape/catalyst-tool-execution";
import { describe, expect, it } from "vitest";

describe("agent draft conflict attribution (Platform Access 62)", () => {
  it("tells the Build Agent whose draft won and when, without unrelated error details", () => {
    const details = {
      reason: "draft_changed",
      currentDraftRevision: 4,
      author: { userId: "writer", conversationId: "build", release: false },
      changedAt: "2026-10-17T12:00:00.000Z"
    };
    expect(
      platformAssetWriteRefusal(
        new AppError("REVISION_CONFLICT", "Read the draft again", {
          ...details,
          unrelated: "must not cross the tool boundary"
        })
      )
    ).toEqual({
      saved: false,
      conflict: "REVISION_CONFLICT",
      message: "Read the draft again",
      details
    });
    expect(
      platformAssetWriteRefusal(
        new AppError("REVISION_CONFLICT", "Read again", {
          reason: "draft_changed",
          currentDraftRevision: "invalid",
          author: "invalid"
        })
      )
    ).not.toHaveProperty("details");
  });
});
