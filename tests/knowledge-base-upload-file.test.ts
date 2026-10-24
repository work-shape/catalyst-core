import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  KNOWLEDGE_BASE_ACTIONS,
  KNOWLEDGE_BASE_ASSET_KIND,
  KNOWLEDGE_FILE_MAX_BYTES,
  asManagedFileId,
  type JsonObject
} from "@work-shape/catalyst-core";
import { runOperation } from "@work-shape/catalyst-tool-execution";
import { eventually, required } from "./support/assertions";
import {
  createManagedObjectTestAttachmentCapability,
  createMultipartFilePayload
} from "./support/chat-server-attachment-harness";
import {
  clientInstanceId,
  useDataStoreInstance,
  type DataStoreInstance
} from "./support/data-store-instance";
import { getTestJobs } from "./support/test-instance";

// `knowledge_bases.upload_file`: a writer sends one file from their device to a Knowledge Base
// that keeps documents, with no Conversation in between. The call runs as the Knowledge Base's
// `add_files`, with its right, checks, copy, audit and cleanup. Spec:
// data-stores-and-knowledge-bases.md, "Adding files" (upload on the Knowledge Base page; text
// files without document processing).

const KB = "handbuch";

const developmentAuth = {
  enabled: true,
  users: [
    { id: "user-1", roles: ["user", "admin", "superadmin"] },
    { id: "member-1", roles: ["user"] }
  ].map((user) => ({ ...user, externalUserId: user.id, displayLabel: user.id, permissionRefs: [] }))
};
const asMember = { "x-dev-user-id": "member-1" };

const FILE_NAME = "Urlaub Erika Mustermann.txt";
const FILE_TEXT = "Urlaubstage: 28 pro Jahr.";

const errorSchema = z.object({
  error: z.object({ code: z.string(), details: z.record(z.string(), z.unknown()).optional() })
});
const addedSchema = z.object({
  documents: z.array(z.object({ id: z.string(), fileId: z.string() })),
  count: z.number(),
  bytes: z.number()
});

describe("uploading a file to a Knowledge Base", () => {
  const { start, person } = useDataStoreInstance();

  async function instanceWithKnowledgeBase(): Promise<DataStoreInstance> {
    const attachments = createManagedObjectTestAttachmentCapability();
    const instance = await start(true, undefined, developmentAuth, undefined, {
      attachments: attachments.capability
    });
    const config: JsonObject = {
      name: KB,
      title: "Handbuch",
      description: "Rules of the team.",
      methods: ["keyword"]
    };
    const params = { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB };
    const written = await instance.api.call("assets.put", {
      params,
      payload: { config, expectedRevision: null }
    });
    expect(written.statusCode, written.body).toBe(200);
    const made = await instance.api.call("assets.publish", { params, payload: { revision: 1 } });
    expect(made.statusCode, made.body).toBe(200);
    const jobs = getTestJobs(instance.api);
    await eventually(async () => {
      await jobs.runDue();
      expect(
        await instance.stores.dataStores.findDataStoreByName({
          clientInstanceId,
          name: `knowledge-base:${KB}`
        })
      ).toMatchObject({ status: "ready", level: 13 });
    });
    return instance;
  }

  const upload = (
    world: DataStoreInstance,
    file: { filename: string; contentType: string; content: string | Buffer },
    headers: Record<string, string> = {}
  ) => {
    const body = createMultipartFilePayload({ fieldName: "file", ...file });
    return world.api.call("knowledge_bases.upload_file", {
      params: { knowledgeBase: KB },
      headers: { ...body.headers, ...headers },
      payload: body.payload
    });
  };

  const reasonOf = (answer: { json(): unknown }) =>
    errorSchema.parse(answer.json()).error.details?.reason;

  /** The status of every file the Knowledge Base owns. */
  async function ownedFiles(world: DataStoreInstance) {
    const asset = required(
      await world.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: KNOWLEDGE_BASE_ASSET_KIND,
        name: KB
      })
    );
    const listed = await world.api.call("knowledge_bases.list_documents", {
      params: { knowledgeBase: KB }
    });
    expect(listed.statusCode, listed.body).toBe(200);
    return {
      owner: asset.id,
      documents: z.object({ documents: z.array(z.unknown()) }).parse(listed.json()).documents
    };
  }

  it("keeps an uploaded text file as a document whose copy the Knowledge Base owns, and records no file name", async () => {
    const instance = await instanceWithKnowledgeBase();

    const answer = await upload(instance, {
      filename: FILE_NAME,
      contentType: "text/plain",
      content: FILE_TEXT
    });
    expect(answer.statusCode, answer.body).toBe(200);
    const { documents, count, bytes } = addedSchema.parse(answer.json());
    expect({ count, bytes }).toEqual({ count: 1, bytes: Buffer.byteLength(FILE_TEXT) });

    const { owner, documents: listed } = await ownedFiles(instance);
    expect(listed).toEqual([
      expect.objectContaining({
        fileName: FILE_NAME,
        title: "Urlaub Erika Mustermann",
        format: "txt"
      })
    ]);
    expect(
      await instance.stores.files.getManagedFile({
        clientInstanceId,
        fileId: asManagedFileId(required(documents[0]).fileId)
      })
    ).toMatchObject({
      owner: { kind: "knowledge_base", id: owner },
      status: "available",
      checksum: createHash("sha256").update(FILE_TEXT).digest("hex")
    });

    // It ran as the Knowledge Base's add_files. Neither its run nor its event names the file.
    const run = required(
      (await instance.stores.operationRuns.list({ clientInstanceId })).find(
        (candidate) => candidate.operation === `knowledge.${KB}.add_files`
      )
    );
    const [event] = await instance.stores.audit.listAuditEvents({
      clientInstanceId,
      type: "knowledge_base.files_added",
      limit: 10
    });
    expect(event).toMatchObject({ status: "success", subject: owner, metadata: { count: 1 } });
    for (const kept of [JSON.stringify(event), JSON.stringify(run)]) {
      expect(kept).not.toContain("Mustermann");
      expect(kept).not.toContain("Urlaubstage");
    }
  });

  it("refuses an upload in no format, in a format the instance does not read, or too large, and keeps no copy", async () => {
    const instance = await instanceWithKnowledgeBase();

    const csv = await upload(instance, {
      filename: "a.csv",
      contentType: "text/csv",
      content: "a,b"
    });
    expect(csv.statusCode, csv.body).toBe(422);
    expect(reasonOf(csv)).toBe("knowledge_file_format_unsupported");

    // Without document processing a PDF waits for nothing that could read it.
    const pdf = await upload(instance, {
      filename: "expose.pdf",
      contentType: "application/pdf",
      content: "%PDF-1.7"
    });
    expect(pdf.statusCode, pdf.body).toBe(422);
    expect(reasonOf(pdf)).toBe("knowledge_file_format_unavailable");

    // The route cuts a larger file after one byte more; the operation refuses it as too large.
    const large = await upload(instance, {
      filename: "gross.txt",
      contentType: "text/plain",
      content: Buffer.alloc(KNOWLEDGE_FILE_MAX_BYTES + 10, 0x61)
    });
    expect(large.statusCode, large.body).toBe(422);
    expect(reasonOf(large)).toBe("knowledge_file_too_large");

    expect((await ownedFiles(instance)).documents).toEqual([]);
  });

  it("refuses a caller without `knowledge_base.write`", async () => {
    const instance = await instanceWithKnowledgeBase();
    const refused = await upload(
      instance,
      { filename: "notes.txt", contentType: "text/plain", content: "member notes" },
      asMember
    );
    expect(refused.statusCode, refused.body).toBe(403);
    expect(errorSchema.parse(refused.json()).error.details).toMatchObject({
      action: KNOWLEDGE_BASE_ACTIONS.write
    });
    expect((await ownedFiles(instance)).documents).toEqual([]);
  });

  it("answers the same upload under the same key from its run, and refuses other bytes, name or type under it", async () => {
    const instance = await instanceWithKnowledgeBase();
    const file = { filename: "urlaub.txt", contentType: "text/plain", content: FILE_TEXT };
    const key = { "idempotency-key": "upload-key-1" };

    const first = await upload(instance, file, key);
    expect(first.statusCode, first.body).toBe(200);
    // The same file under the same key, as after an answer that never arrived: one document.
    const again = await upload(instance, file, key);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.json()).toEqual(first.json());

    for (const other of [
      { ...file, content: "Urlaubstage: 30 pro Jahr." },
      { ...file, filename: "reisen.txt" },
      { ...file, filename: "urlaub.md", contentType: "text/markdown" }
    ]) {
      const reused = await upload(instance, other, key);
      expect(errorSchema.parse(reused.json()).error.code, reused.body).toBe(
        "IDEMPOTENCY_KEY_REUSED"
      );
    }
    expect((await ownedFiles(instance)).documents).toHaveLength(1);
  });

  it("refuses add_files that asks for an upload but carries no file", async () => {
    const instance = await instanceWithKnowledgeBase();
    // A call without the live file, as an agent, a Workflow step or an approved call makes it.
    const outcome = await runOperation(
      {
        operation: `knowledge.${KB}.add_files`,
        effect: "changing",
        input: { upload: { sha256: "0".repeat(64), bytes: 0, metadataSha256: "0".repeat(64) } },
        actor: await person(instance, "user-1", ["user", "admin", "superadmin"]),
        origin: { kind: "user" },
        correlationId: "corr_upload_missing"
      },
      instance.execution.operationCalls.deps
    );
    expect(outcome.result).toMatchObject({
      status: "failed",
      error: { details: { reason: "knowledge_upload_missing" } }
    });
    expect((await ownedFiles(instance)).documents).toEqual([]);
  });
});
