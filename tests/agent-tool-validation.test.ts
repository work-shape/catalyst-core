import { describe, expect, it } from "vitest";
import { createAppAssetKind, createConnectionAssetKind } from "@vivd-catalyst/chat-server";
import { createEgressChecker } from "@vivd-catalyst/connections";
import type { DataToolSource } from "@vivd-catalyst/core";
import { connection, fixtureConnectorTypes } from "./support/connections";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import { agent, clientInstanceId } from "./support/access-instance";
import {
  asService,
  putAgent,
  putSkill,
  setupRelease,
  syncAsService
} from "./support/asset-release";

const validationRefs = {
  modelProviderIds: ["local"],
  modelBindingIds: ["plain", "other"],
  modelBindings: [],
  fastModeModelBindingIds: [],
  reasoningEfforts: [],
  enabledToolNames: ["known.tool", "second.tool"]
};

describe("agent tool references on the target instance", () => {
  const connectionKind = () =>
    createConnectionAssetKind({
      connectorTypes: fixtureConnectorTypes,
      egress: createEgressChecker({
        allow: [
          {
            protocol: "https",
            host: "outside.example.test",
            port: 443,
            network: "public",
            cidrs: []
          }
        ],
        resolve: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }])
      })
    });

  it.each(["disabled", "secret unreadable", "catalog undiscovered"])(
    "accepts an existing Connection with a warning when %s",
    async (reason) => {
      const dataTools: DataToolSource = {
        async describe() {
          return [];
        }
      };
      const t = await setupRelease({
        dataTools,
        furtherKinds: [connectionKind()],
        modules: { connections: { enabled: true } }
      });
      await applyAtCurrentRevisions(t.stores.configAssets, {
        clientInstanceId,
        mutations: [
          {
            type: "upsert",
            kind: "connection",
            name: "crm",
            config: connection("crm", {
              enabled: reason !== "disabled"
            })
          }
        ]
      });
      const config = agent("rel-connected", {
        toolNames: ["connection.crm.echo"],
        instructions: "Use connection.crm.echo."
      });
      const warning = {
        code: "tool_not_callable",
        message: expect.stringContaining("connection.crm.echo")
      };
      const validation = await t.call(t.admin.id, "assets.validate", {
        params: { kind: "agent" },
        payload: { config }
      });
      expect(validation.statusCode, validation.body).toBe(200);
      expect(validation.json()).toMatchObject({ valid: true, warnings: [warning] });
      const checked = await asService(t, "assets.sync_check", {
        payload: { items: [putAgent(config.name, config)] }
      });
      expect(checked.statusCode, checked.body).toBe(200);
      expect(checked.json()).toMatchObject({ valid: true, warnings: [warning] });
      const added = await syncAsService(t, [putAgent(config.name, config)]);
      expect(added.statusCode, added.body).toBe(200);
      expect(added.json()).toMatchObject({ warnings: [warning] });
      // An unchanged submitted agent receives the same nonblocking preflight warning.
      const again = await asService(t, "assets.sync_check", {
        payload: { items: [putAgent(config.name, config, 1)] }
      });
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json()).toMatchObject({ warnings: [warning] });
    }
  );

  it("accepts a runtime Connection and its agent in the same push batch before discovery", async () => {
    const t = await setupRelease({
      furtherKinds: [connectionKind()],
      modules: { connections: { enabled: true } }
    });
    const items = [
      putAgent("rel-connected", {
        toolNames: ["connection.rel-crm.echo"],
        instructions: "Use connection.rel-crm.echo."
      }),
      {
        type: "put",
        kind: "connection",
        expectedRevision: null,
        config: connection("rel-crm", {
          origin: "runtime",
          authScheme: "none",
          secretHandle: undefined
        })
      }
    ];
    const payload = { namespace: "rel-", items };
    const checked = await t.call(t.admin.id, "assets.sync_check", { payload });
    expect(checked.statusCode, checked.body).toBe(200);
    const added = await t.call(t.admin.id, "assets.sync", { payload });
    expect(added.statusCode, added.body).toBe(200);
    expect((await t.stored("connection", "rel-crm"))?.config).toMatchObject({
      ownerPrincipalId: t.admin.id
    });
    expect(await t.stored("agent", "rel-connected")).toBeDefined();
    const state = await t.stores.connections.getConnectionState({
      clientInstanceId,
      connectionAssetId: await t.assetId("connection", "rel-crm")
    });
    expect(state).toMatchObject({ health: "unknown" });
  });

  it("accepts an unpublished stored App action with a warning but refuses a nonexistent action", async () => {
    const t = await setupRelease({
      furtherKinds: [createAppAssetKind()],
      modules: { apps: { enabled: true } }
    });
    const workspaceId = await t.sharedWorkspace("App tools");
    await applyAtCurrentRevisions(t.stores.configAssets, {
      clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "app",
          name: "desk",
          scope: { kind: "workspace", workspaceId },
          config: {
            name: "desk",
            title: "Desk",
            manifest: {
              actions: [
                {
                  name: "lookup",
                  file: "actions/lookup.action.yaml",
                  kind: "workflow",
                  effect: "changing",
                  workflow: "lookup",
                  input: { schema: { type: "object", properties: {} }, mapping: {} }
                }
              ]
            }
          }
        }
      ]
    });
    for (const action of ["lookup", "missing"]) {
      const config = agent("rel-app", { instructions: `Use app.desk.${action}.` });
      const checked = await t.call(t.admin.id, "assets.validate", {
        params: { kind: "agent" },
        payload: { workspaceId, config }
      });
      expect(checked.statusCode, checked.body).toBe(200);
      expect(checked.json()).toMatchObject(
        action === "lookup"
          ? {
              valid: true,
              warnings: [
                { code: "tool_not_callable", message: expect.stringContaining("app.desk.lookup") }
              ]
            }
          : {
              valid: false,
              issues: expect.arrayContaining([
                { message: expect.stringContaining("app.desk.missing") }
              ])
            }
      );
    }
  });

  it("refuses nonexistent Connection operations and leaves unrelated writes usable", async () => {
    const t = await setupRelease({
      furtherKinds: [connectionKind()],
      modules: { connections: { enabled: true } }
    });
    const refused = await syncAsService(t, [
      putAgent("rel-missing", {
        instructions: "Use connection.crm.echo."
      })
    ]);
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.body).toContain("connection.crm.echo");
    // SA-0: an unrelated write is not blocked by stale stored agents.
    const other = await syncAsService(t, [putSkill("rel-another", "Help.")]);
    expect(other.statusCode, other.body).toBe(200);
  });

  it("refuses the real unbackticked incident and identifies its instruction line", async () => {
    const t = await setupRelease({ furtherToolNames: ["page.save"] });
    const config = agent("rel-page", {
      instructions:
        "Help.\nBuild a Page in the chat with page.save. When the user wants to keep or share it, save that Page as an App with page.save_as_app."
    });
    for (const operation of ["assets.sync_check", "assets.sync"] as const) {
      const refused = await asService(t, operation, {
        payload: { items: [putAgent(config.name, config)] }
      });
      expect(refused.statusCode, refused.body).toBe(422);
      expect(refused.body).toContain(
        "Agent 'rel-page' references unavailable tool 'page.save_as_app' in instructions line 2"
      );
    }
    expect(await t.stored("agent", config.name)).toBeUndefined();
  });

  it("refuses an instruction reference whose tool module is off", async () => {
    const t = await setupRelease({
      server: (stores) => ({
        configAssets: {
          store: stores.configAssets,
          validationRefs: {
            ...validationRefs,
            offToolModule: (name) => (name === "known.tool" ? "example" : undefined)
          }
        }
      })
    });
    const checked = await asService(t, "assets.sync_check", {
      payload: {
        items: [putAgent("rel-disabled", { instructions: "Use `known.tool`." })]
      }
    });
    expect(checked.statusCode, checked.body).toBe(422);
    expect(checked.body).toContain(
      "Agent 'rel-disabled' references unavailable tool 'known.tool' in instructions line 1"
    );
    expect(await t.stored("agent", "rel-disabled")).toBeUndefined();
  });
});
