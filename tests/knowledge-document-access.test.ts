import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  KNOWLEDGE_BASE_ACTIONS,
  KNOWLEDGE_BASE_ASSET_KIND,
  asConversationId,
  asUserId
} from "@work-shape/catalyst-core";
import { eventually, required } from "./support/assertions";
import { clientInstanceId } from "./support/data-store-instance";
import {
  FILE_NAME,
  FILE_TEXT,
  KB,
  addedSchema,
  asMember,
  useKnowledgeFiles
} from "./support/knowledge-files";
import { getTestJobs } from "./support/test-instance";

// `knowledge_bases.open_document`: who may open a cited original. A reader with a right of
// their own opens it anywhere; a member opens it only through a conversation they can open in
// a workspace the Knowledge Base is available to. Spec: data-stores-and-knowledge-bases.md, E6.

describe("opening a cited Knowledge Base document", () => {
  const { instanceWithFiles, assetId, conversationWithFile, addFiles } = useKnowledgeFiles();

  it("E6 opens a cited original only for a Knowledge Base user and refuses removed or mismatched documents", async () => {
    const { instance } = await instanceWithFiles();
    const source = await conversationWithFile(instance, {
      filename: FILE_NAME,
      contentType: "text/plain",
      content: FILE_TEXT
    });
    const added = await addFiles(instance, [source]);
    const documentId = required(addedSchema.parse(added.json()).documents[0]).id;
    await eventually(async () => {
      await getTestJobs(instance.api).runDue();
      const opened = await instance.api.call("knowledge_bases.open_document", {
        params: { knowledgeBase: KB, documentId }
      });
      expect(opened.statusCode, opened.body).toBe(200);
      expect(opened.body).toBe(FILE_TEXT);
      expect(opened.headers["content-disposition"]).toMatch(/^inline;/);
      expect(opened.headers["x-content-type-options"]).toBe("nosniff");
      expect(opened.headers["content-type"]).toBe("text/plain; charset=utf-8");
      expect(opened.headers["cache-control"]).toBe("private, no-store");
    });
    const denied = await instance.api.call("knowledge_bases.open_document", {
      params: { knowledgeBase: KB, documentId },
      headers: asMember
    });
    expect(denied.statusCode).toBe(403);
    const memberRead = await instance.api.call("conversations.create", {
      payload: { title: "Source reader" },
      headers: asMember
    });
    expect(memberRead.statusCode).toBe(200);
    const memberConversationId = z.object({ id: z.string() }).parse(memberRead.json()).id;
    const memberConversation = required(
      await instance.stores.conversations.getConversation(
        clientInstanceId,
        asConversationId(memberConversationId)
      )
    );
    const granted = await instance.api.call("permissions.grant", {
      payload: {
        holderKind: "user",
        holderId: memberConversation.createdByUserId,
        action: KNOWLEDGE_BASE_ACTIONS.use,
        scopeKind: "asset",
        scopeId: await assetId(instance)
      }
    });
    expect(granted.statusCode, granted.body).toBe(200);
    const permitted = await instance.api.call("knowledge_bases.open_document", {
      params: { knowledgeBase: KB, documentId },
      headers: asMember
    });
    expect(permitted.statusCode, permitted.body).toBe(200);
    expect(permitted.body).toBe(FILE_TEXT);
    // A direct grant needs no conversation, and its revocation ends it.
    const grantId = z.object({ id: z.string() }).parse(granted.json()).id;
    const revoked = await instance.api.call("permissions.revoke", { params: { grantId } });
    expect(revoked.statusCode, revoked.body).toBe(200);
    const afterRevoke = await instance.api.call("knowledge_bases.open_document", {
      params: { knowledgeBase: KB, documentId },
      headers: asMember
    });
    expect(afterRevoke.statusCode).toBe(403);
    const wrong = await instance.api.call("knowledge_bases.open_document", {
      params: { knowledgeBase: "another-base", documentId }
    });
    expect(wrong.statusCode).toBe(404);
    const removed = await instance.api.call("knowledge_bases.remove_documents", {
      params: { knowledgeBase: KB },
      payload: { documentIds: [documentId] }
    });
    expect(removed.statusCode, removed.body).toBe(200);
    const gone = await instance.api.call("knowledge_bases.open_document", {
      params: { knowledgeBase: KB, documentId }
    });
    expect(gone.statusCode).toBe(404);
  });

  it("E6 opens a cited original for a member through the citing conversation's workspace availability only", async () => {
    const { instance } = await instanceWithFiles();
    const source = await conversationWithFile(instance, {
      filename: FILE_NAME,
      contentType: "text/plain",
      content: FILE_TEXT
    });
    const added = await addFiles(instance, [source]);
    const documentId = required(addedSchema.parse(added.json()).documents[0]).id;
    await eventually(async () => {
      await getTestJobs(instance.api).runDue();
      const opened = await instance.api.call("knowledge_bases.open_document", {
        params: { knowledgeBase: KB, documentId }
      });
      expect(opened.statusCode, opened.body).toBe(200);
    });
    const idOf = (headers: Record<string, string>) =>
      instance.api
        .call("me.get", { headers })
        .then((me) => z.object({ id: z.string() }).parse(me.json()).id);
    const memberId = await idOf(asMember);
    const adminId = await idOf({});
    const workspace = async (name: string, member: boolean) => {
      const made = await instance.stores.workspaces.createWorkspace({
        clientInstanceId,
        name,
        kind: "shared",
        creatorUserId: asUserId(adminId)
      });
      if (member) {
        await instance.stores.workspaces.addMembership({
          clientInstanceId,
          collaborationWorkspaceId: made.id,
          userId: asUserId(memberId),
          role: "member"
        });
      }
      return made.id;
    };
    const nordlicht = await workspace("Nordlicht", true);
    const other = await workspace("Other team", true);
    const foreign = await workspace("Foreign team", false);
    const conversationIn = async (workspaceId: string, headers: Record<string, string>) => {
      const created = await instance.api.call("conversations.create", {
        payload: { title: "Citations", collaborationWorkspaceId: workspaceId },
        headers
      });
      expect(created.statusCode, created.body).toBe(200);
      return z.object({ id: z.string() }).parse(created.json()).id;
    };
    const available = await instance.api.call("assets.set_availability", {
      params: { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB },
      payload: { mode: "selected", collaborationWorkspaceIds: [nordlicht] }
    });
    expect(available.statusCode, available.body).toBe(200);
    const open = (conversationId?: string) =>
      instance.api
        .call("knowledge_bases.open_document", {
          params: { knowledgeBase: KB, documentId },
          ...(conversationId === undefined ? {} : { query: { conversationId } }),
          headers: asMember
        })
        .then((answer) => answer.statusCode);
    const cited = await conversationIn(nordlicht, asMember);
    // Availability alone grants nothing outside the citing conversation's workspace.
    expect(await open()).toBe(403);
    expect(await open(cited)).toBe(200);
    expect(await open(await conversationIn(other, asMember))).toBe(403);
    // A workspace conversation of another person lends its workspace; once private, a foreign
    // workspace's conversation and one that does not exist lend nothing.
    expect(await open(await conversationIn(nordlicht, {}))).toBe(200);
    const shared = await conversationIn(other, {});
    const hidden = await instance.api.call("conversations.move", {
      params: { conversationId: shared },
      payload: { collaborationWorkspaceId: nordlicht, visibility: "private" }
    });
    expect(hidden.statusCode, hidden.body).toBe(200);
    expect(await open(shared)).toBe(404);
    expect(await open(await conversationIn(foreign, {}))).toBe(404);
    expect(await open("conv_missing")).toBe(404);
    const denied = await instance.api.call("permissions.grant", {
      payload: {
        holderKind: "user",
        holderId: memberId,
        action: KNOWLEDGE_BASE_ACTIONS.use,
        scopeKind: "asset",
        scopeId: await assetId(instance),
        effect: "deny"
      }
    });
    expect(denied.statusCode, denied.body).toBe(200);
    expect(await open(cited)).toBe(403);
    const deniedId = z.object({ id: z.string() }).parse(denied.json()).id;
    const lifted = await instance.api.call("permissions.revoke", { params: { grantId: deniedId } });
    expect(lifted.statusCode, lifted.body).toBe(200);
    expect(await open(cited)).toBe(200);
    const withdrawn = await instance.api.call("assets.set_availability", {
      params: { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB },
      payload: { mode: "selected", collaborationWorkspaceIds: [other] }
    });
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
    expect(await open(cited)).toBe(403);
  });
});
