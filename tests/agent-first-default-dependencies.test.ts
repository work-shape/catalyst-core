import { describe, expect, it } from "vitest";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import {
  clientInstanceId,
  useDataStoreInstance,
  type DataStoreInstance
} from "./support/data-store-instance";
import { agent } from "./support/access-instance";
const developmentAuth = {
  enabled: true,
  users: [
    {
      id: "user-1",
      externalUserId: "user-1",
      displayLabel: "Mara",
      roles: ["user", "admin", "superadmin"],
      permissions: ["config_assets.release"]
    },
    { id: "member-1", externalUserId: "member-1", displayLabel: "Member", roles: ["user"] }
  ]
};
describe("the first default agent dependency review (LOWS-D)", () => {
  const { start } = useDataStoreInstance();
  async function publishKnowledgeBase(world: DataStoreInstance, name: string) {
    const params = { kind: "knowledge_base", name };
    const put = await world.api.call("assets.put", {
      params,
      payload: {
        expectedRevision: null,
        config: { name, title: "Rules", description: "Guidelines", methods: ["keyword"] }
      }
    });
    expect(put.statusCode, put.body).toBe(200);
    const publish = await world.api.call("assets.publish", { params, payload: { revision: 1 } });
    expect(publish.statusCode, publish.body).toBe(200);
  }
  async function addAccountingConnection(world: DataStoreInstance) {
    await applyAtCurrentRevisions(world.stores.configAssets, {
      clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "connection",
          name: "accounting",
          config: {
            name: "accounting",
            displayName: "Accounting",
            connectorType: "http_api",
            origin: "release",
            enabled: true,
            ownerPrincipalId: "system",
            authScheme: "none",
            credentialMode: "shared",
            settings: { baseUrl: "https://example.com" },
            operations: [
              {
                name: "facts",
                enabled: true,
                effect: "reading",
                exposure: ["agent"],
                method: "GET",
                path: "/facts"
              }
            ]
          }
        }
      ]
    });
  }
  it.each(["create", "sync", "consent"] as const)(
    "warns about the first default agent's missing dependencies on %s and keeps them in publish review (LOWS-D)",
    async (path) => {
      const world = await start(true, undefined, developmentAuth, undefined, {
        connections: true,
        defaultLocale: path === "sync" ? "de" : "en"
      });
      await publishKnowledgeBase(world, "rules");
      await addAccountingConnection(world);
      const config = {
        ...agent("first-helper", { knowledgeBases: ["rules"] }),
        toolNames: ["connection.accounting.facts"]
      };
      let result;
      if (path === "sync") {
        result = await world.api.call("assets.sync", {
          payload: {
            defaultAgentName: config.name,
            expectedDefaultAgentName: null,
            items: [{ type: "put", kind: "agent", config, expectedRevision: null }]
          }
        });
      } else {
        result = await world.api.call("assets.put", {
          params: { kind: "agent", name: config.name },
          payload: {
            config,
            expectedRevision: null,
            ...(path === "consent"
              ? {
                  makeDependenciesAvailable: true,
                  expectedAvailability: {
                    mode: "all",
                    personalWorkspaces: false,
                    collaborationWorkspaceIds: []
                  }
                }
              : {})
          }
        });
      }
      expect(result.statusCode, result.body).toBe(200);
      if (path === "consent") {
        expect(
          result
            .json()
            .warnings.filter(
              (warning: { code: string }) => warning.code === "agent_dependency_unavailable"
            )
        ).toEqual([]);
        return;
      }
      expect(result.json().warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "agent_dependency_unavailable",
            message: expect.stringContaining("Rules")
          }),
          expect.objectContaining({
            code: "agent_dependency_unavailable",
            message: expect.stringContaining("Accounting")
          })
        ])
      );
      expect(
        result
          .json()
          .warnings.find(
            (warning: { code: string }) => warning.code === "agent_dependency_unavailable"
          ).message
      ).toContain(path === "sync" ? "Prüfe die Abhängigkeiten" : "Review its dependencies");
      // Sync and unattended conversation writes report the review without widening dependencies.
      for (const kind of ["knowledge_base", "connection"] as const) {
        const availability = await world.stores.configAssets.listAgentAvailability({
          clientInstanceId,
          kind
        });
        expect(availability.size).toBe(0);
      }
      const params = { kind: "agent", name: config.name };
      const read = await world.api.call("assets.get", { params });
      expect(read.json()).toMatchObject({
        isDefault: true,
        availability: { mode: "all" },
        dependencyAvailability: {
          missing: [
            expect.objectContaining({ name: "rules" }),
            expect.objectContaining({ name: "accounting" })
          ]
        }
      });
      expect(
        (
          await world.api.call("assets.put", {
            params,
            payload: {
              config: { ...config, instructions: "Use the rules." },
              expectedRevision: 1,
              expectedDraftRevision: null
            }
          })
        ).statusCode
      ).toBe(200);
      const draft = await world.api.call("agents.draft.get", { params: { name: config.name } });
      expect(draft.json().draft.dependencyAvailability.missing).toHaveLength(2);
    }
  );
});
