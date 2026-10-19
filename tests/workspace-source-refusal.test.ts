import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AppError, asClientInstanceId } from "@work-shape/catalyst-core";
import {
  createExecutionWorkspaceSourceAttachmentHandler,
  WORKSPACE_SOURCE_ACCEPTED_FILE_TYPES
} from "@work-shape/catalyst-client-assembly";
import { createFilesystemObjectStorage } from "@work-shape/catalyst-object-storage";
import { createTestInstance } from "./support/test-instance";
import { uploadContent } from "./support/chat-server-attachment-harness";

it("lists every picker extension in the localized unsupported-type refusal (LOWS-D)", async () => {
  const root = await mkdtemp(join(tmpdir(), "lows-d-unsupported-"));
  const clientInstanceId = asClientInstanceId("lows-d-unsupported");
  const { stores } = await createTestInstance();
  const conversation = await stores.createConversationForTesting({
    clientInstanceId,
    createdByUserId: "user-1",
    createdByExternalUserId: "user-1",
    title: "Unsupported upload",
    retainedUntil: "2999-01-01T00:00:00.000Z"
  });
  const handler = createExecutionWorkspaceSourceAttachmentHandler({
    clientInstanceId,
    files: stores.files,
    objectStore: createFilesystemObjectStorage(root),
    markDeletedOnDelete: true
  });
  try {
    for (const locale of ["en", "de"] as const) {
      const result = await handler
        .uploadDraftAttachment({
          conversationId: conversation.id,
          ownerUserId: "user-1",
          locale,
          filename: "archive.zip",
          mimeType: "application/zip",
          content: uploadContent(new Uint8Array([0]))
        })
        .catch((error: unknown) => {
          if (!(error instanceof AppError)) throw error;
          expect(error.code).toBe("VALIDATION_FAILED");
          return error.message;
        });
      if (typeof result !== "string") throw new Error("An unsupported upload was accepted");
      for (const type of WORKSPACE_SOURCE_ACCEPTED_FILE_TYPES.filter((type) =>
        type.startsWith(".")
      ))
        expect(result).toContain(type.slice(1).toUpperCase());
      expect(result).toContain(locale === "de" ? "Unterstützt werden:" : "Supported types:");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
