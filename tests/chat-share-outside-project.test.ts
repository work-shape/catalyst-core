import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { asConversationId, asUserId } from "@work-shape/catalyst-core";
import {
  clientInstanceId,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";
import {
  createMultipartFilePayload,
  createTestAttachmentService
} from "./support/chat-server-attachment-harness";
import { MemoryObjectStorage } from "./support/memory-object-storage";

// CHAT-SHARE-6a: "Add from project" copies a project's file into a chat only when everyone who
// reads the chat reads the project. A person named on the chat from outside the workspace does
// not read the team's project, so the copy is refused while they are named.

const instances: AccessInstance[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((t) => t.instance.close()));
});

const idSchema = z.object({ id: z.string() });

describe("CHAT-SHARE-6a: Add from project into a chat an outside reader reads", () => {
  it("refuses a team project's file while an outside reader is named, and adds it once only members read the chat", async () => {
    const objects = new MemoryObjectStorage();
    const attachments = createTestAttachmentService(clientInstanceId);
    const t = await setupAccessInstance({
      modules: { projects: { enabled: true } },
      server: (_stores, instanceConfig) => ({
        config: instanceConfig,
        pages: { objects },
        attachments
      })
    });
    instances.push(t);
    const user = (displayLabel: string) =>
      t.stores.users.createUser({ clientInstanceId, displayLabel, roles: ["user"] });
    const creator = await user("Creator");
    const member = await user("Member");
    const reader = await user("Reader");
    const team = (
      await t.stores.workspaces.createWorkspace({
        clientInstanceId,
        kind: "shared",
        name: "Team T",
        creatorUserId: creator.id
      })
    ).id;
    await t.stores.workspaces.addMembership({
      clientInstanceId,
      collaborationWorkspaceId: team,
      userId: asUserId(member.id),
      role: "member"
    });
    const project = idSchema.parse(
      (
        await t.expectOk(creator.id, "projects.create", {
          payload: { collaborationWorkspaceId: team, title: "Plans" }
        })
      ).json()
    ).id;
    const body = createMultipartFilePayload({
      fieldName: "file",
      filename: "plan.md",
      contentType: "text/markdown",
      content: "team only"
    });
    const uploaded = await t.call(creator.id, "projects.files.upload", {
      params: { projectId: project },
      headers: body.headers,
      payload: body.payload
    });
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    const chat = idSchema.parse(
      (
        await t.expectOk(creator.id, "conversations.create", {
          payload: { title: "Figures", collaborationWorkspaceId: team, visibility: "private" }
        })
      ).json()
    ).id;
    await t.stores.conversations.appendMessage({
      clientInstanceId,
      conversationId: asConversationId(chat),
      role: "user",
      text: "Hello"
    });
    const addFromProject = () =>
      t.call(creator.id, "conversations.draft_attachments.add_from_project", {
        params: { conversationId: chat },
        payload: { projectId: project, path: "plan.md" }
      });
    // The reader does not read the project.
    const direct = await t.call(reader.id, "projects.files.list", {
      params: { projectId: project }
    });
    expect(direct.statusCode).toBe(404);

    // A member named on the chat reads the project: the copy is allowed.
    await t.expectOk(creator.id, "conversations.add_person", {
      params: { conversationId: chat },
      payload: { userId: member.id }
    });
    const withMember = await addFromProject();
    expect(withMember.statusCode, withMember.body).toBe(200);

    // Named from outside the workspace: refused, with the reason.
    await t.expectOk(creator.id, "conversations.add_person", {
      params: { conversationId: chat },
      payload: { userId: reader.id }
    });
    const refused = await addFromProject();
    expect(refused.statusCode).toBe(422);
    expect(refused.body).toContain("project_audience_wider");

    // A Builder bundle of the team does not make them read the project.
    await t.grant(reader.id, "builder", { workspaceId: team });
    expect((await addFromProject()).statusCode).toBe(422);

    // Once they are no longer named, only members read the chat again.
    await t.expectOk(creator.id, "conversations.remove_person", {
      params: { conversationId: chat, userId: reader.id }
    });
    const afterRemoval = await addFromProject();
    expect(afterRemoval.statusCode, afterRemoval.body).toBe(200);
  });
});
