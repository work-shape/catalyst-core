import { ApiError } from "@vivd-catalyst/api-client";
import { describe, expect, it } from "vitest";
import {
  uploadErrorMessage,
  uploadFileWithRetry,
  withoutDraftAttachment
} from "../packages/chat-ui/src/conversation/draft-attachment-controller";
import { isAbandonedDraftConversation } from "../packages/chat-ui/src/workspace/workspace-chat-model";
import { createTranslationContext } from "@vivd-catalyst/chat-ui";

const file = () => new File(["content"], "Perso.pdf", { type: "application/pdf" });
const { t } = createTranslationContext("de");

describe("draft attachment upload", () => {
  it("retries an upload the gateway gave up on, with the file already read", async () => {
    const received: File[] = [];
    const result = await uploadFileWithRetry(
      file(),
      async (readFile) => {
        received.push(readFile);
        if (received.length < 3) {
          throw new ApiError(502, "API request failed", undefined);
        }
        return "stored";
      },
      0
    );

    expect(result).toBe("stored");
    expect(received).toHaveLength(3);
    expect(received[0]?.name).toBe("Perso.pdf");
    expect(received[0]?.type).toBe("application/pdf");
    expect(await received[0]?.text()).toBe("content");
  });

  it("waits as long as a rate-limited answer says and then stores the file", async () => {
    const waits: number[] = [];
    let calls = 0;
    const limited = new ApiError(429, "Too many requests. Try again later.", {
      error: { code: "RATE_LIMITED", details: { retryAfterSeconds: 17 } }
    });
    const result = await uploadFileWithRetry(
      file(),
      async () => {
        calls += 1;
        // More refusals than the attempts a gateway failure gets.
        if (calls <= 4) {
          throw limited;
        }
        return "stored";
      },
      0,
      async (ms) => {
        waits.push(ms);
      }
    );

    expect(result).toBe("stored");
    expect(waits).toEqual([17000, 17000, 17000, 17000]);

    // An instance that never lets the file through is not waited on for ever.
    waits.length = 0;
    await expect(
      uploadFileWithRetry(
        file(),
        () => Promise.reject(limited),
        0,
        async (ms) => {
          waits.push(ms);
        }
      )
    ).rejects.toBe(limited);
    expect(waits).toHaveLength(5);
  });

  it("does not retry an answer from the API", async () => {
    let calls = 0;
    const rejected = new ApiError(400, "File exceeds the configured upload size limit", undefined);
    await expect(
      uploadFileWithRetry(
        file(),
        async () => {
          calls += 1;
          throw rejected;
        },
        0
      )
    ).rejects.toBe(rejected);

    expect(calls).toBe(1);
    expect(uploadErrorMessage(rejected, "Perso.pdf", t)).toBe(
      "Perso.pdf: File exceeds the configured upload size limit"
    );
  });

  it("names the file when the upload keeps failing or the file cannot be read", async () => {
    const gatewayFailure = new ApiError(502, "API request failed", undefined);
    expect(uploadErrorMessage(gatewayFailure, "Perso.pdf", t)).toContain("„Perso.pdf“");

    const unreadable = file();
    unreadable.arrayBuffer = () => Promise.reject(new DOMException("gone", "NotReadableError"));
    let calls = 0;
    const error = await uploadFileWithRetry(unreadable, async () => (calls += 1), 0).catch(
      (caught: unknown) => caught
    );

    expect(calls).toBe(0);
    expect(uploadErrorMessage(error, "Perso.pdf", t)).toContain("nicht gelesen werden");
  });
});

describe("abandoned draft conversation", () => {
  const emptied = {
    conversationId: "conv_draft",
    selectedConversationId: "conv_draft",
    messagesLoaded: true,
    messageCount: 0,
    running: false
  };

  it("returns to the start page only when the open conversation holds nothing", () => {
    expect(isAbandonedDraftConversation(emptied)).toBe(true);
    expect(isAbandonedDraftConversation({ ...emptied, messageCount: 2 })).toBe(false);
    expect(isAbandonedDraftConversation({ ...emptied, messagesLoaded: false })).toBe(false);
    expect(isAbandonedDraftConversation({ ...emptied, running: true })).toBe(false);
    expect(isAbandonedDraftConversation({ ...emptied, selectedConversationId: "conv_other" })).toBe(
      false
    );
    expect(isAbandonedDraftConversation({ ...emptied, selectedConversationId: undefined })).toBe(
      false
    );
  });

  it("counts the draft attachments that remain after a removal", () => {
    const drafts = [{ id: "att_1" }, { id: "att_2" }];
    expect(withoutDraftAttachment(drafts, "att_1").map(({ id }) => id)).toEqual(["att_2"]);
    expect(withoutDraftAttachment(withoutDraftAttachment(drafts, "att_1"), "att_2")).toEqual([]);
  });
});
