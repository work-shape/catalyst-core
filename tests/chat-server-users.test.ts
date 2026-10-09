import { required } from "./support/assertions";
import { createTestInstance, getTestConfig } from "./support/test-instance";
import { describe, expect, it } from "vitest";

import { STANDALONE_AUTH_SOURCE } from "@vivd-catalyst/auth";
import {
  AppError,
  PERMISSIONS,
  StoreBackedAuditRecorder,
  asClientInstanceId,
  asManagedFileId,
  asUserId
} from "@vivd-catalyst/core";

import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import {
  createTestConfig,
  personalConversationListInput,
  seedConversationMessage
} from "./support/fixtures";
import {
  createManagedObjectTestAttachmentCapability,
  createMultipartFilePayload
} from "./support/chat-server-attachment-harness";
import { createMissingRuntime, createUnusedModelProvider } from "./support/chat-server-run-harness";

describe("client instance app vertical slice", () => {
  it("switches between configured development users without exposing a dev-user listing route", async () => {
    const app = await createTestInstance({
      config: createTestConfig({
        developmentAuth: {
          enabled: true,
          defaultUserId: "superadmin-1",
          users: [
            {
              id: "superadmin-1",
              externalUserId: "superadmin-1",
              displayLabel: "Superadmin",
              roles: ["user", "admin", "superadmin"],
              permissionRefs: ["demo-tools"]
            },
            {
              id: "user-1",
              externalUserId: "user-1",
              displayLabel: "Normal User",
              roles: ["user"],
              permissionRefs: ["demo-tools"]
            },
            {
              id: "usage-viewer-1",
              externalUserId: "usage-viewer-1",
              displayLabel: "Usage Viewer",
              roles: ["user"],
              permissionRefs: ["demo-tools"],
              permissions: ["usage.view"]
            }
          ]
        }
      }),
      env: {},
      tools: []
    });

    const developmentUsersRoute = await app.call("legacyDevelopmentUsers");
    expect(developmentUsersRoute.statusCode).toBe(404);

    const defaultMe = await app.call("getCurrentUser", {});
    expect(defaultMe.statusCode).toBe(200);
    const defaultMeBody = defaultMe.json() as {
      displayLabel: string;
      externalUserId: string;
      roles: string[];
      permissions: string[];
    };
    expect(defaultMeBody).toMatchObject({
      displayLabel: "Superadmin",
      externalUserId: "superadmin-1",
      roles: ["user", "admin", "superadmin"]
    });
    expect([...defaultMeBody.permissions].sort()).toEqual(
      PERMISSIONS.filter((permission) => permission !== "config_assets.release").sort()
    );

    const normalMe = await app.call("getCurrentUser", {
      headers: {
        "x-dev-user-id": "user-1"
      }
    });
    expect(normalMe.statusCode).toBe(200);
    expect(normalMe.json()).toMatchObject({
      displayLabel: "Normal User",
      externalUserId: "user-1",
      roles: ["user"],
      permissions: []
    });

    const normalUsage = await app.call("getUsageSummary", {
      headers: {
        "x-dev-user-id": "user-1"
      }
    });
    expect(normalUsage.statusCode).toBe(403);

    const grantedUsage = await app.call("getUsageSummary", {
      headers: {
        "x-dev-user-id": "usage-viewer-1"
      }
    });
    expect(grantedUsage.statusCode).toBe(200);

    const unknownUser = await app.call("getCurrentUser", {
      headers: {
        "x-dev-user-id": "missing-user"
      }
    });
    expect(unknownUser.statusCode).toBe(401);

    await app.close();
  });

  it("lets a user update their own profile without changing authorization fields", async () => {
    const app = await createTestInstance({
      config: createTestConfig({
        developmentAuth: {
          enabled: true,
          defaultUserId: "superadmin-1",
          users: [
            {
              id: "superadmin-1",
              externalUserId: "superadmin-1",
              displayLabel: "Superadmin",
              roles: ["user", "admin", "superadmin"],
              permissionRefs: ["demo-tools"]
            },
            {
              id: "user-1",
              externalUserId: "user-1",
              displayLabel: "Normal User",
              roles: ["user"],
              permissionRefs: ["demo-tools"]
            }
          ]
        }
      }),
      env: {},
      tools: []
    });

    const updated = await app.call("updateCurrentUser", {
      headers: {
        "x-dev-user-id": "user-1"
      },
      payload: {
        displayLabel: "Updated User",
        email: "escalation@example.test",
        roles: ["superadmin"]
      }
    });
    expect(updated.statusCode).toBe(200);
    const updatedBody = updated.json() as { displayLabel: string; email?: string; roles: string[] };
    expect(updatedBody).toMatchObject({
      displayLabel: "Updated User",
      roles: ["user"]
    });
    expect(updatedBody.email).not.toBe("escalation@example.test");

    const audit = await app.call("listAuditEvents", {
      headers: {
        "x-dev-user-id": "superadmin-1"
      }
    });
    expect(audit.statusCode).toBe(200);
    expect((audit.json() as Array<{ type: string }>).map((event) => event.type)).toEqual(
      expect.arrayContaining(["user.profile_updated"])
    );

    await app.close();
  });

  it("rejects self-service password changes outside standalone auth", async () => {
    const app = await createTestInstance({
      config: createTestConfig(),
      env: {},
      tools: []
    });

    const changed = await app.call("changeCurrentUserPassword", {
      payload: {
        currentPassword: "old-password",
        newPassword: "new-password"
      }
    });
    expect(changed.statusCode).toBe(422);
    expect((changed.json() as { error: { message: string } }).error.message).toContain(
      "standalone auth"
    );

    await app.close();
  });

  it("retries account deletion after final user deletion fails", async () => {
    const clientInstanceId = asClientInstanceId("demo-local");
    const store = createTestInstance().stores;
    const config = createTestConfig();
    const usageGovernance = new ModelUsageGovernance({
      store,
      budget: config.usage.budget,
      safeguards: config.usage.safeguards,
      costs: config.usage.costs
    });
    const user = await store.resolveUserIdentity({
      permissions: [],
      clientInstanceId,
      authSource: STANDALONE_AUTH_SOURCE,
      externalUserId: "auth-delete-me",
      displayLabel: "Delete Me",
      email: "delete-me@example.test",
      emailVerified: true,
      roles: ["user"],
      permissionRefs: ["demo-tools"],
      correlationId: "corr_delete_me"
    });
    const otherUser = await store.resolveUserIdentity({
      permissions: [],
      clientInstanceId,
      authSource: "development",
      externalUserId: "other-user",
      displayLabel: "Other User",
      roles: ["user"],
      permissionRefs: ["demo-tools"],
      correlationId: "corr_other"
    });
    const [personalWorkspace] = await store.listWorkspacesForUser({
      clientInstanceId,
      userId: asUserId(user.id)
    });
    const [otherPersonalWorkspace] = await store.listWorkspacesForUser({
      clientInstanceId,
      userId: asUserId(otherUser.id)
    });
    expect(personalWorkspace).toMatchObject({ kind: "personal", role: "owner" });
    expect(otherPersonalWorkspace).toMatchObject({ kind: "personal", role: "owner" });
    const conversation = await store.createConversation({
      visibility: "workspace",
      clientInstanceId,
      collaborationWorkspaceId: personalWorkspace!.id,
      createdByUserId: user.id,
      createdByExternalUserId: user.externalUserId,
      title: "Delete this conversation",
      retainedUntil: "2030-01-01T00:00:00.000Z"
    });
    await store.appendMessage({
      clientInstanceId,
      conversationId: conversation.id,
      role: "user",
      text: "remove this message"
    });
    const otherConversation = await store.createConversation({
      visibility: "workspace",
      clientInstanceId,
      collaborationWorkspaceId: otherPersonalWorkspace!.id,
      createdByUserId: otherUser.id,
      createdByExternalUserId: otherUser.externalUserId,
      title: "Keep this conversation",
      retainedUntil: "2030-01-01T00:00:00.000Z"
    });
    const deleteUser = store.deleteUser.bind(store);
    let deleteUserAttempts = 0;
    store.deleteUser = async (input) => {
      deleteUserAttempts += 1;
      if (deleteUserAttempts === 1) {
        throw new AppError("INTERNAL", "Injected final user deletion failure");
      }
      return deleteUser(input);
    };
    const deletedPasswordSignIns: Array<{ externalUserId: string }> = [];
    const server = await createTestInstance({
      server: {
        config,
        clientInstanceId,
        authAdapter: {
          credentialMode: "ambient",
          id: "test-auth",
          async authenticate(request) {
            if (request.headers["x-service-principal"]) {
              return {
                ...user,
                scopes: ["*"],
                principal: {
                  kind: "service",
                  id: "svc-customer-api",
                  displayLabel: "Customer API",
                  clientInstanceId,
                  authSource: "customer-api"
                },
                delegatedActor: {
                  kind: "service_principal",
                  id: "svc-customer-api",
                  authSource: "customer-api"
                }
              };
            }
            return { ...user, scopes: ["*"] };
          }
        },
        conversationStore: store,
        auditEventStore: store,
        userStore: store,
        usageGovernance,
        auditRecorder: new StoreBackedAuditRecorder({ clientInstanceId, store }),
        agentRuntime: createMissingRuntime(),
        modelProvider: createUnusedModelProvider(),
        standaloneAuth: {
          async findPasswordSignIn() {
            return undefined;
          },
          async createPasswordSetupToken() {
            throw new Error("Password setup is unused in this fixture");
          },
          async completePasswordSetup() {
            throw new Error("Password setup is unused in this fixture");
          },
          baseUrl: "http://127.0.0.1:4100/api/auth",
          async handleRequest() {
            return new Response(null, { status: 404 });
          },
          async setPassword() {},
          async setOrCreatePasswordSignIn() {
            throw new AppError("INTERNAL", "Password sign-in should not be created");
          },
          async changePassword() {},
          async deletePasswordSignIn(input) {
            deletedPasswordSignIns.push(input);
          }
        }
      }
    });

    const delegatedDelete = await server.call("deleteCurrentUser", {
      headers: {
        "x-service-principal": "1"
      }
    });
    expect(delegatedDelete.statusCode).toBe(403);

    const failed = await server.call("deleteCurrentUser", {});
    expect(failed.statusCode).toBe(500);
    await expect(
      store.listWorkspacesForUser({ clientInstanceId, userId: asUserId(user.id) })
    ).resolves.toEqual([]);
    await expect(store.listUsers({ clientInstanceId })).resolves.toContainEqual(
      expect.objectContaining({ id: user.id })
    );

    const deleted = await server.call("deleteCurrentUser", {});
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ ok: true });
    expect(deleteUserAttempts).toBe(2);
    expect(deletedPasswordSignIns).toEqual([
      { externalUserId: "auth-delete-me" },
      { externalUserId: "auth-delete-me" }
    ]);

    await expect(store.listUsers({ clientInstanceId })).resolves.not.toContainEqual(
      expect.objectContaining({ id: user.id })
    );
    await expect(store.getConversation(clientInstanceId, conversation.id)).resolves.toBeUndefined();
    await expect(
      store.getConversation(clientInstanceId, otherConversation.id)
    ).resolves.toMatchObject({
      status: "active"
    });
    await expect(
      store.listMessages({
        clientInstanceId,
        conversationId: conversation.id
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND"
    });

    const audit = await store.listAuditEvents({ clientInstanceId });
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "conversation.deleted",
          metadata: expect.objectContaining({
            requestedBy: "account_deletion"
          })
        }),
        expect.objectContaining({
          type: "user.deleted",
          metadata: expect.objectContaining({
            requestedBy: "self",
            conversationCount: 0
          })
        })
      ])
    );

    await server.close();
  });

  it("uses the workspace-aware cleanup lifecycle for superadmin user deletion", async () => {
    const clientInstanceId = asClientInstanceId("demo-local");
    const app = await createTestInstance({
      config: createTestConfig({
        developmentAuth: {
          enabled: true,
          defaultUserId: "superadmin-1",
          users: [
            {
              id: "superadmin-1",
              externalUserId: "superadmin-1",
              displayLabel: "Superadmin",
              roles: ["user", "admin", "superadmin"],
              permissionRefs: ["demo-tools"]
            }
          ]
        }
      }),
      env: {},
      tools: []
    });
    await app.call("getCurrentUser", {});
    const [superadmin] = await app.stores.listUsers({ clientInstanceId });
    const created = await app.call("createAdministeredUser", {
      payload: { displayLabel: "Delete by admin", roles: ["user"] }
    });
    expect(created.statusCode).toBe(200);
    const deletedUserId = asUserId((created.json() as { id: string }).id);
    const [personal] = await app.stores.listWorkspacesForUser({
      clientInstanceId,
      userId: deletedUserId
    });
    expect(personal).toMatchObject({ kind: "personal", role: "owner" });
    const personalConversation = await app.stores.createConversation({
      visibility: "workspace",
      clientInstanceId,
      collaborationWorkspaceId: personal!.id,
      createdByUserId: deletedUserId,
      createdByExternalUserId: deletedUserId,
      title: "Delete private data",
      retainedUntil: "2030-01-01T00:00:00.000Z"
    });
    const shared = await app.stores.createWorkspace({
      clientInstanceId,
      kind: "shared",
      name: "Preserved shared data",
      creatorUserId: superadmin!.id
    });
    await app.stores.addMembership({
      clientInstanceId,
      collaborationWorkspaceId: shared.id,
      userId: deletedUserId,
      role: "member"
    });
    const sharedConversation = await app.stores.createConversation({
      visibility: "workspace",
      clientInstanceId,
      collaborationWorkspaceId: shared.id,
      createdByUserId: deletedUserId,
      createdByExternalUserId: deletedUserId,
      title: "Preserve shared data",
      retainedUntil: "2030-01-01T00:00:00.000Z"
    });
    const privateInShared = await app.stores.createConversation({
      visibility: "private",
      clientInstanceId,
      collaborationWorkspaceId: shared.id,
      createdByUserId: deletedUserId,
      createdByExternalUserId: deletedUserId,
      title: "Delete private data in a shared workspace",
      retainedUntil: "2030-01-01T00:00:00.000Z"
    });
    const otherUsersPrivate = await app.stores.createConversation({
      visibility: "private",
      clientInstanceId,
      collaborationWorkspaceId: shared.id,
      createdByUserId: superadmin!.id,
      createdByExternalUserId: superadmin!.id,
      title: "Preserve another user's private data",
      retainedUntil: "2030-01-01T00:00:00.000Z"
    });
    const formerWorkspace = await app.stores.createWorkspace({
      clientInstanceId,
      kind: "shared",
      name: "Left before deletion",
      creatorUserId: superadmin!.id
    });
    const privateInFormerWorkspace = await app.stores.createConversation({
      visibility: "private",
      clientInstanceId,
      collaborationWorkspaceId: formerWorkspace.id,
      createdByUserId: deletedUserId,
      createdByExternalUserId: deletedUserId,
      title: "Delete private data nobody else can open",
      retainedUntil: "2030-01-01T00:00:00.000Z"
    });
    const requestTarget = await app.stores.createWorkspace({
      clientInstanceId,
      kind: "shared",
      name: "Requested workspace",
      creatorUserId: superadmin!.id
    });
    await app.stores.createAccessRequest({
      clientInstanceId,
      collaborationWorkspaceId: requestTarget.id,
      userId: deletedUserId
    });

    const response = await app.call("deleteAdministeredUser", {
      params: { userId: deletedUserId }
    });
    expect(response.statusCode).toBe(200);
    await expect(
      app.stores.getConversation(clientInstanceId, personalConversation.id)
    ).resolves.toBe(undefined);
    await expect(
      app.stores.getConversation(clientInstanceId, sharedConversation.id)
    ).resolves.toMatchObject({ status: "active" });
    for (const conversation of [privateInShared, privateInFormerWorkspace]) {
      await expect(
        app.stores.getConversation(clientInstanceId, conversation.id)
      ).resolves.toMatchObject({ status: "deleted" });
    }
    await expect(
      app.stores.getConversation(clientInstanceId, otherUsersPrivate.id)
    ).resolves.toMatchObject({ status: "active", visibility: "private" });
    await expect(
      app.stores.getMembership({
        clientInstanceId,
        collaborationWorkspaceId: shared.id,
        userId: deletedUserId
      })
    ).resolves.toBeUndefined();
    await expect(
      app.stores.getAccessRequest({
        clientInstanceId,
        collaborationWorkspaceId: requestTarget.id,
        userId: deletedUserId
      })
    ).resolves.toBeUndefined();
    await expect(app.stores.getWorkspace(clientInstanceId, shared.id)).resolves.toBeDefined();
    await expect(app.stores.getWorkspace(clientInstanceId, personal!.id)).resolves.toBeUndefined();

    await app.close();
  });

  it("removes a deleted user's stored files along with their conversations", async () => {
    const clientInstanceId = asClientInstanceId("demo-local");
    const fixture = createManagedObjectTestAttachmentCapability();
    const app = await createTestInstance({
      config: createTestConfig({
        developmentAuth: {
          enabled: true,
          defaultUserId: "superadmin-1",
          users: [
            {
              id: "superadmin-1",
              externalUserId: "superadmin-1",
              displayLabel: "Superadmin",
              roles: ["user", "admin", "superadmin"],
              permissionRefs: ["demo-tools"]
            },
            {
              id: "user-1",
              externalUserId: "user-1",
              displayLabel: "Normal User",
              roles: ["user"],
              permissionRefs: ["demo-tools"]
            }
          ]
        }
      }),
      env: {},
      capabilities: [fixture.capability],
      tools: []
    });
    const asUser = { "x-dev-user-id": "user-1" };
    const me = await app.call("getCurrentUser", { headers: asUser });
    const userId = asUserId((me.json() as { id: string }).id);

    const fileIds: string[] = [];
    for (const title of ["Personal", "Second personal"]) {
      const created = await app.call("createConversation", { headers: asUser, payload: { title } });
      expect(created.statusCode).toBe(200);
      const upload = createMultipartFilePayload({
        fieldName: "file",
        filename: `${title}.txt`,
        contentType: "text/plain",
        content: `bytes of ${title}`
      });
      const uploaded = await app.call("uploadDraftAttachment", {
        params: { conversationId: (created.json() as { id: string }).id },
        headers: { ...asUser, ...upload.headers },
        payload: upload.payload
      });
      expect(uploaded.statusCode).toBe(200);
      fileIds.push((uploaded.json() as { attachment: { fileId: string } }).attachment.fileId);
    }
    const objectKeys = [...fixture.objects.keys()];
    expect(objectKeys).toHaveLength(2);

    const response = await app.call("deleteAdministeredUser", { params: { userId: userId } });
    expect(response.statusCode).toBe(200);

    expect(fixture.objects.size).toBe(0);
    expect(fixture.deletedObjectKeys).toEqual(expect.arrayContaining(objectKeys));
    for (const fileId of fileIds) {
      await expect(
        app.stores.getManagedFile({ clientInstanceId, fileId: asManagedFileId(fileId) })
      ).resolves.toBeUndefined();
    }
    const audit = await app.stores.listAuditEvents({ clientInstanceId });
    expect(audit).toContainEqual(
      expect.objectContaining({
        type: "user.deleted",
        metadata: expect.objectContaining({ conversationCount: 2, fileCount: 2 })
      })
    );

    await app.close();
  });

  it("validates only changed permission entries while preserving restricted grants and revocations", async () => {
    const app = await createTestInstance({
      config: createTestConfig({
        developmentAuth: {
          enabled: true,
          defaultUserId: "admin",
          users: [
            {
              id: "admin",
              externalUserId: "admin",
              displayLabel: "Admin",
              roles: ["admin"],
              permissionRefs: []
            }
          ]
        }
      }),
      env: {},
      tools: []
    });
    const clientInstanceId = asClientInstanceId(getTestConfig(app).clientInstance.id);
    try {
      for (const restrictedEntry of [
        "api_access.manage",
        "!api_access.manage",
        "agent_models.manage",
        "!agent_models.manage"
      ]) {
        const managedUser = await app.stores.createUser({
          clientInstanceId,
          displayLabel: "Managed user",
          roles: ["user"],
          permissions: [restrictedEntry]
        });
        const updatePermissions = (permissions: string[]) =>
          app.call("updateAdministeredUser", {
            params: { userId: managedUser.id },
            payload: { permissions }
          });
        const granted = await updatePermissions([restrictedEntry, "agent_skills.approve"]);
        expect(granted.statusCode).toBe(200);
        expect(granted.json()).toMatchObject({
          permissions: [restrictedEntry, "agent_skills.approve"]
        });
        const revoked = await updatePermissions([restrictedEntry, "!agent_skills.approve"]);
        expect(revoked.statusCode).toBe(200);
        expect(revoked.json()).toMatchObject({
          permissions: [restrictedEntry, "!agent_skills.approve"]
        });
        // Removing an existing restricted grant or denial is also a protected change.
        expect((await updatePermissions(["!agent_skills.approve"])).statusCode).toBe(403);
        const oppositeEntry = restrictedEntry.startsWith("!")
          ? restrictedEntry.slice(1)
          : `!${restrictedEntry}`;
        expect((await updatePermissions([restrictedEntry, oppositeEntry])).statusCode).toBe(403);
        expect((await updatePermissions([oppositeEntry])).statusCode).toBe(403);
        const unchanged = await updatePermissions(["!agent_skills.approve", restrictedEntry]);
        expect(unchanged.statusCode).toBe(200);
      }
      for (const permission of ["api_access.manage", "agent_models.manage"]) {
        const newGrant = await app.call("createAdministeredUser", {
          payload: { displayLabel: "New user", roles: ["user"], permissions: [permission] }
        });
        expect(newGrant.statusCode).toBe(403);
      }
    } finally {
      await app.close();
    }
  });

  it("lets admins administer non-superadmin users without escalating superadmin access", async () => {
    const app = await createTestInstance({
      config: createTestConfig({
        developmentAuth: {
          enabled: true,
          defaultUserId: "admin-1",
          users: [
            {
              id: "superadmin-1",
              externalUserId: "superadmin-1",
              displayLabel: "Superadmin",
              roles: ["user", "admin", "superadmin"],
              permissionRefs: ["demo-tools"]
            },
            {
              id: "admin-1",
              externalUserId: "admin-1",
              displayLabel: "Admin",
              roles: ["user", "admin"],
              permissionRefs: ["demo-tools"]
            }
          ]
        }
      }),
      env: {},
      tools: []
    });

    const seededSuperadmin = await app.call("getCurrentUser", {
      headers: {
        "x-dev-user-id": "superadmin-1"
      }
    });
    expect(seededSuperadmin.statusCode).toBe(200);

    const usersBefore = await app.call("listAdministeredUsers", {
      headers: {
        "x-dev-user-id": "admin-1"
      }
    });
    expect(usersBefore.statusCode).toBe(200);
    const usersBeforeBody = usersBefore.json() as Array<{ id: string; roles: string[] }>;
    const superadminUser = usersBeforeBody.find((user) => user.roles.includes("superadmin"));
    expect(superadminUser).toBeUndefined();

    const superadminVisibleUsers = await app.call("listAdministeredUsers", {
      headers: {
        "x-dev-user-id": "superadmin-1"
      }
    });
    expect(superadminVisibleUsers.statusCode).toBe(200);
    const superadminVisibleUsersBody = superadminVisibleUsers.json() as Array<{
      id: string;
      roles: string[];
    }>;
    const superadminManagedUser = superadminVisibleUsersBody.find((user) =>
      user.roles.includes("superadmin")
    );
    expect(superadminManagedUser).toBeDefined();

    const created = await app.call("createAdministeredUser", {
      headers: {
        "x-dev-user-id": "admin-1"
      },
      payload: {
        displayLabel: "Admin Created User",
        email: "admin-created@example.test",
        roles: ["user", "admin"],
        permissionRefs: ["demo-tools"],
        permissions: ["config_assets.write"]
      }
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ permissions: ["config_assets.write"] });
    const createdUser = created.json() as { id: string };

    const releasePermissionCreate = await app.call("createAdministeredUser", {
      headers: {
        "x-dev-user-id": "admin-1"
      },
      payload: {
        displayLabel: "Release User",
        roles: ["user"],
        permissions: ["config_assets.release"]
      }
    });
    expect(releasePermissionCreate.statusCode).toBe(422);
    expect(releasePermissionCreate.json()).toMatchObject({
      error: {
        code: "VALIDATION_FAILED",
        message: "Release permission can only be carried by service tokens"
      }
    });

    const releasePermissionUpdate = await app.call("updateAdministeredUser", {
      params: { userId: createdUser.id },
      headers: {
        "x-dev-user-id": "superadmin-1"
      },
      payload: {
        permissions: ["config_assets.release"]
      }
    });
    expect(releasePermissionUpdate.statusCode).toBe(422);
    expect(releasePermissionUpdate.json()).toMatchObject({
      error: { code: "VALIDATION_FAILED" }
    });

    const escalatedCreate = await app.call("createAdministeredUser", {
      headers: {
        "x-dev-user-id": "admin-1"
      },
      payload: {
        displayLabel: "Escalated User",
        roles: ["user", "admin", "superadmin"]
      }
    });
    expect(escalatedCreate.statusCode).toBe(403);
    expect((escalatedCreate.json() as { error: { message: string } }).error.message).toContain(
      "Only superadmins can assign superadmin access"
    );

    const escalatedUpdate = await app.call("updateAdministeredUser", {
      params: { userId: createdUser.id },
      headers: {
        "x-dev-user-id": "admin-1"
      },
      payload: {
        roles: ["user", "admin", "superadmin"]
      }
    });
    expect(escalatedUpdate.statusCode).toBe(403);

    const superadminUpdate = await app.call("updateAdministeredUser", {
      params: { userId: required(superadminManagedUser?.id) },
      headers: {
        "x-dev-user-id": "admin-1"
      },
      payload: {
        status: "disabled"
      }
    });
    expect(superadminUpdate.statusCode).toBe(403);
    expect((superadminUpdate.json() as { error: { message: string } }).error.message).toContain(
      "Only superadmins can manage superadmin users"
    );

    const adminDelete = await app.call("deleteAdministeredUser", {
      params: { userId: createdUser.id },
      headers: {
        "x-dev-user-id": "admin-1"
      }
    });
    expect(adminDelete.statusCode).toBe(403);
    expect((adminDelete.json() as { error: { message: string } }).error.message).toContain(
      "superadmin role"
    );

    const selfDelete = await app.call("deleteAdministeredUser", {
      params: { userId: required(superadminManagedUser?.id) },
      headers: {
        "x-dev-user-id": "superadmin-1"
      }
    });
    expect(selfDelete.statusCode).toBe(422);
    expect((selfDelete.json() as { error: { message: string } }).error.message).toContain(
      "cannot delete their own user account"
    );

    await app.close();
  });

  it("administers users and shares conversations across linked auth identities", async () => {
    const app = await createTestInstance({
      config: createTestConfig({
        sessionToken: {
          issuer: "demo-client-instance",
          ttlSeconds: 900
        },
        developmentAuth: {
          enabled: true,
          defaultUserId: "superadmin-1",
          users: [
            {
              id: "superadmin-1",
              externalUserId: "superadmin-1",
              displayLabel: "Superadmin",
              roles: ["user", "admin", "superadmin"],
              permissionRefs: ["demo-tools"]
            },
            {
              id: "jane-dev-source",
              externalUserId: "jane-dev",
              displayLabel: "Jane Standalone",
              email: "jane@example.test",
              emailVerified: true,
              roles: ["user"],
              permissionRefs: ["demo-tools"]
            }
          ]
        }
      }),
      env: {
        CHAT_SESSION_TOKEN_SECRET: "a-development-session-token-secret",
        CHAT_SERVER_CREDENTIAL: "server-credential"
      },
      tools: []
    });

    const usersBefore = await app.call("listAdministeredUsers", {
      headers: {
        "x-dev-user-id": "superadmin-1"
      }
    });
    expect(usersBefore.statusCode).toBe(200);
    expect(usersBefore.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          displayLabel: "Superadmin",
          identities: [
            expect.objectContaining({
              authSource: "development",
              externalUserId: "superadmin-1"
            })
          ]
        })
      ])
    );

    const created = await app.call("createAdministeredUser", {
      headers: {
        "x-dev-user-id": "superadmin-1"
      },
      payload: {
        displayLabel: "Jane Reviewer",
        email: "jane@example.test",
        roles: ["user"],
        permissionRefs: ["demo-tools"]
      }
    });
    expect(created.statusCode).toBe(200);
    const administeredUser = created.json() as { id: string };

    for (const identity of [
      {
        authSource: "session-token",
        externalUserId: "customer-jane",
        displayLabel: "Jane Reviewer",
        email: "jane@example.test",
        emailVerified: true
      },
      {
        authSource: "development",
        externalUserId: "jane-dev",
        displayLabel: "Jane Standalone",
        email: "jane@example.test",
        emailVerified: true
      }
    ]) {
      const linked = await app.call("upsertAdministeredUserIdentity", {
        params: { userId: administeredUser.id },
        headers: {
          "x-dev-user-id": "superadmin-1"
        },
        payload: identity
      });
      expect(linked.statusCode).toBe(200);
    }

    const issued = await app.call("issueSessionToken", {
      headers: {
        "x-server-credential": "server-credential"
      },
      payload: {
        externalUserId: "customer-jane",
        displayLabel: "Jane Reviewer",
        email: "jane@example.test",
        emailVerified: true,
        roles: ["user"],
        permissionRefs: ["demo-tools"]
      }
    });
    expect(issued.statusCode).toBe(200);
    const token = (issued.json() as { chatSessionToken: string }).chatSessionToken;

    const createdConversation = await app.call("createConversation", {
      headers: {
        authorization: `Bearer ${token}`
      },
      payload: {
        title: "Shared context"
      }
    });
    expect(createdConversation.statusCode).toBe(200);
    const conversation = createdConversation.json() as { id: string; createdByUserId: string };
    expect(conversation.createdByUserId).toBe(administeredUser.id);
    await seedConversationMessage(app.stores, conversation.id);

    const standaloneConversations = await app.call(
      "listConversations",
      await personalConversationListInput(app, {
        "x-dev-user-id": "jane-dev-source"
      })
    );
    expect(standaloneConversations.statusCode).toBe(200);
    expect(standaloneConversations.json()).toEqual([
      expect.objectContaining({
        id: conversation.id,
        createdByUserId: administeredUser.id
      })
    ]);

    const audit = await app.call("listAuditEvents", {
      headers: {
        "x-dev-user-id": "superadmin-1"
      }
    });
    expect(audit.statusCode).toBe(200);
    expect((audit.json() as Array<{ type: string }>).map((event) => event.type)).toEqual(
      expect.arrayContaining(["user.created", "user.identity_upserted"])
    );

    await app.close();
  });

  it("automatically links identities with a matching verified email to one shared user", async () => {
    const app = await createTestInstance({
      config: createTestConfig({
        sessionToken: {
          issuer: "demo-client-instance",
          ttlSeconds: 900
        },
        developmentAuth: {
          enabled: true,
          defaultUserId: "superadmin-1",
          users: [
            {
              id: "superadmin-1",
              externalUserId: "superadmin-1",
              displayLabel: "Superadmin",
              roles: ["user", "admin", "superadmin"],
              permissionRefs: ["demo-tools"]
            },
            {
              id: "jane-dev-source",
              externalUserId: "jane-dev",
              displayLabel: "Jane Standalone",
              email: "jane@example.test",
              emailVerified: true,
              roles: ["user"],
              permissionRefs: ["demo-tools"]
            }
          ]
        }
      }),
      env: {
        CHAT_SESSION_TOKEN_SECRET: "a-development-session-token-secret",
        CHAT_SERVER_CREDENTIAL: "server-credential"
      },
      tools: []
    });

    const created = await app.call("createAdministeredUser", {
      headers: {
        "x-dev-user-id": "superadmin-1"
      },
      payload: {
        displayLabel: "Jane Reviewer",
        email: "jane@example.test",
        roles: ["user"],
        permissionRefs: ["demo-tools"]
      }
    });
    expect(created.statusCode).toBe(200);
    const administeredUser = created.json() as { id: string };

    const issued = await app.call("issueSessionToken", {
      headers: {
        "x-server-credential": "server-credential"
      },
      payload: {
        externalUserId: "customer-jane",
        displayLabel: "Jane Reviewer",
        email: "jane@example.test",
        emailVerified: true,
        roles: ["user"],
        permissionRefs: ["demo-tools"]
      }
    });
    expect(issued.statusCode).toBe(200);
    const token = (issued.json() as { chatSessionToken: string }).chatSessionToken;

    const createdConversation = await app.call("createConversation", {
      headers: {
        authorization: `Bearer ${token}`
      },
      payload: {
        title: "Shared by verified email"
      }
    });
    expect(createdConversation.statusCode).toBe(200);
    const conversation = createdConversation.json() as { id: string; createdByUserId: string };
    expect(conversation.createdByUserId).toBe(administeredUser.id);
    await seedConversationMessage(app.stores, conversation.id);

    const standaloneConversations = await app.call(
      "listConversations",
      await personalConversationListInput(app, {
        "x-dev-user-id": "jane-dev-source"
      })
    );
    expect(standaloneConversations.statusCode).toBe(200);
    expect(standaloneConversations.json()).toEqual([
      expect.objectContaining({
        id: conversation.id,
        createdByUserId: administeredUser.id
      })
    ]);

    const audit = await app.call("listAuditEvents", {
      headers: {
        "x-dev-user-id": "superadmin-1"
      }
    });
    expect(audit.statusCode).toBe(200);
    expect((audit.json() as Array<{ type: string }>).map((event) => event.type)).toEqual(
      expect.arrayContaining(["user.identity_linked"])
    );

    const duplicate = await app.call("createAdministeredUser", {
      headers: {
        "x-dev-user-id": "superadmin-1"
      },
      payload: {
        displayLabel: "Jane Duplicate",
        email: "jane@example.test",
        roles: ["user"],
        permissionRefs: ["demo-tools"]
      }
    });
    expect(duplicate.statusCode).toBe(200);

    const ambiguousIssued = await app.call("issueSessionToken", {
      headers: {
        "x-server-credential": "server-credential"
      },
      payload: {
        externalUserId: "customer-jane-other",
        displayLabel: "Jane Other",
        email: "jane@example.test",
        emailVerified: true,
        roles: ["user"],
        permissionRefs: ["demo-tools"]
      }
    });
    expect(ambiguousIssued.statusCode).toBe(200);
    const ambiguousToken = (ambiguousIssued.json() as { chatSessionToken: string })
      .chatSessionToken;

    const ambiguousConversation = await app.call("createConversation", {
      headers: {
        authorization: `Bearer ${ambiguousToken}`
      },
      payload: {
        title: "Ambiguous email must not share history"
      }
    });
    expect(ambiguousConversation.statusCode).toBe(200);
    expect((ambiguousConversation.json() as { createdByUserId: string }).createdByUserId).not.toBe(
      administeredUser.id
    );

    await app.close();
  });
});
