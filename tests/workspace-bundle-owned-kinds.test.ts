import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WORKSPACE_OWNED_RIGHT_KINDS } from "@work-shape/catalyst-asset-schemas";
import { createWorkflowAssetKind } from "@work-shape/catalyst-client-assembly";
import { parseClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import { asClientInstanceId, type RegisteredAssetKind } from "@work-shape/catalyst-core";
import {
  createAgentAssetKind,
  createAppAssetKind,
  createGuardrailAssetKind,
  createSkillAssetKind
} from "@work-shape/catalyst-server";
import { WORKFLOW_UNBOUNDED_CEILINGS } from "@work-shape/catalyst-workflows";
import { agent } from "./support/access-instance";
import {
  fixtureConnectionKind,
  setupConnectionInstance,
  type ConnectionInstance
} from "./support/connections";

// PMCP-1 (connections acceptance check 82): the workspace bundles expand their verbs only on the
// kinds a workspace can own, so Builder in a workspace carries no right on a Connection, and
// everything it reached in the workspace before it still reaches.

const config = parseClientInstanceConfig({
  version: 1,
  clientInstance: { id: "kinds", displayName: "Kinds", environment: "development" },
  auth: {},
  infrastructure: { models: { local: { provider: "deterministic", model: "local" } } }
});
const untouched = () => Promise.reject(new Error("Not read here"));

function rightKindsOf(kind: Pick<RegisteredAssetKind, "actions">): string[] {
  return [
    ...new Set(
      Object.values(kind.actions)
        .filter((action): action is string => action !== undefined)
        .map((action) => action.slice(0, action.indexOf(".")))
    )
  ];
}

describe("the kinds a workspace bundle reaches", () => {
  it("are the right kinds of the registered kinds a workspace can own, and no other", () => {
    const kinds: RegisteredAssetKind[] = [
      createAgentAssetKind({
        config,
        validationRefs: {
          modelProviderIds: ["local"],
          modelBindingIds: [],
          modelBindings: [],
          fastModeModelBindingIds: [],
          reasoningEfforts: [],
          enabledToolNames: []
        }
      }),
      createSkillAssetKind({ config, shippedSkillNames: [] }),
      createAppAssetKind(),
      createGuardrailAssetKind(),
      fixtureConnectionKind(),
      createWorkflowAssetKind({
        clientInstanceId: asClientInstanceId("ci_test"),
        limits: { ceilings: WORKFLOW_UNBOUNDED_CEILINGS, stepSlots: 4 },
        runnerPackages: [],
        configAssets: { getConfigAsset: untouched, listPublishedConfigAssets: untouched },
        apiAccess: {
          findServicePrincipalByName: untouched,
          findServicePrincipalByOwner: untouched
        },
        access: { loadPersistedAccess: untouched, listGrantScopeAssets: untouched }
      })
    ];
    const listed: readonly string[] = WORKSPACE_OWNED_RIGHT_KINDS;
    for (const kind of kinds) {
      for (const rightKind of rightKindsOf(kind)) {
        expect(listed.includes(rightKind), `${kind.kind}: ${rightKind}`).toBe(
          kind.owners.includes("workspace")
        );
      }
    }
    expect(kinds.find((kind) => kind.kind === "connection")?.owners).toEqual(["instance"]);
  });
});

describe("a Builder in a workspace on an instance with Connections", () => {
  let t: ConnectionInstance;
  let workspaceId: string;
  beforeAll(async () => {
    t = await setupConnectionInstance();
    await t.seed("alpha");
    workspaceId = await t.sharedWorkspace("Team");
    await t.grant(t.lena.id, "builder", { workspaceId });
  });
  afterAll(async () => {
    await t.instance.close();
  });

  const contextOf = async (userId: string) =>
    (await t.expectOk(userId, "platform.context.get")).json<{
      actions: string[];
      assetActions: string[];
      workspaces: { id: string; actions: string[] }[];
    }>();

  it("is named no Connection right anywhere, and its agent and skill rights there as before", async () => {
    const lena = await contextOf(t.lena.id);
    const named = [
      ...lena.actions,
      ...lena.assetActions,
      ...lena.workspaces.flatMap((workspace) => workspace.actions)
    ];
    expect(named.filter((action) => action.startsWith("connection."))).toEqual([]);
    // Studio offers no Connections page for it: no read on one Connection or on some.
    expect(lena.assetActions).not.toContain("connection.read");
    expect(lena.workspaces.find((workspace) => workspace.id === workspaceId)?.actions).toEqual(
      expect.arrayContaining(["agent.read", "agent.write", "skill.read", "skill.write"])
    );
  });

  it("is refused a Connection's configuration and a write of one, and still writes an agent there", async () => {
    await t.expectRefused(
      t.lena.id,
      "assets.get",
      { params: { kind: "connection", name: "alpha" } },
      t.forbidden("connection.read", "no_grant")
    );
    const listed = await t.expectOk(t.lena.id, "assets.list", { params: { kind: "connection" } });
    expect(listed.json<{ items: unknown[] }>().items).toEqual([]);
    await t.expectOk(t.lena.id, "assets.put", {
      params: { kind: "agent", name: "team-helper" },
      payload: { config: agent("team-helper"), expectedRevision: null, workspaceId }
    });
  });
});
