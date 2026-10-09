import { createTestInstance } from "./support/test-instance";
import { describe, expect, it } from "vitest";

import {
  FIRST_PARTY_AUTH_SCOPES,
  StoreBackedAuditRecorder,
  asClientInstanceId,
  asCollaborationWorkspaceId,
  asUserId,
  type AuthenticatedUser
} from "@vivd-catalyst/core";

import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import { createTestConfig, createTestUser, seedConversationMessage } from "./support/fixtures";
import { createMissingRuntime, createUnusedModelProvider } from "./support/chat-server-run-harness";

describe("client instance app vertical slice", () => {
  it("keeps chat session tokens scoped away from governance routes despite elevated roles", async () => {
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

    const issued = await app.call("session_tokens.issue", {
      headers: {
        "x-server-credential": "server-credential"
      },
      payload: {
        externalUserId: "customer-admin",
        displayLabel: "Customer Admin",
        roles: ["user", "admin", "superadmin"],
        permissionRefs: ["demo-tools"]
      }
    });
    expect(issued.statusCode).toBe(200);
    const token = (issued.json() as { chatSessionToken: string }).chatSessionToken;

    const workspaceListing = await app.call("workspaces.list", {
      headers: {
        authorization: `Bearer ${token}`
      }
    });
    expect(workspaceListing.statusCode).toBe(403);
    expect(workspaceListing.json().error.message).toContain(
      "Missing auth scope 'collaboration_workspace:read'"
    );

    const workspaceCreation = await app.call("workspaces.create", {
      headers: {
        authorization: `Bearer ${token}`
      },
      payload: { name: "Should not be created" }
    });
    expect(workspaceCreation.statusCode).toBe(403);
    expect((workspaceCreation.json() as { error: { message: string } }).error.message).toContain(
      "Missing auth scope 'collaboration_workspace:manage'"
    );

    const createdConversation = await app.call("conversations.create", {
      headers: {
        authorization: `Bearer ${token}`
      },
      payload: { title: "Personal conversation" }
    });
    expect(createdConversation.statusCode).toBe(200);
    const personalConversation = createdConversation.json() as {
      id: string;
      collaborationWorkspaceId: string;
      createdByUserId: string;
    };
    await seedConversationMessage(app.stores.conversations, personalConversation.id);

    const firstPartyListing = await app.call("workspaces.list", {
      headers: { "x-dev-user-id": "superadmin-1" }
    });
    expect(firstPartyListing.statusCode).toBe(200);
    const firstPartyCreation = await app.call("workspaces.create", {
      headers: { "x-dev-user-id": "superadmin-1" },
      payload: { name: "First-party workspace" }
    });
    expect(firstPartyCreation.statusCode).toBe(200);
    const sharedWorkspaceId = (firstPartyCreation.json() as { id: string }).id;
    await app.stores.workspaces.addMembership({
      clientInstanceId: asClientInstanceId("demo-local"),
      collaborationWorkspaceId: asCollaborationWorkspaceId(sharedWorkspaceId),
      userId: asUserId(personalConversation.createdByUserId),
      role: "member"
    });
    const sharedConversation = await app.call("conversations.create", {
      headers: { "x-dev-user-id": "superadmin-1" },
      payload: { title: "Shared conversation", collaborationWorkspaceId: sharedWorkspaceId }
    });
    expect(sharedConversation.statusCode).toBe(200);
    const sharedConversationId = (sharedConversation.json() as { id: string }).id;
    await seedConversationMessage(app.stores.conversations, sharedConversationId);

    const personalConversations = await app.call("conversations.list", {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(personalConversations.statusCode).toBe(200);
    expect(
      personalConversations.json<{ items: Array<{ id: string }> }>().items.map(({ id }) => id)
    ).toEqual([personalConversation.id]);

    const sharedConversations = await app.call("conversations.list", {
      query: { collaborationWorkspaceId: sharedWorkspaceId },
      headers: { authorization: `Bearer ${token}` }
    });
    expect(sharedConversations.statusCode).toBe(200);
    expect(
      sharedConversations.json<{ items: Array<{ id: string }> }>().items.map(({ id }) => id)
    ).toEqual([sharedConversationId]);

    const usage = await app.call("usage.get_summary", {
      headers: {
        authorization: `Bearer ${token}`
      }
    });
    expect(usage.statusCode).toBe(403);
    expect((usage.json() as { error: { message: string } }).error.message).toContain(
      "Missing auth scope 'governance:read'"
    );

    const audit = await app.call("audit_events.list", {
      headers: {
        authorization: `Bearer ${token}`
      }
    });
    expect(audit.statusCode).toBe(403);

    await app.close();
  });

  it("grants standalone users workspace read and manage scopes", async () => {
    const clientInstanceId = asClientInstanceId("demo-local");
    const store = (await createTestInstance()).stores;
    const config = createTestConfig();
    const profile = await store.users.createUser({
      clientInstanceId,
      displayLabel: "Standalone user",
      email: "standalone@example.test"
    });
    const standaloneUser: AuthenticatedUser = {
      id: profile.id,
      externalUserId: "standalone-user",
      displayLabel: profile.displayLabel,
      email: profile.email,
      emailVerified: true,
      roles: ["user"],
      permissionRefs: [],
      permissions: [],
      clientInstanceId,
      authSource: "better-auth",
      scopes: [...FIRST_PARTY_AUTH_SCOPES]
    };
    expect(standaloneUser.scopes).toEqual(
      expect.arrayContaining(["collaboration_workspace:read", "collaboration_workspace:manage"])
    );
    const usageGovernance = new ModelUsageGovernance({
      store: store.usage,
      budget: config.usage.budget,
      safeguards: config.usage.safeguards,
      costs: config.usage.costs
    });
    const server = await createTestInstance({
      server: {
        config,
        clientInstanceId,
        authAdapter: {
          credentialMode: "ambient",
          id: "better-auth-test",
          async authenticate() {
            return standaloneUser;
          }
        },
        stores: store,
        usageGovernance,
        auditRecorder: new StoreBackedAuditRecorder({ clientInstanceId, store: store.audit }),
        agentRuntime: createMissingRuntime(),
        modelProvider: createUnusedModelProvider()
      }
    });

    const listed = await server.call("workspaces.list", {});
    expect(listed.statusCode).toBe(200);
    const created = await server.call("workspaces.create", {
      payload: { name: "Standalone workspace" }
    });
    expect(created.statusCode).toBe(200);

    await server.close();
  });

  it("honors explicit chat session token scopes for conversation writes", async () => {
    const app = await createTestInstance({
      config: createTestConfig({
        sessionToken: {
          issuer: "demo-client-instance",
          ttlSeconds: 900
        }
      }),
      env: {
        CHAT_SESSION_TOKEN_SECRET: "a-development-session-token-secret",
        CHAT_SERVER_CREDENTIAL: "server-credential"
      },
      tools: []
    });

    const issued = await app.call("session_tokens.issue", {
      headers: {
        "x-server-credential": "server-credential"
      },
      payload: {
        externalUserId: "read-only-user",
        displayLabel: "Read Only User",
        roles: ["user"],
        permissionRefs: ["demo-tools"],
        scopes: ["me:read", "conversation:read"]
      }
    });
    expect(issued.statusCode).toBe(200);
    const token = (issued.json() as { chatSessionToken: string }).chatSessionToken;

    const conversations = await app.call("conversations.list", {
      headers: {
        authorization: `Bearer ${token}`
      }
    });
    expect(conversations.statusCode).toBe(200);

    const created = await app.call("conversations.create", {
      headers: {
        authorization: `Bearer ${token}`
      },
      payload: {
        title: "Should not be created"
      }
    });
    expect(created.statusCode).toBe(403);
    expect((created.json() as { error: { message: string } }).error.message).toContain(
      "Missing auth scope 'conversation:write'"
    );

    await app.close();
  });

  it("audits delegated service-principal conversation actions for the subject user", async () => {
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

    const issued = await app.call("session_tokens.issue", {
      headers: {
        "x-server-credential": "server-credential"
      },
      payload: {
        externalUserId: "customer-jane",
        displayLabel: "Jane Reviewer",
        roles: ["user"],
        permissionRefs: ["demo-tools"],
        delegatedActor: {
          kind: "service_principal",
          id: "svc-customer-api",
          displayLabel: "Customer API",
          authSource: "customer-app"
        }
      }
    });
    expect(issued.statusCode).toBe(200);
    const token = (issued.json() as { chatSessionToken: string }).chatSessionToken;

    const createdConversation = await app.call("conversations.create", {
      headers: {
        authorization: `Bearer ${token}`
      },
      payload: {
        title: "Delegated action"
      }
    });
    expect(createdConversation.statusCode).toBe(200);
    const conversation = createdConversation.json() as {
      id: string;
      createdByUserId: string;
      createdByExternalUserId: string;
    };
    expect(conversation.createdByExternalUserId).toBe("customer-jane");
    expect(conversation.createdByUserId).not.toBe("svc-customer-api");

    const audit = await app.call("audit_events.list", {
      headers: {
        "x-dev-user-id": "superadmin-1"
      }
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().items).toContainEqual(
      expect.objectContaining({
        type: "conversation.created",
        subject: conversation.id,
        actor: expect.objectContaining({
          userId: conversation.createdByUserId,
          principalKind: "service",
          principalId: "svc-customer-api",
          principalDisplayLabel: "Customer API",
          subjectUserId: conversation.createdByUserId,
          delegatedActor: expect.objectContaining({
            kind: "service_principal",
            id: "svc-customer-api",
            authSource: "customer-app"
          })
        })
      })
    );

    await app.close();
  });

  it("binds a private conversation to the delegated subject, not the service principal", async () => {
    const clientInstanceId = asClientInstanceId("demo-local");
    const app = await createTestInstance({
      config: createTestConfig({
        sessionToken: {
          issuer: "demo-client-instance",
          ttlSeconds: 900
        }
      }),
      env: {
        CHAT_SESSION_TOKEN_SECRET: "a-development-session-token-secret",
        CHAT_SERVER_CREDENTIAL: "server-credential"
      },
      tools: []
    });
    const issueFor = async (externalUserId: string) => {
      const issued = await app.call("session_tokens.issue", {
        headers: { "x-server-credential": "server-credential" },
        payload: {
          externalUserId,
          displayLabel: externalUserId,
          roles: ["user"],
          permissionRefs: ["demo-tools"],
          delegatedActor: {
            kind: "service_principal",
            id: "svc-customer-api",
            displayLabel: "Customer API",
            authSource: "customer-app"
          }
        }
      });
      expect(issued.statusCode).toBe(200);
      const authorization = `Bearer ${(issued.json() as { chatSessionToken: string }).chatSessionToken}`;
      const me = await app.call("me.get", { headers: { authorization } });
      expect(me.statusCode).toBe(200);
      return { authorization, userId: asUserId((me.json() as { id: string }).id) };
    };
    const jane = await issueFor("customer-jane");
    const john = await issueFor("customer-john");
    const workspace = await app.stores.workspaces.createWorkspace({
      clientInstanceId,
      kind: "shared",
      name: "Delegated",
      defaultConversationVisibility: "private",
      creatorUserId: john.userId
    });
    await app.stores.workspaces.addMembership({
      clientInstanceId,
      collaborationWorkspaceId: workspace.id,
      userId: jane.userId,
      role: "member"
    });

    const created = await app.call("conversations.create", {
      headers: { authorization: jane.authorization },
      payload: { title: "Jane only", collaborationWorkspaceId: workspace.id }
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ visibility: "private", createdByUserId: jane.userId });
    const conversationId = (created.json() as { id: string }).id;

    const thread = (authorization: string) =>
      app.call("conversations.thread.get", {
        params: { conversationId: conversationId },
        headers: { authorization }
      });
    expect((await thread(jane.authorization)).statusCode).toBe(200);
    const sameServiceOtherSubject = await thread(john.authorization);
    expect(sameServiceOtherSubject.statusCode).toBe(404);
    expect(sameServiceOtherSubject.json()).toEqual({
      error: {
        correlationId: expect.any(String),
        code: "NOT_FOUND",
        message: "Conversation is not available"
      }
    });
    const listed = await app.call("conversations.list", {
      query: { collaborationWorkspaceId: workspace.id },
      headers: { authorization: john.authorization }
    });
    expect(listed.json().items).toEqual([]);

    await app.close();
  });

  it("creates and resets standalone password sign-ins from superadmin user administration", async () => {
    const clientInstanceId = asClientInstanceId("demo-local");
    const store = (await createTestInstance()).stores;
    const config = createTestConfig();
    const usageGovernance = new ModelUsageGovernance({
      store: store.usage,
      budget: config.usage.budget,
      safeguards: config.usage.safeguards,
      costs: config.usage.costs
    });
    const createdPasswordSignIns: Array<{
      email: string;
      displayLabel: string;
      password: string;
    }> = [];
    const resetPasswords: Array<{ externalUserId: string; password: string }> = [];
    const deletedPasswordSignIns: Array<{ externalUserId: string }> = [];
    const server = await createTestInstance({
      server: {
        config,
        clientInstanceId,
        authAdapter: {
          credentialMode: "ambient",
          id: "test-auth",
          async authenticate() {
            return createTestUser("superadmin-1", clientInstanceId);
          }
        },
        stores: store,
        usageGovernance,
        auditRecorder: new StoreBackedAuditRecorder({ clientInstanceId, store: store.audit }),
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
          routeKind: () => undefined,
          async setOrCreatePasswordSignIn(input) {
            createdPasswordSignIns.push({
              email: input.email,
              displayLabel: input.displayLabel,
              password: input.password
            });
            return {
              externalUserId: `auth-${input.email}`,
              displayLabel: input.displayLabel,
              email: input.email.toLowerCase(),
              emailVerified: true
            };
          },
          async setPassword(input) {
            resetPasswords.push(input);
          },
          async changePassword() {},
          async deletePasswordSignIn(input) {
            deletedPasswordSignIns.push(input);
          }
        }
      }
    });

    const created = await server.call("users.create", {
      payload: {
        displayLabel: "Jane Reviewer",
        email: "Jane@Example.Test",
        roles: ["user", "admin"],
        permissionRefs: ["demo-tools"],
        passwordSignIn: {
          password: "initial-password"
        }
      }
    });
    expect(created.statusCode).toBe(200);
    const createdUser = created.json() as {
      id: string;
      identities: Array<{ authSource: string; externalUserId: string; email?: string }>;
    };
    expect(createdPasswordSignIns).toEqual([
      {
        email: "Jane@Example.Test",
        displayLabel: "Jane Reviewer",
        password: "initial-password"
      }
    ]);
    expect(createdUser.identities).toEqual([
      expect.objectContaining({
        authSource: "better-auth",
        externalUserId: "auth-Jane@Example.Test",
        email: "jane@example.test"
      })
    ]);

    const reset = await server.call("users.password.reset", {
      params: { userId: createdUser.id },
      payload: {
        password: "replacement-password"
      }
    });
    expect(reset.statusCode).toBe(200);
    expect(resetPasswords).toEqual([
      {
        externalUserId: "auth-Jane@Example.Test",
        password: "replacement-password"
      }
    ]);

    const profileOnly = await server.call("users.create", {
      payload: {
        displayLabel: "Sam Reviewer",
        email: "sam@example.test",
        roles: ["user"]
      }
    });
    expect(profileOnly.statusCode).toBe(200);
    const profileOnlyUser = profileOnly.json() as { id: string };

    const setFirstPassword = await server.call("users.password.reset", {
      params: { userId: profileOnlyUser.id },
      payload: {
        password: "first-password"
      }
    });
    expect(setFirstPassword.statusCode).toBe(200);
    expect(createdPasswordSignIns).toContainEqual({
      email: "sam@example.test",
      displayLabel: "Sam Reviewer",
      password: "first-password"
    });

    const listed = await server.call("users.list", {});
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: profileOnlyUser.id,
          identities: [
            expect.objectContaining({
              authSource: "better-auth",
              externalUserId: "auth-sam@example.test"
            })
          ]
        })
      ])
    );

    const audit = await server.call("audit_events.list", {});
    expect(audit.statusCode).toBe(200);
    expect(
      audit.json<{ items: Array<{ type: string }> }>().items.map((event) => event.type)
    ).toEqual(expect.arrayContaining(["user.password_sign_in_created", "user.password_reset"]));

    const deleted = await server.call("users.delete", {
      params: { userId: createdUser.id }
    });
    expect(deleted.statusCode).toBe(200);
    expect(deletedPasswordSignIns).toEqual([{ externalUserId: "auth-Jane@Example.Test" }]);

    const listedAfterDelete = await server.call("users.list", {});
    expect(listedAfterDelete.statusCode).toBe(200);
    expect(listedAfterDelete.json().items).not.toContainEqual(
      expect.objectContaining({
        id: createdUser.id
      })
    );

    const auditAfterDelete = await server.call("audit_events.list", {});
    expect(auditAfterDelete.statusCode).toBe(200);
    expect(
      auditAfterDelete.json<{ items: Array<{ type: string }> }>().items.map((event) => event.type)
    ).toEqual(expect.arrayContaining(["governance.user_delete_authorized", "user.deleted"]));

    await server.close();
  });

  it("rejects password resets when standalone auth is not enabled", async () => {
    const app = await createTestInstance({
      config: createTestConfig(),
      env: {},
      tools: []
    });

    const created = await app.call("users.create", {
      payload: {
        displayLabel: "Jane Reviewer",
        roles: ["user"]
      }
    });
    expect(created.statusCode).toBe(200);
    const administeredUser = created.json() as { id: string };

    const reset = await app.call("users.password.reset", {
      params: { userId: administeredUser.id },
      payload: {
        password: "replacement-password"
      }
    });
    expect(reset.statusCode).toBe(422);
    expect((reset.json() as { error: { message: string } }).error.message).toContain(
      "standalone auth"
    );

    await app.close();
  });
});
