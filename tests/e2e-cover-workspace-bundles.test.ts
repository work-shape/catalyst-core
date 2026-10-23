import { describe, expect, it } from "vitest";
import { z } from "zod";
import { asConversationId } from "@work-shape/catalyst-core";
import { clientInstanceId } from "./support/access-instance";
import { appFiles, expectStatus, previewSchema, setupAppInstance } from "./support/app-instance";

// Browser conversion: workspace-bundles' outside Builder opens the workspace's App draft,
// without acquiring membership or access to its members' conversations.
describe("an App draft for a Builder outside its workspace", () => {
  it("opens the workspace's draft without membership and reveals no member's conversation or other workspace's draft", async () => {
    const t = await setupAppInstance({ commits: false });
    try {
      const other = await t.sharedWorkspace("Another team");
      for (const [name, workspaceId] of [
        ["outside-draft", t.workspaceId],
        ["other-draft", other]
      ] as const) {
        expectStatus(
          await t.call(t.admin.id, "assets.put", {
            params: { kind: "app", name },
            payload: { workspaceId, files: appFiles(name, { id: name }) }
          }),
          200
        );
      }
      const conversation = z.object({ id: z.string() }).parse(
        (
          await t.expectOk(t.kai.id, "conversations.create", {
            payload: { title: "Members only", collaborationWorkspaceId: t.workspaceId }
          })
        ).json()
      );
      await t.stores.conversations.appendMessage({
        clientInstanceId,
        conversationId: asConversationId(conversation.id),
        role: "user",
        text: "Private team message"
      });

      await t.grant(t.lena.id, "builder", { workspaceId: t.workspaceId });
      expect(
        await t.stores.workspaces.getMembership({
          clientInstanceId,
          collaborationWorkspaceId: t.workspaceId,
          userId: t.lena.id
        })
      ).toBeUndefined();

      const draft = await t.expectOk(t.lena.id, "assets.get", {
        params: { kind: "app", name: "outside-draft" },
        query: { workspaceId: t.workspaceId }
      });
      expect(draft.json()).toMatchObject({ name: "outside-draft", draftRevision: 1 });
      const preview = previewSchema.parse(
        (
          await t.expectOk(t.lena.id, "apps.preview", {
            params: { app: "outside-draft" },
            payload: { mode: "draft" }
          })
        ).json()
      );
      expect(preview).toMatchObject({
        interfacePath: `/w/${t.workspaceId}/app-drafts/outside-draft`
      });
      const document = await t.open(preview.url);
      expect(document.status).toBe(200);
      expect(document.body).toContain("outside-draft");

      const listed = await t.expectOk(t.lena.id, "conversations.list", {
        query: { collaborationWorkspaceId: t.workspaceId }
      });
      expect(z.object({ items: z.array(z.unknown()) }).parse(listed.json()).items).toEqual([]);
      expectStatus(
        await t.call(t.lena.id, "workspaces.get", {
          params: { collaborationWorkspaceId: t.workspaceId }
        }),
        404
      );
      expectStatus(
        await t.call(t.lena.id, "conversations.messages.list", {
          params: { conversationId: conversation.id }
        }),
        404
      );
      expectStatus(
        await t.call(t.lena.id, "apps.preview", {
          params: { app: "other-draft" },
          payload: { mode: "draft" }
        }),
        403
      );
    } finally {
      await t.close();
    }
  });
});
