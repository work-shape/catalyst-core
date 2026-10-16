import { describe, expect, it } from "vitest";
import { createTestInstance } from "./support/test-instance";
import { createTestConfig } from "./support/fixtures";
import {
  createMultipartFilePayload,
  createTestAttachmentCapability
} from "./support/chat-server-attachment-harness";

describe("draft attachment multipart parsing", () => {
  it("uploads for an authenticated user, refuses malformed multipart and accepts the next upload", async () => {
    const app = await createTestInstance({
      config: createTestConfig(),
      env: {},
      capabilities: [createTestAttachmentCapability()],
      tools: []
    });
    try {
      const created = await app.call("conversations.create", {
        payload: { title: "Upload checks" }
      });
      expect(created.statusCode).toBe(200);
      const params = { conversationId: created.json<{ id: string }>().id };
      const upload = createMultipartFilePayload({
        fieldName: "file",
        filename: "receipt.txt",
        contentType: "text/plain",
        content: "Synthetic receipt"
      });
      const sendUpload = () =>
        app.call("conversations.draft_attachments.upload", {
          params,
          headers: upload.headers,
          payload: upload.payload
        });
      expect((await sendUpload()).statusCode).toBe(200);

      const boundary = "x".repeat(257);
      const oversized = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="receipt.txt"',
        "Content-Type: text/plain",
        "",
        "Synthetic receipt",
        `--${boundary}--`,
        ""
      ].join("\r\n");
      for (const malformed of [
        { contentType: "multipart/form-data", payload: "Missing boundary" },
        { contentType: `multipart/form-data; boundary=${boundary}`, payload: oversized }
      ]) {
        const rejected = await app.call("conversations.draft_attachments.upload", {
          params,
          headers: { "content-type": malformed.contentType },
          payload: malformed.payload
        });
        expect(rejected.statusCode).toBe(400);
        expect(rejected.json()).toEqual({
          error: {
            code: "BAD_REQUEST",
            message: "The multipart upload cannot be read",
            correlationId: expect.any(String)
          }
        });
      }

      const unauthenticated = await app.call("conversations.draft_attachments.upload", {
        params,
        headers: { ...upload.headers, "x-dev-user-id": "unknown-user" },
        payload: upload.payload
      });
      expect(unauthenticated.statusCode).toBe(401);
      expect((await sendUpload()).statusCode).toBe(200);
      const listed = await app.call("conversations.draft_attachments.list", { params });
      expect(listed.statusCode).toBe(200);
      expect(listed.json<{ items: unknown[] }>().items).toHaveLength(2);
    } finally {
      await app.close();
    }
  });
});
