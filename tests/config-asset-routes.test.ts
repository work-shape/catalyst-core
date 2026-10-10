import { builtInModelCapabilities } from "./support/model-gateway";
import type { TestOperationName, TestCallInput } from "./support/operations";

import { createTestInstance, type TestInstance } from "./support/test-instance";
import { afterEach, describe, expect, it } from "vitest";

import {
  ApiKeyAccessTokenExchange,
  CompositeAuthAdapter,
  HmacServiceAccessTokenAuthAdapter,
  HmacSessionTokenAuthAdapter,
  HmacSessionTokenIssuer,
  IdentityResolvingAuthAdapter
} from "@vivd-catalyst/auth";

import {
  AppError,
  StoreBackedAuditRecorder,
  asClientInstanceId,
  type AgentConfig,
  type AgentRuntime,
  type RuntimeCallContext
} from "@vivd-catalyst/core";

import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import type { FakeModelProvider as ModelProvider } from "./support/model-gateway";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import { findConfigAssetAgentValidationIssues } from "../packages/client-assembly/src/assembly-validation";

const servers: TestInstance[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("config asset admin routes", () => {
  it("issues session tokens for embedding hosts", async () => {
    const fixture = await createFixture();

    await expect(mintToken(fixture.server)).resolves.toEqual(expect.any(String));
  });

  it("exchanges an API key for subjectless config access without creating a product user", async () => {
    const fixture = await createFixture({ serviceAccess: true });
    expect(
      await fixture.store.users.listUsers({ clientInstanceId: fixture.clientInstanceId })
    ).toEqual([]);

    const exchange = await fixture.server.call("access_tokens.exchange", {
      headers: { authorization: `Bearer ${fixture.apiKey}` }
    });
    expect(exchange.statusCode).toBe(200);
    expect(exchange.json()).toMatchObject({
      accessToken: expect.any(String),
      expiresAt: expect.any(String)
    });
    const token = (exchange.json() as { accessToken: string }).accessToken;

    const imported = await request(fixture.server, token, "config_assets.replace", {
      payload: {
        baseVersion: null,
        defaultAgentName: "assistant",
        agents: [agentConfig("Released by service principal")],
        skills: []
      }
    });
    expect(imported.statusCode).toBe(200);
    const exported = await request(fixture.server, token, "config_assets.export", {});
    expect(exported.statusCode).toBe(200);

    const humanRoute = await request(fixture.server, token, "conversations.list", {});
    expect(humanRoute.statusCode).toBe(403);
    expect(
      await fixture.store.users.listUsers({ clientInstanceId: fixture.clientInstanceId })
    ).toEqual([]);

    const revisions = await request(fixture.server, token, "config_assets.revisions.list", {
      params: { kind: "agent", name: "assistant" }
    });
    expect(revisions.json().items).toMatchObject([
      {
        actor: {
          principalKind: "service",
          principalDisplayLabel: "Catalyst CLI",
          credentialId: fixture.credentialId
        }
      }
    ]);
    const events = await fixture.store.audit.listAuditEvents({
      clientInstanceId: fixture.clientInstanceId,
      limit: 100
    });
    expect(events.find((event) => event.type === "config_assets.replaced")?.actor).toMatchObject({
      principalKind: "service",
      credentialId: fixture.credentialId
    });
  });

  it("mints a service token and supports CRUD, revisions, revert, and export/import", async () => {
    const fixture = await createFixture();
    const token = await mintToken(fixture.server);

    const created = await request(fixture.server, token, "config_assets.put", {
      params: { kind: "agent", name: "assistant" },
      payload: { config: agentConfig("Original instructions") }
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toEqual({ version: 1, revision: 1 });

    const fetched = await request(fixture.server, token, "config_assets.get", {
      params: { kind: "agent", name: "assistant" }
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toMatchObject({
      kind: "agent",
      name: "assistant",
      revision: 1,
      config: { instructions: "Original instructions" }
    });

    const overview = await request(fixture.server, token, "config_assets.get_overview", {});
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({
      version: 1,
      assets: [{ kind: "agent", name: "assistant", revision: 1 }],
      references: {
        modelProviderIds: ["local"],
        modelBindingIds: [],
        modelBindings: [],
        fastModeModelBindingIds: [],
        reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
        enabledToolNames: ["known.tool", "read_skill"]
      }
    });

    const updated = await request(fixture.server, token, "config_assets.put", {
      params: { kind: "agent", name: "assistant" },
      payload: { config: agentConfig("Changed instructions"), baseVersion: 1 }
    });
    expect(updated.json()).toEqual({ version: 2, revision: 2 });

    const revisionsBeforeRevert = await request(
      fixture.server,
      token,
      "config_assets.revisions.list",
      {
        params: { kind: "agent", name: "assistant" }
      }
    );
    expect(revisionsBeforeRevert.statusCode).toBe(200);
    expect(revisionsBeforeRevert.json().items).toMatchObject([
      {
        revision: 1,
        operation: "create",
        config: { instructions: "Original instructions" }
      },
      {
        revision: 2,
        operation: "update",
        config: { instructions: "Changed instructions" }
      }
    ]);

    const reverted = await request(fixture.server, token, "config_assets.revert", {
      params: { kind: "agent", name: "assistant" },
      payload: { revision: 1, baseVersion: 2 }
    });
    expect(reverted.json()).toEqual({ version: 3, revision: 3 });
    const fetchedAfterRevert = await request(fixture.server, token, "config_assets.get", {
      params: { kind: "agent", name: "assistant" }
    });
    expect(fetchedAfterRevert.json()).toMatchObject({
      revision: 3,
      config: { instructions: "Original instructions" }
    });

    const defaultAgent = await request(fixture.server, token, "config_agents.set_default", {
      payload: { agentName: "assistant", baseVersion: 3 }
    });
    expect(defaultAgent.json()).toEqual({ version: 4 });
    const exported = await request(fixture.server, token, "config_assets.export", {});
    expect(exported.statusCode).toBe(200);
    const bundle = exported.json() as {
      defaultAgentName?: string;
      agents: Array<Record<string, unknown>>;
      skills: Array<Record<string, unknown>>;
    };
    expect(bundle).toMatchObject({
      defaultAgentName: "assistant",
      agents: [{ name: "assistant", instructions: "Original instructions" }],
      skills: []
    });

    const deleted = await request(fixture.server, token, "config_assets.delete", {
      params: { kind: "agent", name: "assistant" },
      payload: { baseVersion: 4 }
    });
    expect(deleted.json()).toEqual({ version: 5 });

    const imported = await request(fixture.server, token, "config_assets.replace", {
      payload: {
        baseVersion: 5,
        defaultAgentName: bundle.defaultAgentName,
        agents: bundle.agents,
        skills: bundle.skills
      }
    });
    expect(imported.json()).toEqual({ version: 6 });
    const roundTripped = await request(fixture.server, token, "config_assets.export", {});
    expect(roundTripped.json()).toMatchObject({
      version: 6,
      defaultAgentName: "assistant",
      agents: bundle.agents,
      skills: bundle.skills
    });

    const events = await fixture.store.audit.listAuditEvents({
      clientInstanceId: fixture.clientInstanceId,
      limit: 100
    });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "config_asset.updated",
        "config_asset.reverted",
        "config_asset.default_agent_set",
        "config_asset.deleted",
        "config_assets.replaced"
      ])
    );
  });

  it("merges provided assets when requested and defaults old clients to mirror mode", async () => {
    const fixture = await createFixture();
    const token = await mintToken(fixture.server);
    const initial = await request(fixture.server, token, "config_assets.replace", {
      payload: {
        baseVersion: null,
        defaultAgentName: "assistant",
        agents: [
          agentConfig("Initial", { name: "assistant" }),
          agentConfig("Remote only", { name: "remote-only" })
        ],
        skills: []
      }
    });
    expect(initial.json()).toEqual({ version: 1 });

    const merged = await request(fixture.server, token, "config_assets.replace", {
      payload: {
        baseVersion: 1,
        mode: "merge",
        agents: [agentConfig("Merged", { name: "assistant" })],
        skills: []
      }
    });
    expect(merged.json()).toEqual({ version: 2 });
    const afterMerge = await request(fixture.server, token, "config_assets.export", {});
    expect(afterMerge.json()).toMatchObject({
      version: 2,
      defaultAgentName: "assistant",
      agents: [
        { name: "assistant", instructions: "Merged" },
        { name: "remote-only", instructions: "Remote only" }
      ]
    });

    const mirrored = await request(fixture.server, token, "config_assets.replace", {
      payload: {
        baseVersion: 2,
        defaultAgentName: "assistant",
        agents: [agentConfig("Mirrored", { name: "assistant" })],
        skills: []
      }
    });
    expect(mirrored.json()).toEqual({ version: 3 });
    const afterMirror = await request(fixture.server, token, "config_assets.export", {});
    expect(afterMirror.json()).toMatchObject({
      version: 3,
      agents: [{ name: "assistant", instructions: "Mirrored" }]
    });
  });

  it.each(["update", "delete", "create"] as const)(
    "reports a remote %s and rejects the whole per-asset import",
    async (operation) => {
      const fixture = await createFixture();
      const token = await mintToken(fixture.server);
      if (operation !== "create") {
        await fixture.store.configAssets.applyConfigAssetMutations({
          clientInstanceId: fixture.clientInstanceId,
          mutations: [
            { type: "upsert", kind: "skill", name: "research", config: skillConfig("Baseline") }
          ]
        });
      }
      await fixture.store.configAssets.applyConfigAssetMutations({
        clientInstanceId: fixture.clientInstanceId,
        actor: { displayLabel: "Remote editor", roles: ["admin"] },
        mutations:
          operation === "delete"
            ? [{ type: "delete", kind: "skill", name: "research" }]
            : [{ type: "upsert", kind: "skill", name: "research", config: skillConfig("Remote") }]
      });
      const response = await request(fixture.server, token, "config_assets.replace", {
        payload: {
          baseVersion: null,
          mode: "merge",
          baseRevisions: { "skill:research": operation === "create" ? null : 1, "skill:new": null },
          agents: [],
          skills: [skillConfig("Local"), { ...skillConfig("New"), name: "new" }]
        }
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: {
          details: {
            conflicts: [
              {
                kind: "skill",
                name: "research",
                currentRevision: operation === "create" ? 1 : 2,
                actorLabel: "Remote editor",
                timestamp: expect.any(String),
                operation
              }
            ]
          }
        }
      });
      expect(
        await fixture.store.configAssets.getConfigAsset({
          clientInstanceId: fixture.clientInstanceId,
          kind: "skill",
          name: "new"
        })
      ).toBeUndefined();
    }
  );

  it("advertises guards and preserves untouched remote assets and default agent", async () => {
    const fixture = await createFixture();
    const token = await mintToken(fixture.server);
    await fixture.store.configAssets.applyConfigAssetMutations({
      clientInstanceId: fixture.clientInstanceId,
      mutations: [
        { type: "upsert", kind: "agent", name: "assistant", config: agentConfig("Remote") },
        { type: "setDefaultAgent", agentName: "assistant" },
        { type: "upsert", kind: "skill", name: "research", config: skillConfig("Remote") }
      ]
    });
    const exported = await request(fixture.server, token, "config_assets.export", {});
    expect(exported.json()).toMatchObject({
      perAssetConcurrency: true,
      revisions: { "agent:assistant": 1, "skill:research": 1 }
    });
    const response = await request(fixture.server, token, "config_assets.replace", {
      payload: {
        baseVersion: 0,
        mode: "merge",
        baseRevisions: { "skill:new": null },
        agents: [],
        skills: [{ ...skillConfig("New"), name: "new" }]
      }
    });
    expect(response.statusCode).toBe(200);
    expect(
      await fixture.store.configAssets.getConfigAsset({
        clientInstanceId: fixture.clientInstanceId,
        kind: "skill",
        name: "research"
      })
    ).toMatchObject({ revision: 1, config: skillConfig("Remote") });
    const staleDefault = await request(fixture.server, token, "config_assets.replace", {
      payload: {
        baseVersion: null,
        mode: "merge",
        baseRevisions: {},
        baseDefaultAgentName: null,
        agents: [],
        skills: []
      }
    });
    expect(staleDefault.statusCode).toBe(409);
    const oldRequest = await request(fixture.server, token, "config_assets.replace", {
      payload: {
        baseVersion: 0,
        mode: "merge",
        agents: [],
        skills: []
      }
    });
    expect(oldRequest.statusCode).toBe(409);
    expect(oldRequest.json()).toMatchObject({
      error: { details: { currentVersion: 2, baseVersion: 0 } }
    });
  });

  it("returns 409 for a stale base version", async () => {
    const fixture = await createFixture();
    const token = await mintToken(fixture.server);
    await request(fixture.server, token, "config_assets.put", {
      params: { kind: "agent", name: "assistant" },
      payload: { config: agentConfig("Current") }
    });

    const stale = await request(fixture.server, token, "config_assets.put", {
      params: { kind: "agent", name: "assistant" },
      payload: { config: agentConfig("Stale"), baseVersion: 0 }
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: "CONFLICT" } });
  });

  it("rejects broken skill references without advancing the config version", async () => {
    const fixture = await createFixture();
    const token = await mintToken(fixture.server);
    const skill = await request(fixture.server, token, "config_assets.put", {
      params: { kind: "skill", name: "review" },
      payload: {
        config: {
          name: "review",
          title: "Review",
          description: "Review the request",
          content: "# Review"
        }
      }
    });
    expect(skill.json()).toEqual({ version: 1, revision: 1 });
    const agent = await request(fixture.server, token, "config_assets.put", {
      params: { kind: "agent", name: "assistant" },
      payload: {
        baseVersion: 1,
        config: agentConfig("Uses the review skill", {
          toolNames: ["read_skill"],
          skillNames: ["review"]
        })
      }
    });
    expect(agent.json()).toEqual({ version: 2, revision: 1 });

    const referencedDelete = await request(fixture.server, token, "config_assets.delete", {
      params: { kind: "skill", name: "review" },
      payload: { baseVersion: 2 }
    });
    expect(referencedDelete.statusCode).toBe(422);
    expect(referencedDelete.json()).toMatchObject({
      error: {
        code: "VALIDATION_FAILED",
        details: {
          issues: [{ message: "Agent 'assistant' references missing skill 'review'" }]
        }
      }
    });

    const missingReadSkill = await request(fixture.server, token, "config_assets.put", {
      params: { kind: "agent", name: "assistant" },
      payload: {
        baseVersion: 2,
        config: agentConfig("Uses the review skill", { skillNames: ["review"] })
      }
    });
    expect(missingReadSkill.statusCode).toBe(422);
    expect(missingReadSkill.json()).toMatchObject({
      error: {
        code: "VALIDATION_FAILED",
        details: {
          issues: [
            {
              message: "Agent 'assistant' references skills but does not allow 'read_skill'"
            }
          ]
        }
      }
    });

    const overview = await request(fixture.server, token, "config_assets.get_overview", {});
    expect(overview.json()).toMatchObject({ version: 2 });
  });

  it("rejects chat-scoped tokens and service users without write permission", async () => {
    const fixture = await createFixture();
    const chatToken = await mintToken(fixture.server, {
      scopes: ["me:read"],
      permissions: ["config_assets.write"],
      delegatedActor: undefined
    });
    const missingScope = await request(fixture.server, chatToken, "config_assets.put", {
      params: { kind: "agent", name: "assistant" },
      payload: { config: agentConfig("Denied") }
    });
    expect(missingScope.statusCode).toBe(403);

    const readOnlyToken = await mintToken(fixture.server, {
      scopes: ["config_assets:read", "config_assets:write"],
      permissions: ["config_assets.read"]
    });
    const missingPermission = await request(fixture.server, readOnlyToken, "config_assets.put", {
      params: { kind: "agent", name: "assistant" },
      payload: { config: agentConfig("Denied") }
    });
    expect(missingPermission.statusCode).toBe(403);
    expect(missingPermission.json()).toMatchObject({
      error: { code: "FORBIDDEN" }
    });
  });

  it("enforces editable agent fields on interactive writes", async () => {
    const fixture = await createFixture({
      agentConfiguration: {
        enabled: true,
        editableAgentFields: ["displayName"]
      }
    });
    const token = await mintToken(fixture.server);
    const initial = agentConfig("Release-managed instructions");
    const imported = await request(fixture.server, token, "config_assets.replace", {
      payload: {
        baseVersion: null,
        defaultAgentName: "assistant",
        agents: [initial],
        skills: []
      }
    });
    expect(imported.statusCode).toBe(200);

    const displayNameUpdate = await request(fixture.server, token, "config_assets.put", {
      params: { kind: "agent", name: "assistant" },
      payload: {
        baseVersion: 1,
        config: { ...initial, displayName: "Renamed Assistant" }
      }
    });
    expect(displayNameUpdate.statusCode).toBe(200);

    const protectedUpdate = await request(fixture.server, token, "config_assets.put", {
      params: { kind: "agent", name: "assistant" },
      payload: {
        baseVersion: 2,
        config: {
          ...initial,
          displayName: "Renamed Assistant",
          instructions: "Changed interactively"
        }
      }
    });
    expect(protectedUpdate.statusCode).toBe(403);
    expect(protectedUpdate.json()).toMatchObject({
      error: {
        code: "FORBIDDEN",
        message: "Interactive changes are not allowed for agent field: instructions"
      }
    });
  });

  it("requires agent_models.manage for the agent model settings on interactive writes", async () => {
    // No model setting is listed as editable: the permission alone decides.
    const fixture = await createFixture({
      modelBindings: true,
      agentConfiguration: { enabled: true, editableAgentFields: ["displayName"] }
    });
    const initial = { ...boundAgentConfig("fast"), reasoningEffort: "low" };
    const releaseToken = await mintToken(fixture.server);
    const imported = await request(fixture.server, releaseToken, "config_assets.replace", {
      payload: { baseVersion: null, defaultAgentName: "assistant", agents: [initial], skills: [] }
    });
    expect(imported.statusCode).toBe(200);

    const interactive = { scopes: ["config_assets:read", "config_assets:write"] };
    const adminToken = await mintToken(fixture.server, {
      ...interactive,
      roles: ["admin"],
      permissions: []
    });
    const grantedToken = await mintToken(fixture.server, {
      ...interactive,
      roles: ["user"],
      permissions: ["config_assets.read", "config_assets.write", "agent_models.manage"]
    });
    const superadminToken = await mintToken(fixture.server, {
      ...interactive,
      roles: ["superadmin"],
      permissions: []
    });
    const changes = {
      modelBindingId: { modelBindingId: "other" },
      reasoningEffort: { reasoningEffort: "high" },
      fastMode: { fastMode: true },
      userSelectableModelBindingIds: { userSelectableModelBindingIds: ["other"] }
    };
    const put = (token: string, config: Record<string, unknown>) =>
      request(fixture.server, token, "config_assets.put", {
        params: { kind: "agent", name: "assistant" },
        payload: { config }
      });

    for (const [field, change] of Object.entries(changes)) {
      const denied = await put(adminToken, { ...initial, ...change });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({
        error: {
          code: "FORBIDDEN",
          message: `Changing agent model settings (${field}) requires 'agent_models.manage' permission`
        }
      });
    }
    // The admin keeps the fields that the edit policy allows.
    expect((await put(adminToken, { ...initial, displayName: "Renamed" })).statusCode).toBe(200);

    for (const token of [grantedToken, superadminToken]) {
      for (const change of Object.values(changes)) {
        expect(
          (await put(token, { ...initial, displayName: "Renamed", ...change })).statusCode
        ).toBe(200);
      }
      expect((await put(token, { ...initial, displayName: "Renamed" })).statusCode).toBe(200);
    }

    // Restoring a revision with other model settings is the same change.
    const fastNow = await put(superadminToken, {
      ...initial,
      displayName: "Renamed",
      fastMode: true
    });
    expect(fastNow.statusCode).toBe(200);
    const revert = (token: string) =>
      request(fixture.server, token, "config_assets.revert", {
        params: { kind: "agent", name: "assistant" },
        payload: { revision: 1 }
      });
    expect((await revert(adminToken)).statusCode).toBe(403);
    expect((await revert(superadminToken)).statusCode).toBe(200);

    // Release sync is unchanged: the service principal has no agent_models.manage.
    const exported = await request(fixture.server, releaseToken, "config_assets.export", {});
    const pushed = await request(fixture.server, releaseToken, "config_assets.replace", {
      payload: {
        baseVersion: exported.json().version,
        defaultAgentName: "assistant",
        agents: [{ ...initial, modelBindingId: "fast", reasoningEffort: "xhigh", fastMode: true }],
        skills: []
      }
    });
    expect(pushed.statusCode).toBe(200);
  });

  it("accepts fast mode only on a supporting binding and clears it on a binding switch", async () => {
    const fixture = await createFixture({ modelBindings: true });
    const token = await mintToken(fixture.server, {
      roles: ["superadmin"],
      permissions: ["config_assets.release"]
    });
    const put = (config: Record<string, unknown>) =>
      request(fixture.server, token, "config_assets.put", {
        params: { kind: "agent", name: "assistant" },
        payload: { config }
      });
    const stored = async () =>
      (
        await request(fixture.server, token, "config_assets.get", {
          params: { kind: "agent", name: "assistant" }
        })
      ).json().config as Record<string, unknown>;

    const overview = await request(fixture.server, token, "config_assets.get_overview", {});
    expect(overview.json().references.fastModeModelBindingIds).toEqual(["fast"]);

    expect((await put({ ...boundAgentConfig("fast"), fastMode: true })).statusCode).toBe(200);
    expect(await stored()).toMatchObject({ modelBindingId: "fast", fastMode: true });

    // Switching to a binding without support clears the flag instead of failing.
    expect((await put({ ...boundAgentConfig("plain"), fastMode: true })).statusCode).toBe(200);
    expect(await stored()).toMatchObject({ modelBindingId: "plain" });
    expect(await stored()).not.toHaveProperty("fastMode");

    // Turning it on for the unsupported binding is a validation error.
    const unsupported = await put({ ...boundAgentConfig("plain"), fastMode: true });
    expect(unsupported.statusCode).toBe(422);
    expect(JSON.stringify(unsupported.json())).toContain(
      "Agent 'assistant' enables fastMode, but model binding 'plain' does not support fast mode"
    );

    const exported = await request(fixture.server, token, "config_assets.export", {});
    for (const agent of [
      { ...boundAgentConfig("plain"), fastMode: true },
      { ...agentConfig("No binding"), fastMode: true }
    ]) {
      const pushed = await request(fixture.server, token, "config_assets.replace", {
        payload: {
          baseVersion: exported.json().version,
          defaultAgentName: "assistant",
          agents: [agent],
          skills: []
        }
      });
      expect(pushed.statusCode).toBe(422);
      expect(JSON.stringify(pushed.json())).toContain("enables fastMode");
    }
  });

  it("saves a model setting on a release-controlled agent whose stored keys are ordered differently", async () => {
    // Nothing is editable through the edit policy; the permission alone allows model settings.
    const fixture = await createFixture({
      modelBindings: true,
      agentConfiguration: { enabled: true, editableAgentFields: [] }
    });
    // A JSON store may return object keys in another order than the client sends them.
    await fixture.store.configAssets.applyConfigAssetMutations({
      clientInstanceId: fixture.clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "agent",
          name: "assistant",
          config: {
            ...boundAgentConfig("plain"),
            description: { de: "Assistentin für Unterlagen.", en: "Assistant for documents." },
            welcomeMessage: { de: "Wie kann ich helfen?", en: "How can I help?" },
            initialPrompts: [
              { prompt: { de: "Prüfe.", en: "Check." }, title: { de: "Prüfung", en: "Check" } }
            ]
          }
        },
        { type: "setDefaultAgent", agentName: "assistant" }
      ]
    });
    const sent = {
      ...boundAgentConfig("plain"),
      description: { en: "Assistant for documents.", de: "Assistentin für Unterlagen." },
      welcomeMessage: { en: "How can I help?", de: "Wie kann ich helfen?" },
      initialPrompts: [
        { title: { en: "Check", de: "Prüfung" }, prompt: { en: "Check.", de: "Prüfe." } }
      ]
    };
    const token = await mintToken(fixture.server, {
      scopes: ["config_assets:read", "config_assets:write"],
      roles: ["superadmin"],
      permissions: []
    });
    const put = (config: Record<string, unknown>) =>
      request(fixture.server, token, "config_assets.put", {
        params: { kind: "agent", name: "assistant" },
        payload: { config }
      });

    for (const change of [
      { userSelectableModelBindingIds: ["other"] },
      { modelBindingId: "fast", fastMode: true },
      { reasoningEffort: "high" }
    ]) {
      expect((await put({ ...sent, ...change })).statusCode).toBe(200);
    }
    // A real change to a protected field is still rejected.
    const denied = await put({ ...sent, welcomeMessage: { en: "Hi", de: "Hallo" } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toBe(
      "Interactive changes are not allowed for agent field: welcomeMessage"
    );
  });

  it("accepts any agent-selectable binding as one of an agent's user-selectable models", async () => {
    const fixture = await createFixture({ modelBindings: true });
    const token = await mintToken(fixture.server, {
      roles: ["superadmin"],
      permissions: ["config_assets.release"]
    });
    const put = (config: Record<string, unknown>) =>
      request(fixture.server, token, "config_assets.put", {
        params: { kind: "agent", name: "assistant" },
        payload: { config }
      });
    const push = async (agent: Record<string, unknown>) =>
      request(fixture.server, token, "config_assets.replace", {
        payload: {
          baseVersion: (await request(fixture.server, token, "config_assets.export", {})).json()
            .version,
          defaultAgentName: "assistant",
          agents: [agent],
          skills: []
        }
      });
    const stored = async () =>
      (
        await request(fixture.server, token, "config_assets.get", {
          params: { kind: "agent", name: "assistant" }
        })
      ).json().config as Record<string, unknown>;

    const overview = await request(fixture.server, token, "config_assets.get_overview", {});
    // The eligible bindings are the ones an agent may use; `userSelectable` is not consulted.
    expect(overview.json().references.modelBindingIds).toEqual(["plain", "other", "fast"]);

    const agent = boundAgentConfig("plain");
    expect((await put({ ...agent, userSelectableModelBindingIds: ["other"] })).statusCode).toBe(
      200
    );
    expect(await stored()).toMatchObject({ userSelectableModelBindingIds: ["other"] });

    expect(
      (await put({ ...agent, userSelectableModelBindingIds: ["other", "fast"] })).statusCode
    ).toBe(200);

    // A binding agents may not use and an unknown binding are both rejected on save.
    for (const bindingId of ["internal", "missing"]) {
      for (const send of [put, push]) {
        const rejected = await send({ ...agent, userSelectableModelBindingIds: [bindingId] });
        expect(rejected.statusCode).toBe(422);
        expect(JSON.stringify(rejected.json())).toContain(
          `Agent 'assistant' lists missing model binding '${bindingId}' in userSelectableModelBindingIds`
        );
      }
    }
    expect((await push({ ...agent, userSelectableModelBindingIds: ["other"] })).statusCode).toBe(
      200
    );

    // An effort is set per offered model: its key must be in the list and its value an effort.
    const offered = { ...agent, userSelectableModelBindingIds: ["other"] };
    expect((await put({ ...offered, modelReasoningEfforts: { other: "low" } })).statusCode).toBe(
      200
    );
    expect(await stored()).toMatchObject({ modelReasoningEfforts: { other: "low" } });
    for (const send of [put, push]) {
      const unlisted = await send({ ...offered, modelReasoningEfforts: { fast: "low" } });
      expect(unlisted.statusCode).toBe(422);
      expect(JSON.stringify(unlisted.json())).toContain(
        "Agent 'assistant' sets modelReasoningEfforts for 'fast', which is not in its userSelectableModelBindingIds"
      );
      expect(
        (await send({ ...offered, modelReasoningEfforts: { other: "extreme" } })).statusCode
      ).toBe(422);
    }
    // It is a model setting: an admin without agent_models.manage may not change it.
    const adminToken = await mintToken(fixture.server, {
      scopes: ["config_assets:read", "config_assets:write"],
      roles: ["admin"],
      permissions: []
    });
    const denied = await request(fixture.server, adminToken, "config_assets.put", {
      params: { kind: "agent", name: "assistant" },
      payload: { config: { ...offered, modelReasoningEfforts: { other: "high" } } }
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toBe(
      "Changing agent model settings (modelReasoningEfforts) requires 'agent_models.manage' permission"
    );

    // A stored id that is no longer eligible does not block later edits of the agent.
    await fixture.store.configAssets.applyConfigAssetMutations({
      clientInstanceId: fixture.clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "agent",
          name: "assistant",
          config: { ...agent, userSelectableModelBindingIds: ["retired"] }
        }
      ]
    });
    const renamed = {
      ...agent,
      displayName: "Renamed",
      userSelectableModelBindingIds: ["retired"]
    };
    expect((await put(renamed)).statusCode).toBe(200);
    expect((await push({ ...renamed, displayName: "Pushed" })).statusCode).toBe(200);
    expect(await stored()).toMatchObject({
      displayName: "Pushed",
      userSelectableModelBindingIds: ["retired"]
    });
  });

  it("lets config admins set agent availability and keeps the default agent open", async () => {
    const fixture = await createFixture();
    const token = await mintToken(fixture.server);
    const { clientInstanceId, store } = fixture;
    const owner = await store.users.createUser({ clientInstanceId, displayLabel: "Owner" });
    const shared = await store.workspaces.createWorkspace({
      clientInstanceId,
      kind: "shared",
      name: "KAI",
      visibility: "private",
      creatorUserId: owner.id
    });
    const personal = await store.workspaces.ensurePersonalWorkspace({
      clientInstanceId,
      userId: owner.id
    });
    const foreignInstanceId = asClientInstanceId("another-instance");
    const foreign = await store.workspaces.createWorkspace({
      clientInstanceId: foreignInstanceId,
      kind: "shared",
      name: "Foreign",
      creatorUserId: (
        await store.users.createUser({
          clientInstanceId: foreignInstanceId,
          displayLabel: "Foreign"
        })
      ).id
    });
    const imported = await request(fixture.server, token, "config_assets.replace", {
      payload: {
        baseVersion: null,
        defaultAgentName: "assistant",
        agents: [agentConfig("Default"), agentConfig("KAI", { name: "kai" })],
        skills: [skillConfig("Research")]
      }
    });
    expect(imported.json()).toEqual({ version: 1 });
    const everywhere = { mode: "all", personalWorkspaces: false, collaborationWorkspaceIds: [] };
    const readAssets = async () =>
      (
        (await request(fixture.server, token, "config_assets.get_overview", {})).json() as {
          assets: Array<{ kind: string; name: string; availability?: unknown }>;
        }
      ).assets.map(({ kind, name, availability }) => ({ kind, name, availability }));
    expect(await readAssets()).toEqual([
      { kind: "agent", name: "assistant", availability: everywhere },
      { kind: "agent", name: "kai", availability: everywhere },
      { kind: "skill", name: "research", availability: undefined }
    ]);

    const workspaces = await request(fixture.server, token, "instance.workspaces.list", {});
    expect(workspaces.statusCode).toBe(200);
    expect(workspaces.json().items).toEqual([
      { id: shared.id, name: "KAI", createdAt: expect.any(String) }
    ]);

    const setKai = (payload: unknown, name = "kai") =>
      request(fixture.server, token, "config_agents.set_availability", {
        params: { name: name },
        payload
      });
    const selected = await setKai({
      mode: "selected",
      personalWorkspaces: true,
      collaborationWorkspaceIds: [shared.id]
    });
    expect(selected.statusCode).toBe(200);
    expect(selected.json()).toEqual({
      mode: "selected",
      personalWorkspaces: true,
      collaborationWorkspaceIds: [shared.id]
    });
    expect((await readAssets())[1]).toEqual({
      kind: "agent",
      name: "kai",
      availability: selected.json()
    });
    expect(
      (await store.audit.listAuditEvents({ clientInstanceId })).some(
        (event) => event.type === "config_asset.availability_set" && event.metadata?.name === "kai"
      )
    ).toBe(true);

    // Workspace ids must be Shared Workspaces of this instance.
    for (const collaborationWorkspaceId of [personal.id, foreign.id, "cws_missing"]) {
      const rejected = await setKai({
        mode: "selected",
        collaborationWorkspaceIds: [collaborationWorkspaceId]
      });
      expect(rejected.statusCode).toBe(422);
      expect(rejected.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    }
    expect((await readAssets())[1]?.availability).toEqual(selected.json());

    const unknownAgent = await setKai({ mode: "all" }, "missing");
    expect(unknownAgent.statusCode).toBe(404);
    const invalidMode = await setKai({ mode: "some" });
    expect(invalidMode.statusCode).toBe(422);

    // The instance default agent must stay available everywhere, in both directions.
    const hideDefault = await setKai({ mode: "selected", personalWorkspaces: true }, "assistant");
    expect(hideDefault.statusCode).toBe(422);
    expect(hideDefault.json()).toMatchObject({
      error: {
        code: "VALIDATION_FAILED",
        message: "Default agent 'assistant' must be available in all workspaces"
      }
    });
    const defaultToRestricted = await request(fixture.server, token, "config_agents.set_default", {
      payload: { agentName: "kai" }
    });
    expect(defaultToRestricted.statusCode).toBe(422);
    expect(defaultToRestricted.json()).toMatchObject({
      error: { message: "Default agent 'kai' must be available in all workspaces" }
    });
    const pushedDefault = await request(fixture.server, token, "config_assets.replace", {
      payload: { baseVersion: null, mode: "merge", defaultAgentName: "kai", agents: [], skills: [] }
    });
    expect(pushedDefault.statusCode).toBe(422);
    expect(
      (await request(fixture.server, token, "config_assets.get_overview", {})).json()
    ).toMatchObject({ version: 1, defaultAgentName: "assistant" });

    // `all` clears the selection.
    const reopened = await setKai({
      mode: "all",
      personalWorkspaces: true,
      collaborationWorkspaceIds: [shared.id]
    });
    expect(reopened.json()).toEqual(everywhere);
  });

  it("requires the config write permission and scope for availability administration", async () => {
    const fixture = await createFixture();
    const token = await mintToken(fixture.server);
    await request(fixture.server, token, "config_assets.replace", {
      payload: {
        baseVersion: null,
        defaultAgentName: "assistant",
        agents: [agentConfig("Default"), agentConfig("KAI", { name: "kai" })],
        skills: []
      }
    });
    const denied = [
      await mintToken(fixture.server, {
        scopes: ["config_assets:read", "config_assets:write"],
        permissions: ["config_assets.read", "config_assets.release"]
      }),
      await mintToken(fixture.server, {
        scopes: ["config_assets:read", "config_assets:release"],
        permissions: ["config_assets.read", "config_assets.write", "config_assets.release"]
      })
    ];
    for (const deniedToken of denied) {
      const set = await request(fixture.server, deniedToken, "config_agents.set_availability", {
        params: { name: "kai" },
        payload: { mode: "selected" }
      });
      expect(set.statusCode).toBe(403);
      const list = await request(fixture.server, deniedToken, "instance.workspaces.list", {});
      expect(list.statusCode).toBe(403);
    }
    const unauthenticated = await fixture.server.call("config_agents.set_availability", {
      params: { name: "kai" },
      payload: { mode: "selected" }
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(
      (
        await fixture.store.configAssets.listAgentAvailability({
          clientInstanceId: fixture.clientInstanceId
        })
      ).get("kai")?.mode
    ).toBe("all");

    const disabled = await createFixture({ agentConfiguration: { enabled: false } });
    const disabledToken = await mintToken(disabled.server);
    const whileDisabled = await request(
      disabled.server,
      disabledToken,
      "config_agents.set_availability",
      { params: { name: "kai" }, payload: { mode: "all" } }
    );
    // The asset management module is off: the operation does not exist on this instance.
    expect(whileDisabled.statusCode).toBe(404);
    expect(whileDisabled.json()).toMatchObject({
      error: { details: { reason: "module_off", module: "assetManagement" } }
    });
  });

  it("hides the agents of a push that renames a restricted agent and reports them", async () => {
    const fixture = await createFixture();
    const token = await mintToken(fixture.server);
    const push = (payload: Record<string, unknown>) =>
      request(fixture.server, token, "config_assets.replace", {
        payload: { baseVersion: null, mode: "merge", skills: [], ...payload }
      });
    await push({
      defaultAgentName: "assistant",
      agents: [agentConfig("Default"), agentConfig("KAI", { name: "kai" })]
    });
    await fixture.store.configAssets.setAgentAvailability({
      clientInstanceId: fixture.clientInstanceId,
      agentName: "kai",
      availability: { mode: "selected", personalWorkspaces: true, collaborationWorkspaceIds: [] }
    });

    // A push that only adds an agent keeps the default.
    const added = await push({ agents: [agentConfig("Open", { name: "open" })] });
    expect(added.json()).toEqual({ version: 2 });

    const renamed = await push({
      agents: [agentConfig("KAI", { name: "kai-tax" }), agentConfig("Default v2")],
      deleteAssets: [{ kind: "agent", name: "kai" }]
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toEqual({ version: 3, hiddenAgentNames: ["kai-tax"] });
    const availability = await fixture.store.configAssets.listAgentAvailability({
      clientInstanceId: fixture.clientInstanceId
    });
    expect(availability.get("kai-tax")).toEqual({
      mode: "selected",
      personalWorkspaces: false,
      collaborationWorkspaceIds: []
    });
    expect(availability.has("kai")).toBe(false);
    expect(availability.get("assistant")?.mode).toBe("all");
    expect(availability.get("open")?.mode).toBe("all");

    // A mirror push that drops a restricted agent is the same rename.
    await fixture.store.configAssets.setAgentAvailability({
      clientInstanceId: fixture.clientInstanceId,
      agentName: "kai-tax",
      availability: { mode: "selected", personalWorkspaces: true, collaborationWorkspaceIds: [] }
    });
    const mirrored = await push({
      mode: "mirror",
      defaultAgentName: "assistant",
      agents: [
        agentConfig("Default v2"),
        agentConfig("Open", { name: "open" }),
        agentConfig("KAI", { name: "kai-law" })
      ]
    });
    expect(mirrored.json()).toEqual({ version: 4, hiddenAgentNames: ["kai-law"] });
  });

  it("requires the release-sync permission for bundle replacement", async () => {
    const fixture = await createFixture();
    const interactiveToken = await mintToken(fixture.server, {
      scopes: ["config_assets:read", "config_assets:write"],
      permissions: ["config_assets.read", "config_assets.write"]
    });
    const response = await request(fixture.server, interactiveToken, "config_assets.replace", {
      payload: { baseVersion: null, agents: [], skills: [] }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  it("requires pricing for every non-deterministic agent model when spend budgets are enabled", async () => {
    const fixture = await createFixture({ pricingCoverage: true });
    const token = await mintToken(fixture.server);
    const unpriced = await request(fixture.server, token, "config_assets.put", {
      params: { kind: "agent", name: "assistant" },
      payload: {
        config: agentConfig("Unpriced", { modelProviderId: "provider-b" })
      }
    });

    expect(unpriced.statusCode).toBe(422);
    expect(unpriced.json()).toMatchObject({
      error: {
        code: "VALIDATION_FAILED",
        message: expect.stringContaining("pricing")
      }
    });

    const priced = await request(fixture.server, token, "config_assets.put", {
      params: { kind: "agent", name: "assistant" },
      payload: {
        config: agentConfig("Priced", { modelProviderId: "provider-a" })
      }
    });
    expect(priced.statusCode).toBe(200);
  });

  it("rejects web_search when materialization or customer pricing is missing", async () => {
    const disabledFixture = await createFixture({ webSearch: "disabled" });
    const disabledToken = await mintToken(disabledFixture.server);
    const disabled = await request(disabledFixture.server, disabledToken, "config_assets.put", {
      params: { kind: "agent", name: "assistant" },
      payload: {
        config: agentConfig("Search", {
          modelProviderId: "openai",
          toolNames: ["web_search"]
        })
      }
    });
    expect(disabled.statusCode).toBe(422);
    expect(disabled.json()).toMatchObject({
      error: {
        code: "VALIDATION_FAILED",
        details: {
          issues: [
            {
              message: "Agent 'assistant' references web_search but web access is disabled"
            }
          ]
        }
      }
    });

    const enabledFixture = await createFixture({ webSearch: "enabled" });
    const enabledToken = await mintToken(enabledFixture.server);
    const enabled = await request(enabledFixture.server, enabledToken, "config_assets.put", {
      params: { kind: "agent", name: "assistant" },
      payload: {
        config: agentConfig("Search", {
          modelProviderId: "openai",
          toolNames: ["web_search"]
        })
      }
    });
    expect(enabled.statusCode).toBe(422);
    expect(enabled.json()).toMatchObject({
      error: {
        code: "VALIDATION_FAILED",
        details: {
          issues: [
            {
              message:
                "Agent 'assistant' references web_search but customer pricing is missing for openai/gpt-test"
            }
          ]
        }
      }
    });

    const pricedFixture = await createFixture({ webSearch: "enabled", webSearchPricing: true });
    const pricedToken = await mintToken(pricedFixture.server);
    const priced = await request(pricedFixture.server, pricedToken, "config_assets.put", {
      params: { kind: "agent", name: "assistant" },
      payload: {
        config: agentConfig("Search", {
          modelProviderId: "openai",
          toolNames: ["web_search"]
        })
      }
    });
    expect(priced.statusCode).toBe(200);
  });

  it.each([
    ["unknown tool", agentConfig("Invalid", { toolNames: ["missing.tool"] })],
    ["unknown skill", agentConfig("Invalid", { skillNames: ["missing-skill"] })],
    ["unknown model provider", agentConfig("Invalid", { modelProviderId: "missing-provider" })]
  ])("rejects an agent with an %s reference", async (_label, config) => {
    const fixture = await createFixture();
    const token = await mintToken(fixture.server);
    const response = await request(fixture.server, token, "config_assets.put", {
      params: { kind: "agent", name: "assistant" },
      payload: { config }
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: "VALIDATION_FAILED" }
    });
  });

  it("rejects duplicate import names and a missing default agent", async () => {
    const fixture = await createFixture();
    const token = await mintToken(fixture.server);
    const duplicate = await request(fixture.server, token, "config_assets.replace", {
      payload: {
        baseVersion: null,
        agents: [agentConfig("One"), agentConfig("Two")],
        skills: []
      }
    });
    expect(duplicate.statusCode).toBe(422);
    expect(duplicate.json()).toMatchObject({
      error: { code: "VALIDATION_FAILED" }
    });

    const missingDefault = await request(fixture.server, token, "config_assets.replace", {
      payload: {
        baseVersion: null,
        defaultAgentName: "missing",
        agents: [agentConfig("Valid")],
        skills: []
      }
    });
    expect(missingDefault.statusCode).toBe(422);
    expect(missingDefault.json()).toMatchObject({
      error: { code: "VALIDATION_FAILED" }
    });
  });
});

async function createFixture(
  input: {
    agentConfiguration?: Record<string, unknown>;
    pricingCoverage?: boolean;
    webSearch?: "disabled" | "enabled";
    webSearchPricing?: boolean;
    serviceAccess?: boolean;
    modelBindings?: boolean;
  } = {}
) {
  const clientInstanceId = asClientInstanceId("config-routes-test");
  const store = (await createTestInstance()).stores;
  const modelProviders = input.pricingCoverage
    ? [
        {
          id: "provider-a",
          type: "openai-compatible" as const,
          model: "model-a"
        },
        {
          id: "provider-b",
          type: "openai-compatible" as const,
          model: "model-b"
        }
      ]
    : input.webSearch
      ? [
          {
            id: "openai",
            type: "openai-compatible" as const,
            api: "responses" as const,
            model: "gpt-test"
          }
        ]
      : [{ id: "local", type: "deterministic" as const, model: "local" }];
  const config = parseClientInstanceConfig({
    version: 1,
    clientInstance: {
      id: clientInstanceId,
      displayName: "Config routes test",
      environment: "development"
    },
    auth: {},
    administration: {
      agentConfiguration: {
        enabled: true,
        editableAgentFields: [
          "displayName",
          "instructions",
          "modelBindingId",
          "reasoningEffort",
          "toolNames",
          "skillNames",
          "initialPrompts"
        ],
        allowAgentCreation: true,
        allowAgentDeletion: true,
        allowDefaultAgentChange: true,
        allowSkillEditing: true,
        ...input.agentConfiguration
      }
    },
    infrastructure: {
      models: Object.fromEntries(
        modelProviders.map(({ id, type, ...settings }) => [
          id,
          {
            provider: type,
            ...(type === "openai-compatible" ? { region: "global" } : {}),
            ...settings
          }
        ])
      )
    },
    ...(input.modelBindings
      ? {
          modelBindings: [
            { id: "plain", providerId: "local" },
            { id: "other", providerId: "local" },
            { id: "internal", providerId: "local", agentSelectable: false },
            { id: "fast", providerId: "local", supportsFastMode: true }
          ],
          usage: {
            costs: {
              customer: {
                id: "test-customer",
                version: "1",
                currency: "EUR",
                models: [
                  {
                    providerId: "local",
                    model: "local",
                    uncachedInputPricePerMillionTokens: 1,
                    cachedInputPricePerMillionTokens: 1,
                    outputPricePerMillionTokens: 2,
                    fast: {
                      uncachedInputPricePerMillionTokens: 2,
                      cachedInputPricePerMillionTokens: 2,
                      outputPricePerMillionTokens: 4
                    }
                  }
                ]
              }
            }
          }
        }
      : {}),
    ...(input.pricingCoverage
      ? {
          usage: {
            budget: { monthlySpendLimit: 100 },
            costs: {
              customer: {
                id: "test-customer",
                version: "1",
                currency: "EUR",
                models: [
                  {
                    providerId: "provider-a",
                    model: "model-a",
                    uncachedInputPricePerMillionTokens: 1,
                    cachedInputPricePerMillionTokens: 1,
                    outputPricePerMillionTokens: 2
                  }
                ]
              }
            }
          }
        }
      : {}),
    ...(input.webSearch
      ? {
          webAccess: {
            enabled: input.webSearch === "enabled",
            search: { enabled: input.webSearch === "enabled" }
          },
          ...(input.webSearchPricing
            ? {
                usage: {
                  costs: {
                    customer: {
                      id: "test-customer",
                      version: "1",
                      currency: "EUR",
                      models: [],
                      webSearch: [{ providerId: "openai", pricePerCall: 0.01 }]
                    }
                  }
                }
              }
            : {})
        }
      : {}),
    tools: [
      { name: "known.tool", enabled: true },
      { name: "read_skill", enabled: true },
      ...(input.webSearch ? [{ name: "web_search", enabled: true }] : [])
    ]
  });
  const authOptions = {
    secret: "a-development-session-token-secret",
    clientInstanceId,
    issuer: "config-routes-test",
    ttlSeconds: 900
  };
  const issuer = new HmacSessionTokenIssuer(authOptions);
  const servicePrincipal = input.serviceAccess
    ? await store.apiAccess.createServicePrincipal({
        clientInstanceId,
        displayLabel: "Catalyst CLI",
        permissions: ["config_assets.read", "config_assets.release"]
      })
    : undefined;
  const createdCredential = servicePrincipal
    ? await store.apiAccess.createApiCredential({
        clientInstanceId,
        servicePrincipalId: servicePrincipal.id,
        name: "test key",
        scopes: ["config_assets:read", "config_assets:release"]
      })
    : undefined;
  const serviceAccessOptions = input.serviceAccess
    ? {
        secret: "a-development-service-access-secret-with-enough-length",
        clientInstanceId,
        apiAccessStore: store.apiAccess
      }
    : undefined;
  const auditRecorder = new StoreBackedAuditRecorder({
    clientInstanceId,
    store: store.audit
  });
  const agentSelectableBindings = config.modelBindings.filter(
    (binding) => binding.agentSelectable !== false
  );
  const server = await createTestInstance({
    server: {
      config,
      clientInstanceId,
      authAdapter: serviceAccessOptions
        ? new IdentityResolvingAuthAdapter(
            new CompositeAuthAdapter([
              new HmacServiceAccessTokenAuthAdapter(serviceAccessOptions),
              new HmacSessionTokenAuthAdapter(authOptions)
            ]),
            store.users
          )
        : new HmacSessionTokenAuthAdapter(authOptions),
      stores: store,
      usageGovernance: new ModelUsageGovernance({
        store: store.usage,
        budget: config.usage.budget,
        safeguards: config.usage.safeguards,
        costs: config.usage.costs
      }),
      auditRecorder,
      configAssets: {
        store: store.configAssets,
        validationRefs: {
          modelProviderIds: modelProviders.map((provider) => provider.id),
          modelBindingIds: agentSelectableBindings.map((binding) => binding.id),
          modelBindings: agentSelectableBindings.map((binding) => ({
            id: binding.id,
            model: "local"
          })),
          fastModeModelBindingIds: config.modelBindings
            .filter((binding) => binding.supportsFastMode)
            .map((binding) => binding.id),
          reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
          enabledToolNames: ["known.tool", "read_skill", ...(input.webSearch ? ["web_search"] : [])]
        },
        ...(input.webSearch
          ? {
              validateAgents: (agents: AgentConfig[]) =>
                findConfigAssetAgentValidationIssues(
                  config,
                  agents,
                  builtInModelCapabilities(config)
                )
            }
          : {})
      },
      agentRuntime: createUnusedAgentRuntime(),
      modelProvider: createUnusedModelProvider(),
      sessionToken: {
        issuer,
        serverCredential: "server-credential"
      },
      ...(serviceAccessOptions
        ? {
            serviceAccessToken: {
              exchange: new ApiKeyAccessTokenExchange(serviceAccessOptions)
            }
          }
        : {})
    }
  });
  servers.push(server);
  return {
    clientInstanceId,
    server,
    store,
    apiKey: createdCredential?.secret,
    credentialId: createdCredential?.credential.id
  };
}

async function mintToken(
  server: TestInstance,
  overrides: {
    operation?: TestOperationName;
    roles?: string[];
    scopes?: string[];
    permissions?: string[];
    delegatedActor?:
      | {
          kind: "service_principal";
          id: string;
          authSource: string;
        }
      | undefined;
  } = {}
): Promise<string> {
  const payload = {
    externalUserId: "config-cli",
    displayLabel: "Config CLI",
    roles: overrides.roles ?? ["user"],
    permissions: overrides.permissions ?? [
      "config_assets.read",
      "config_assets.write",
      "config_assets.release"
    ],
    scopes: overrides.scopes ?? [
      "config_assets:read",
      "config_assets:write",
      "config_assets:release"
    ],
    ...("delegatedActor" in overrides
      ? { delegatedActor: overrides.delegatedActor }
      : {
          delegatedActor: {
            kind: "service_principal" as const,
            id: "config-cli",
            authSource: "server-credential"
          }
        })
  };
  const response = await server.call(overrides.operation ?? "session_tokens.issue", {
    headers: { "x-server-credential": "server-credential" },
    payload
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { chatSessionToken: string }).chatSessionToken;
}

function request(
  server: TestInstance,
  token: string,
  operation: TestOperationName,
  input: TestCallInput = {}
) {
  return server.call(operation, { ...input, headers: { authorization: `Bearer ${token}` } });
}

function skillConfig(content: string) {
  return { name: "research", title: "Research", description: "Research guidance", content };
}

function agentConfig(
  instructions: string,
  overrides: {
    name?: string;
    modelProviderId?: string;
    toolNames?: string[];
    skillNames?: string[];
  } = {}
) {
  return {
    name: overrides.name ?? "assistant",
    displayName: "Assistant",
    instructions,
    modelProviderId: overrides.modelProviderId ?? "local",
    toolNames: overrides.toolNames ?? [],
    skillNames: overrides.skillNames ?? [],
    initialPrompts: []
  };
}

function boundAgentConfig(modelBindingId: string) {
  const { modelProviderId: _modelProviderId, ...config } = agentConfig("Bound instructions");
  return { ...config, modelBindingId };
}

function createUnusedAgentRuntime(): AgentRuntime {
  return {
    async start() {
      throw new AppError("INTERNAL", "Agent runtime should not be used by config asset tests");
    },
    async *observe() {
      throw new AppError("INTERNAL", "Agent runtime should not be used by config asset tests");
    },
    async getStatus() {
      throw new AppError("INTERNAL", "Agent runtime should not be used by config asset tests");
    },
    async resume() {
      throw new AppError("INTERNAL", "Agent runtime should not be used by config asset tests");
    },
    async cancel() {
      throw new AppError("INTERNAL", "Agent runtime should not be used by config asset tests");
    }
  };
}

function createUnusedModelProvider(): ModelProvider {
  return {
    id: "unused",
    async complete(_request, _context: RuntimeCallContext) {
      throw new AppError("INTERNAL", "Model provider should not be used by config asset tests");
    }
  };
}
