import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AppError, asClientInstanceId, type DraftAttachment } from "@work-shape/catalyst-core";
import {
  createExecutionWorkspaceSourceAttachmentHandler,
  type ClientInstanceCapability
} from "@work-shape/catalyst-client-assembly";
import { createFilesystemObjectStorage } from "@work-shape/catalyst-object-storage";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import { createTestConfig } from "./support/fixtures";
import { createTestInstance } from "./support/test-instance";
import {
  createMultipartFilePayload,
  createTestAttachmentCapability
} from "./support/chat-server-attachment-harness";

const clientInstanceId = asClientInstanceId("demo-local");
const specializedPdf: ClientInstanceCapability = {
  name: "specialized-pdf",
  async create(context) {
    const contribution = await createTestAttachmentCapability().create(context);
    for (const handler of contribution.attachments ?? []) {
      const upload = handler.uploadDraftAttachment;
      handler.uploadDraftAttachment = (file) => {
        if (!handler.acceptsFile(file))
          throw new AppError("VALIDATION_FAILED", "Unsupported file type");
        return upload(file);
      };
      handler.acceptsFile = (file) =>
        file.mimeType === "application/pdf" || file.filename.endsWith(".pdf");
    }
    return contribution;
  }
};
const workspaceTools = ["workspace.import_files", "workspace.exec"];
const binary = Buffer.from([0, 0xff, 0x13, 0x01]);

async function fixture(
  toolNames = workspaceTools,
  enabled = true,
  capabilities: ClientInstanceCapability[] = []
) {
  const root = await mkdtemp(join(tmpdir(), "catalyst-af1-"));
  const app = await createTestInstance({
    config: createTestConfig({
      toolNames: enabled ? toolNames : [],
      developmentAuth: {
        enabled: true,
        user: {
          id: "file-user",
          externalUserId: "file-user",
          displayLabel: "File user",
          roles: ["user"],
          permissionRefs: []
        }
      },
      tools: (enabled ? workspaceTools : []).map((name) => ({ name, enabled: true })),
      workspaceObjectRoot: root,
      executionWorkspaces: { enabled, sourceFiles: { maxFileBytes: 128 } }
    }),
    capabilities,
    tools: []
  });
  const created = await app.call("conversations.create", { payload: { title: "Files" } });
  expect(created.statusCode).toBe(200);
  const conversationId: string = created.json().id;
  const upload = (
    filename: string,
    content = binary,
    agentName: string | undefined = "test_agent",
    contentType = "application/octet-stream"
  ) => {
    const multipart = createMultipartFilePayload({
      fieldName: "file",
      filename,
      contentType,
      content
    });
    return app.call("conversations.draft_attachments.upload", {
      params: { conversationId },
      query: agentName === undefined ? {} : { agentName },
      headers: multipart.headers,
      payload: multipart.payload
    });
  };
  return {
    app,
    root,
    upload,
    async close() {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

describe("AF-1 selected agent file intake", () => {
  it("accepts every requested extension and preserves the original bytes", async () => {
    const log = vi.spyOn(process.stdout, "write");
    const f = await fixture();
    try {
      const reader = createExecutionWorkspaceSourceAttachmentHandler({
        clientInstanceId,
        files: f.app.stores.files,
        objectStore: createFilesystemObjectStorage(f.root),
        markDeletedOnDelete: true
      });
      for (const extension of [
        "heic",
        "tiff",
        "bmp",
        "eml",
        "emlx",
        "msg",
        "dat",
        "zip",
        "7z",
        "rar",
        "pages",
        "numbers",
        "anything"
      ]) {
        const response = await f.upload(`synthetic.${extension}`);
        expect(response.statusCode, response.body).toBe(200);
        const attachment = response.json<{ attachment: DraftAttachment }>().attachment;
        const stored = await reader.readConversationFile({
          conversationId: attachment.conversationId,
          fileId: attachment.fileId
        });
        expect(stored.bytes).toEqual(new Uint8Array(binary));
        expect(
          reader.createAttachmentManifest([attachment]).attachments[0]?.modelContext?.text
        ).toContain("type: unknown binary data");
      }
      const mail =
        "From: private-address@example.invalid\nSubject: private-subject\n\nPrivate content";
      expect((await f.upload("private-filename.eml", Buffer.from(mail))).statusCode).toBe(200);
      const events = JSON.stringify(await f.app.stores.audit.listAuditEvents({ clientInstanceId }));
      const logs = log.mock.calls.map(([chunk]) => String(chunk)).join("");
      for (const privateText of [
        "synthetic.",
        "private-filename",
        "private-address",
        "private-subject",
        "Private content"
      ]) {
        expect(events).not.toContain(privateText);
        expect(logs).not.toContain(privateText);
      }
    } finally {
      log.mockRestore();
      await f.close();
    }
  });

  it.each([[], ["workspace.exec"], ["workspace.import_files"]])(
    "keeps the existing list without both tools (%s)",
    async (...toolNames: string[]) => {
      const f = await fixture(toolNames);
      try {
        for (const extension of [
          "heic",
          "tiff",
          "bmp",
          "eml",
          "emlx",
          "msg",
          "dat",
          "zip",
          "7z",
          "rar",
          "pages",
          "numbers"
        ]) {
          const refused = await f.upload(`synthetic.${extension}`);
          expect(refused.statusCode).toBe(422);
          expect(refused.json().error.message).toContain("Supported types:");
        }
        expect((await f.upload("notes.csv", Buffer.from("a,b\n1,2"))).statusCode).toBe(200);
      } finally {
        await f.close();
      }
    }
  );

  it("does not widen intake for legacy callers, unavailable agents or disabled workspaces", async () => {
    const f = await fixture();
    try {
      const upload = createMultipartFilePayload({
        fieldName: "file",
        filename: "mail.eml",
        contentType: "message/rfc822",
        content: "From: a@example.invalid\nSubject: Private\n\nMail"
      });
      const created = await f.app.call("conversations.create", { payload: { title: "Legacy" } });
      expect(
        (
          await f.app.call("conversations.draft_attachments.upload", {
            params: { conversationId: created.json().id },
            headers: upload.headers,
            payload: upload.payload
          })
        ).statusCode
      ).toBe(422);
      expect((await f.upload("source.dat", binary, "missing_agent")).statusCode).toBe(404);
      await applyAtCurrentRevisions(f.app.stores.configAssets, {
        clientInstanceId,
        mutations: [
          {
            type: "upsert",
            kind: "agent",
            name: "hidden_agent",
            config: {
              name: "hidden_agent",
              displayName: "Hidden",
              instructions: "Test",
              modelProviderId: "local",
              toolNames: workspaceTools
            }
          }
        ]
      });
      expect((await f.upload("source.dat", binary, "hidden_agent")).statusCode).toBe(200);
      await f.app.stores.configAssets.setAgentUse({
        clientInstanceId,
        agentName: "hidden_agent",
        use: "granted"
      });
      expect((await f.upload("source.dat", binary, "hidden_agent")).statusCode).toBe(404);
      await f.app.stores.configAssets.setAgentUse({
        clientInstanceId,
        agentName: "hidden_agent",
        use: "everyone"
      });
      await f.app.stores.configAssets.setAgentAvailability({
        clientInstanceId,
        agentName: "hidden_agent",
        availability: { mode: "selected", personalWorkspaces: false, collaborationWorkspaceIds: [] }
      });
      expect((await f.upload("source.dat", binary, "hidden_agent")).statusCode).toBe(404);
    } finally {
      await f.close();
    }
    const disabled = await fixture(workspaceTools, false, [specializedPdf]);
    try {
      expect((await disabled.upload("source.dat")).statusCode).toBe(422);
    } finally {
      await disabled.close();
    }
  });

  it("routes a ZIP called PDF to the source handler beside a specialized PDF reader", async () => {
    // A specialized reader selected by the browser's media type must never own this ZIP.
    const capability = specializedPdf;
    const f = await fixture(workspaceTools, true, [capability]);
    try {
      const response = await f.upload(
        "renamed.pdf",
        Buffer.from("PK\x03\x04synthetic"),
        "test_agent",
        "application/pdf"
      );
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().attachment.processingMetadata).toMatchObject({
        source: "execution_workspace_source",
        detectedType: "ZIP archive"
      });
      const reader = createExecutionWorkspaceSourceAttachmentHandler({
        clientInstanceId,
        files: f.app.stores.files,
        objectStore: createFilesystemObjectStorage(f.root),
        markDeletedOnDelete: false
      });
      const zipAttachment = response.json<{ attachment: DraftAttachment }>().attachment;
      expect(
        reader.createAttachmentManifest([zipAttachment]).attachments[0]?.modelContext?.text
      ).toContain("type: ZIP archive");
      const text = await f.upload(
        "text.pdf",
        Buffer.from("This is plain text"),
        "test_agent",
        "application/pdf"
      );
      expect(text.statusCode, text.body).toBe(200);
      expect(text.json().attachment.processingMetadata).toMatchObject({
        source: "execution_workspace_source",
        detectedType: "Text"
      });
      const renamedPdf = await f.upload("original.dat", Buffer.from("%PDF-1.7"));
      expect(renamedPdf.statusCode, renamedPdf.body).toBe(200);
      expect(renamedPdf.json().attachment.processingMetadata).toMatchObject({
        source: "execution_workspace_source",
        detectedType: "PDF document"
      });
      const pdf = await f.upload(
        "document.pdf",
        Buffer.from("%PDF-1.7"),
        "test_agent",
        "application/pdf"
      );
      expect(pdf.statusCode, pdf.body).toBe(200);
      expect(pdf.json().attachment.processingMetadata.source).not.toBe(
        "execution_workspace_source"
      );
    } finally {
      await f.close();
    }
  });

  it("still refuses empty files, Word locks and files over the source byte limit", async () => {
    const f = await fixture();
    try {
      for (const [filename, bytes] of [
        ["empty.dat", Buffer.alloc(0)],
        ["~$document.docx", binary],
        ["large.dat", Buffer.alloc(129)]
      ] as const) {
        const refused = await f.upload(filename, bytes);
        expect(refused.statusCode, refused.body).toBe(422);
        expect(refused.body).not.toContain(filename);
      }
      expect(await f.app.stores.audit.listAuditEvents({ clientInstanceId })).not.toEqual([]);
    } finally {
      await f.close();
    }
  });
});
