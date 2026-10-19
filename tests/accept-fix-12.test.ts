import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  asClientInstanceId,
  asConversationId,
  asCollaborationWorkspaceId,
  asUserId
} from "@work-shape/catalyst-core";
import { createTestInstance } from "./support/test-instance";
import { createTestConfig, seedConversationMessage } from "./support/fixtures";

const clientInstanceId = asClientInstanceId("demo-local");
const developmentAuth = {
  enabled: true,
  users: [
    {
      id: "mara",
      externalUserId: "mara",
      displayLabel: "Mara Lindqvist",
      roles: ["user", "admin", "superadmin"]
    },
    { id: "kai", externalUserId: "kai", displayLabel: "Kai", roles: ["user"] }
  ]
};

describe("ACCEPT-FIX-12 recovery and workspace contact", () => {
  it("ships German guardrail names and reasons in the German demo (C-3)", async () => {
    const config = parse(
      await readFile(new URL("../clients/demo/config/app.yaml", import.meta.url), "utf8")
    );
    expect(config.guardrails).toMatchObject({
      no_personal_data: { displayName: "Keine persönlichen Daten in Skills" },
      no_iban_in_assets: {
        displayName: "Keine IBAN in Inhalten",
        check: {
          reason:
            "Inhalte dürfen keine Kontonummern enthalten. Entferne die IBAN und speichere noch einmal."
        }
      },
      no_iban_in_apps: {
        displayName: "Keine IBAN in veröffentlichten Apps",
        check: {
          reason:
            "Apps dürfen keine Kontonummern enthalten. Entferne die IBAN und veröffentliche noch einmal."
        }
      }
    });
  });
  it("names active workspace administrators to a nonmember without giving workspace content (C-4)", async () => {
    const app = await createTestInstance({
      config: createTestConfig({ developmentAuth }),
      capabilities: [],
      tools: []
    });
    try {
      const created = await app.call(
        "workspaces.create",
        { payload: { name: "Nordlicht" } },
        "mara"
      );
      expect(created.statusCode, created.body).toBe(200);
      const workspaceId: string = created.json().id;
      for (const [label, role] of [
        ["Plain member", "member"],
        ["Inactive admin", "admin"]
      ] as const) {
        const user = await app.stores.users.createUser({ clientInstanceId, displayLabel: label });
        await app.stores.workspaces.addMembership({
          clientInstanceId,
          collaborationWorkspaceId: asCollaborationWorkspaceId(workspaceId),
          userId: user.id,
          role
        });
        if (role === "admin")
          await app.stores.users.updateUser({
            clientInstanceId,
            userId: user.id,
            status: "disabled"
          });
      }
      const refused = await app.call(
        "workspaces.get",
        { params: { collaborationWorkspaceId: workspaceId } },
        "kai"
      );
      expect(refused.statusCode).toBe(404);
      expect(refused.json()).toMatchObject({
        error: { code: "NOT_FOUND", details: { administrators: ["Mara Lindqvist"] } }
      });
      expect(refused.body).not.toContain("Nordlicht");
      const own = await app.call("workspaces.ensure_personal", {}, "mara");
      const personal = await app.call(
        "workspaces.get",
        { params: { collaborationWorkspaceId: own.json().id } },
        "kai"
      );
      expect(personal.json().error.details.administrators).toEqual([]);
      const hidden = await app.call(
        "workspaces.create",
        { payload: { name: "Vertraulich", visibility: "private" } },
        "mara"
      );
      expect(hidden.statusCode, hidden.body).toBe(200);
      const privateLink = await app.call(
        "workspaces.get",
        { params: { collaborationWorkspaceId: hidden.json().id } },
        "kai"
      );
      expect(privateLink.statusCode).toBe(404);
      expect(privateLink.json().error.details.administrators).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("discards a rejected send's own empty draft without leaving a conversation row, but refuses populated drafts", async () => {
    const app = await createTestInstance({
      config: createTestConfig({ developmentAuth }),
      capabilities: [],
      tools: []
    });
    try {
      const created = await app.call(
        "conversations.create",
        { payload: { title: "kaputt.docx" } },
        "mara"
      );
      expect(created.statusCode).toBe(200);
      const conversationId: string = created.json().id;
      const discarded = await app.call(
        "conversations.delete",
        { params: { conversationId }, query: { discardEmpty: "true" } },
        "mara"
      );
      expect(discarded.statusCode, discarded.body).toBe(200);
      expect(
        await app.stores.conversations.getConversation(
          clientInstanceId,
          asConversationId(conversationId)
        )
      ).toBeUndefined();
      const kept = await app.call(
        "conversations.create",
        { payload: { title: "Keep the message" } },
        "mara"
      );
      const keptId: string = kept.json().id;
      await seedConversationMessage(app.stores.conversations, keptId);
      const refused = await app.call(
        "conversations.delete",
        { params: { conversationId: keptId }, query: { discardEmpty: "true" } },
        "mara"
      );
      expect(refused.statusCode).toBe(409);
      expect(
        (await app.stores.conversations.getConversation(clientInstanceId, asConversationId(keptId)))
          ?.status
      ).toBe("active");
    } finally {
      await app.close();
    }
  });
  it("keeps another member's empty draft and every draft that holds file or artifact metadata", async () => {
    const app = await createTestInstance({
      config: createTestConfig({ developmentAuth }),
      capabilities: [],
      tools: []
    });
    try {
      const mara = (await app.call("me.get", {}, "mara")).json<{ id: string }>();
      const kai = (await app.call("me.get", {}, "kai")).json<{ id: string }>();
      const workspace = (
        await app.call("workspaces.create", { payload: { name: "Discard test" } }, "mara")
      ).json<{ id: string }>();
      await app.stores.workspaces.addMembership({
        clientInstanceId,
        collaborationWorkspaceId: asCollaborationWorkspaceId(workspace.id),
        userId: asUserId(kai.id),
        role: "member"
      });
      const shared = (
        await app.call(
          "conversations.create",
          {
            payload: { title: "Mara's empty shared draft", collaborationWorkspaceId: workspace.id }
          },
          "mara"
        )
      ).json<{ id: string }>();
      const other = await app.call(
        "conversations.delete",
        { params: { conversationId: shared.id }, query: { discardEmpty: "true" } },
        "kai"
      );
      expect(other.statusCode, other.body).toBe(409);
      expect(
        await app.stores.conversations.getConversation(
          clientInstanceId,
          asConversationId(shared.id)
        )
      ).toMatchObject({ status: "active" });
      for (const kind of ["attachment", "artifact"] as const) {
        const draft = (
          await app.call("conversations.create", { payload: { title: `Keep ${kind}` } }, "mara")
        ).json<{ id: string }>();
        const conversationId = asConversationId(draft.id);
        if (kind === "attachment") {
          const file = await app.stores.files.createManagedFile({
            clientInstanceId,
            ownerUserId: mara.id,
            filename: "keep.txt",
            byteSize: 4,
            checksum: "keep",
            objectKey: "discard-test/keep.txt"
          });
          await app.stores.files.createConversationAttachment({
            clientInstanceId,
            conversationId,
            fileId: file.id,
            filename: "keep.txt",
            byteSize: 4,
            checksum: "keep",
            status: "ready",
            format: "txt",
            processingMetadata: {},
            warnings: []
          });
        } else {
          await app.stores.files.createManagedArtifact({
            clientInstanceId,
            conversationId,
            kind: "text/csv",
            objectKey: "discard-test/keep.csv",
            filename: "keep.csv",
            mimeType: "text/csv",
            byteSize: 4,
            checksum: "keep",
            metadata: {}
          });
        }
        const refused = await app.call(
          "conversations.delete",
          { params: { conversationId }, query: { discardEmpty: "true" } },
          "mara"
        );
        expect(refused.statusCode, refused.body).toBe(409);
        expect(
          await app.stores.conversations.getConversation(clientInstanceId, conversationId)
        ).toMatchObject({ status: "active" });
      }
    } finally {
      await app.close();
    }
  });
});
