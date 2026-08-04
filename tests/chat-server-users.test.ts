import { describe, expect, it } from "vitest";
import { createChatServer } from "@vivd-catalyst/chat-server";
import { STANDALONE_AUTH_SOURCE } from "@vivd-catalyst/auth";
import {
  AppError,
  PERMISSIONS,
  StoreBackedAuditRecorder,
  asClientInstanceId
} from "@vivd-catalyst/core";
import { InMemoryPlatformStore } from "@vivd-catalyst/core/testing";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import { createTestConfig, createClientInstanceApp } from "./chat-server-harness";
import { createMissingRuntime, createUnusedModelProvider } from "./chat-server-run-harness";

describe("client instance app vertical slice", () => {
  it("switches between configured development users without exposing a dev-user listing route", async () => {
    const app = await createClientInstanceApp({
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
      storeMode: "memory",
      tools: []
    });

    const developmentUsersRoute = await app.server.inject({
      method: "GET",
      url: "/auth/development/users"
    });
    expect(developmentUsersRoute.statusCode).toBe(404);

    const defaultMe = await app.server.inject({
      method: "GET",
      url: "/api/me"
    });
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

    const normalMe = await app.server.inject({
      method: "GET",
      url: "/api/me",
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

    const normalUsage = await app.server.inject({
      method: "GET",
      url: "/api/superadmin/usage",
      headers: {
        "x-dev-user-id": "user-1"
      }
    });
    expect(normalUsage.statusCode).toBe(403);

    const grantedUsage = await app.server.inject({
      method: "GET",
      url: "/api/superadmin/usage",
      headers: {
        "x-dev-user-id": "usage-viewer-1"
      }
    });
    expect(grantedUsage.statusCode).toBe(200);

    const unknownUser = await app.server.inject({
      method: "GET",
      url: "/api/me",
      headers: {
        "x-dev-user-id": "missing-user"
      }
    });
    expect(unknownUser.statusCode).toBe(401);

    await app.close();
  });

  it("lets a user update their own profile without changing authorization fields", async () => {
    const app = await createClientInstanceApp({
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
      storeMode: "memory",
      tools: []
    });

    const updated = await app.server.inject({
      method: "PATCH",
      url: "/api/me",
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

    const audit = await app.server.inject({
      method: "GET",
      url: "/api/audit-events",
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
    const app = await createClientInstanceApp({
      config: createTestConfig(),
      env: {},
      storeMode: "memory",
      tools: []
    });

    const changed = await app.server.inject({
      method: "POST",
      url: "/api/me/password",
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

  it("lets a signed-in user delete their own account and owned conversations", async () => {
    const clientInstanceId = asClientInstanceId("demo-local");
    const store = new InMemoryPlatformStore();
    const config = createTestConfig();
    const usageGovernance = new ModelUsageGovernance({
      store,
      budget: config.usage.budget,
      safeguards: config.usage.safeguards,
      costs: config.usage.costs
    });
    const user = await store.resolveUserIdentity({
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
      clientInstanceId,
      authSource: "development",
      externalUserId: "other-user",
      displayLabel: "Other User",
      roles: ["user"],
      permissionRefs: ["demo-tools"],
      correlationId: "corr_other"
    });
    const conversation = await store.createConversation({
      clientInstanceId,
      ownerUserId: user.id,
      ownerExternalUserId: user.externalUserId,
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
      clientInstanceId,
      ownerUserId: otherUser.id,
      ownerExternalUserId: otherUser.externalUserId,
      title: "Keep this conversation",
      retainedUntil: "2030-01-01T00:00:00.000Z"
    });
    const deletedPasswordSignIns: Array<{ externalUserId: string }> = [];
    const server = await createChatServer({
      config,
      clientInstanceId,
      authAdapter: {
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
    });

    const delegatedDelete = await server.inject({
      method: "DELETE",
      url: "/api/me",
      headers: {
        "x-service-principal": "1"
      }
    });
    expect(delegatedDelete.statusCode).toBe(403);

    const deleted = await server.inject({
      method: "DELETE",
      url: "/api/me"
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ ok: true });
    expect(deletedPasswordSignIns).toEqual([{ externalUserId: "auth-delete-me" }]);

    await expect(store.listUsers({ clientInstanceId })).resolves.not.toContainEqual(
      expect.objectContaining({ id: user.id })
    );
    await expect(store.getConversation(clientInstanceId, conversation.id)).resolves.toMatchObject({
      status: "deleted"
    });
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
            conversationCount: 1
          })
        })
      ])
    );

    await server.close();
  });

  it("lets admins administer non-superadmin users without escalating superadmin access", async () => {
    const app = await createClientInstanceApp({
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
      storeMode: "memory",
      tools: []
    });

    const seededSuperadmin = await app.server.inject({
      method: "GET",
      url: "/api/me",
      headers: {
        "x-dev-user-id": "superadmin-1"
      }
    });
    expect(seededSuperadmin.statusCode).toBe(200);

    const usersBefore = await app.server.inject({
      method: "GET",
      url: "/api/superadmin/users",
      headers: {
        "x-dev-user-id": "admin-1"
      }
    });
    expect(usersBefore.statusCode).toBe(200);
    const usersBeforeBody = usersBefore.json() as Array<{ id: string; roles: string[] }>;
    const superadminUser = usersBeforeBody.find((user) => user.roles.includes("superadmin"));
    expect(superadminUser).toBeUndefined();

    const superadminVisibleUsers = await app.server.inject({
      method: "GET",
      url: "/api/superadmin/users",
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

    const created = await app.server.inject({
      method: "POST",
      url: "/api/superadmin/users",
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

    const releasePermissionCreate = await app.server.inject({
      method: "POST",
      url: "/api/superadmin/users",
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

    const releasePermissionUpdate = await app.server.inject({
      method: "PATCH",
      url: `/api/superadmin/users/${createdUser.id}`,
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

    const escalatedCreate = await app.server.inject({
      method: "POST",
      url: "/api/superadmin/users",
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

    const escalatedUpdate = await app.server.inject({
      method: "PATCH",
      url: `/api/superadmin/users/${createdUser.id}`,
      headers: {
        "x-dev-user-id": "admin-1"
      },
      payload: {
        roles: ["user", "admin", "superadmin"]
      }
    });
    expect(escalatedUpdate.statusCode).toBe(403);

    const superadminUpdate = await app.server.inject({
      method: "PATCH",
      url: `/api/superadmin/users/${superadminManagedUser?.id}`,
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

    const adminDelete = await app.server.inject({
      method: "DELETE",
      url: `/api/superadmin/users/${createdUser.id}`,
      headers: {
        "x-dev-user-id": "admin-1"
      }
    });
    expect(adminDelete.statusCode).toBe(403);
    expect((adminDelete.json() as { error: { message: string } }).error.message).toContain(
      "superadmin role"
    );

    const selfDelete = await app.server.inject({
      method: "DELETE",
      url: `/api/superadmin/users/${superadminManagedUser?.id}`,
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
    const app = await createClientInstanceApp({
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
      storeMode: "memory",
      tools: []
    });

    const usersBefore = await app.server.inject({
      method: "GET",
      url: "/api/superadmin/users",
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

    const created = await app.server.inject({
      method: "POST",
      url: "/api/superadmin/users",
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
      const linked = await app.server.inject({
        method: "PUT",
        url: `/api/superadmin/users/${administeredUser.id}/identities`,
        headers: {
          "x-dev-user-id": "superadmin-1"
        },
        payload: identity
      });
      expect(linked.statusCode).toBe(200);
    }

    const issued = await app.server.inject({
      method: "POST",
      url: "/api/superadmin/session-tokens",
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

    const createdConversation = await app.server.inject({
      method: "POST",
      url: "/api/conversations",
      headers: {
        authorization: `Bearer ${token}`
      },
      payload: {
        title: "Shared context"
      }
    });
    expect(createdConversation.statusCode).toBe(200);
    const conversation = createdConversation.json() as { id: string; ownerUserId: string };
    expect(conversation.ownerUserId).toBe(administeredUser.id);

    const standaloneConversations = await app.server.inject({
      method: "GET",
      url: "/api/conversations",
      headers: {
        "x-dev-user-id": "jane-dev-source"
      }
    });
    expect(standaloneConversations.statusCode).toBe(200);
    expect(standaloneConversations.json()).toEqual([
      expect.objectContaining({
        id: conversation.id,
        ownerUserId: administeredUser.id
      })
    ]);

    const audit = await app.server.inject({
      method: "GET",
      url: "/api/audit-events",
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
    const app = await createClientInstanceApp({
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
      storeMode: "memory",
      tools: []
    });

    const created = await app.server.inject({
      method: "POST",
      url: "/api/superadmin/users",
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

    const issued = await app.server.inject({
      method: "POST",
      url: "/api/superadmin/session-tokens",
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

    const createdConversation = await app.server.inject({
      method: "POST",
      url: "/api/conversations",
      headers: {
        authorization: `Bearer ${token}`
      },
      payload: {
        title: "Shared by verified email"
      }
    });
    expect(createdConversation.statusCode).toBe(200);
    const conversation = createdConversation.json() as { id: string; ownerUserId: string };
    expect(conversation.ownerUserId).toBe(administeredUser.id);

    const standaloneConversations = await app.server.inject({
      method: "GET",
      url: "/api/conversations",
      headers: {
        "x-dev-user-id": "jane-dev-source"
      }
    });
    expect(standaloneConversations.statusCode).toBe(200);
    expect(standaloneConversations.json()).toEqual([
      expect.objectContaining({
        id: conversation.id,
        ownerUserId: administeredUser.id
      })
    ]);

    const audit = await app.server.inject({
      method: "GET",
      url: "/api/audit-events",
      headers: {
        "x-dev-user-id": "superadmin-1"
      }
    });
    expect(audit.statusCode).toBe(200);
    expect((audit.json() as Array<{ type: string }>).map((event) => event.type)).toEqual(
      expect.arrayContaining(["user.identity_linked"])
    );

    const duplicate = await app.server.inject({
      method: "POST",
      url: "/api/superadmin/users",
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

    const ambiguousIssued = await app.server.inject({
      method: "POST",
      url: "/api/superadmin/session-tokens",
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

    const ambiguousConversation = await app.server.inject({
      method: "POST",
      url: "/api/conversations",
      headers: {
        authorization: `Bearer ${ambiguousToken}`
      },
      payload: {
        title: "Ambiguous email must not share history"
      }
    });
    expect(ambiguousConversation.statusCode).toBe(200);
    expect((ambiguousConversation.json() as { ownerUserId: string }).ownerUserId).not.toBe(
      administeredUser.id
    );

    await app.close();
  });
});
