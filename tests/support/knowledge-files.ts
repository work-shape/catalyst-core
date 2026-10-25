import { expect } from "vitest";
import { z } from "zod";
import {
  KNOWLEDGE_BASE_ASSET_KIND,
  type DataStoreRecord,
  type JsonObject
} from "@work-shape/catalyst-core";
import { eventually, required } from "./assertions";
import {
  createManagedObjectTestAttachmentCapability,
  createMultipartFilePayload
} from "./chat-server-attachment-harness";
import {
  clientInstanceId,
  useDataStoreInstance,
  type DataStoreInstance
} from "./data-store-instance";
import { getTestJobs } from "./test-instance";

// The instance of a published keyword Knowledge Base whose Conversations keep their files,
// shared by the tests that add files to it and the tests that open its documents.

export const KB = "objektunterlagen";

export const developmentAuth = {
  enabled: true,
  users: [
    { id: "user-1", roles: ["user", "admin", "superadmin"] },
    { id: "member-1", roles: ["user"] }
  ].map((user) => ({ ...user, externalUserId: user.id, displayLabel: user.id, permissionRefs: [] }))
};
export const asMember = { "x-dev-user-id": "member-1" };

export const FILE_NAME = "Mietvertrag Erika Mustermann.txt";
export const FILE_TEXT = "Kaltmiete 1.250 EUR, Kaution drei Monatsmieten.";

export const errorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional()
  })
});
export const addedSchema = z.object({
  documents: z.array(z.object({ id: z.string(), fileId: z.string() })),
  count: z.number(),
  bytes: z.number()
});
const uploadedSchema = z.object({ attachment: z.object({ fileId: z.string() }) });

/** Registers the instance hooks of a describe block and the steps its tests share. */
export function useKnowledgeFiles(): {
  start: ReturnType<typeof useDataStoreInstance>["start"];
  instanceWithFiles(maxDocuments?: number): Promise<{
    instance: DataStoreInstance;
    attachments: ReturnType<typeof createManagedObjectTestAttachmentCapability>;
    record: DataStoreRecord;
  }>;
  published(world: DataStoreInstance): Promise<DataStoreRecord>;
  assetId(world: DataStoreInstance): Promise<string>;
  conversationWithFile(
    world: DataStoreInstance,
    file: { filename: string; contentType: string; content: string },
    headers?: Record<string, string>
  ): Promise<{ conversationId: string; fileId: string }>;
  addFiles(
    world: DataStoreInstance,
    files: readonly { conversationId: string; fileId: string }[],
    headers?: Record<string, string>
  ): ReturnType<DataStoreInstance["api"]["call"]>;
} {
  const { start } = useDataStoreInstance();

  /** An instance whose Conversations keep their files through a test capability. */
  async function instanceWithFiles(maxDocuments?: number) {
    const attachments = createManagedObjectTestAttachmentCapability();
    const instance = await start(true, undefined, developmentAuth, undefined, {
      attachments: attachments.capability,
      ...(maxDocuments === undefined ? {} : { maxDocuments })
    });
    const record = await published(instance);
    return { instance, attachments, record };
  }

  /** A keyword Knowledge Base, published, once its store has the platform's tables. */
  async function published(world: DataStoreInstance): Promise<DataStoreRecord> {
    const config: JsonObject = {
      name: KB,
      title: "Objektunterlagen",
      description: "Exposés, plans and contracts of the objects.",
      methods: ["keyword"]
    };
    const params = { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB };
    const written = await world.api.call("assets.put", {
      params,
      payload: { config, expectedRevision: null }
    });
    expect(written.statusCode, written.body).toBe(200);
    const made = await world.api.call("assets.publish", { params, payload: { revision: 1 } });
    expect(made.statusCode, made.body).toBe(200);
    const jobs = getTestJobs(world.api);
    return eventually(async () => {
      await jobs.runDue();
      const record = await world.stores.dataStores.findDataStoreByName({
        clientInstanceId,
        name: `knowledge-base:${KB}`
      });
      expect(record).toMatchObject({ status: "ready", level: 15 });
      return required(record);
    });
  }

  async function assetId(world: DataStoreInstance): Promise<string> {
    return required(
      await world.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: KNOWLEDGE_BASE_ASSET_KIND,
        name: KB
      })
    ).id;
  }

  /** A Conversation of the caller with one uploaded file. */
  async function conversationWithFile(
    world: DataStoreInstance,
    file: { filename: string; contentType: string; content: string },
    headers: Record<string, string> = {}
  ): Promise<{ conversationId: string; fileId: string }> {
    const created = await world.api.call("conversations.create", {
      payload: { title: "Unterlagen" },
      headers
    });
    expect(created.statusCode, created.body).toBe(200);
    const conversationId = z.object({ id: z.string() }).parse(created.json()).id;
    const upload = createMultipartFilePayload({ fieldName: "file", ...file });
    const uploaded = await world.api.call("conversations.draft_attachments.upload", {
      params: { conversationId },
      headers: { ...upload.headers, ...headers },
      payload: upload.payload
    });
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    return { conversationId, fileId: uploadedSchema.parse(uploaded.json()).attachment.fileId };
  }

  const addFiles = (
    world: DataStoreInstance,
    files: readonly { conversationId: string; fileId: string }[],
    headers: Record<string, string> = {}
  ) =>
    world.api.call("knowledge_bases.add_files", {
      params: { knowledgeBase: KB },
      payload: { files },
      headers
    });

  return { start, instanceWithFiles, published, assetId, conversationWithFile, addFiles };
}
