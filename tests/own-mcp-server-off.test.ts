import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asClientInstanceId, type JsonObject } from "@work-shape/catalyst-core";
import { createOAuthWorld, type OAuthWorld } from "./support/oauth-sign-in-world";

// The operator's switch `modules.connections.ownServers.enabled` (PMCP-2, connections
// acceptance check 76): off, a person's create of their own server answers `own_servers_off`,
// and a server added before stops: its calls answer `own_servers_off`, and nothing is deleted.

const clientInstanceId = asClientInstanceId("demo-local");
const PUBLIC_URL = "http://localhost:5173";

let world: OAuthWorld;
let carol: string;

beforeAll(async () => {
  world = await createOAuthWorld({ plainPeople: true, ownServers: { enabled: false } });
  carol = await world.signIn("carol");
}, 60_000);
afterAll(async () => {
  await world?.close();
});

function own(name: string, operations: JsonObject[] = []): JsonObject {
  return {
    name,
    connectorType: "mcp",
    credentialMode: "user",
    authScheme: "oauth",
    displayName: "My notes",
    settings: { url: `${world.sample}/dcr/mcp` },
    operations,
    enabled: true,
    ownerOnly: true
  };
}

describe("people's own servers with the operator's switch off", () => {
  it("answers `own_servers_off` to the create and stores nothing", async () => {
    const answer = await world.instance.call(
      "assets.put",
      {
        params: { kind: "connection", name: "carol-notes" },
        payload: { config: own("carol-notes"), expectedRevision: null }
      },
      { headers: { cookie: carol, origin: PUBLIC_URL } }
    );
    expect(answer.statusCode).toBe(403);
    expect(answer.json<{ error: { details: { reason: string } } }>().error.details.reason).toBe(
      "own_servers_off"
    );
    expect(
      await world.instance.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: "connection",
        name: "carol-notes"
      })
    ).toBeUndefined();
  });

  it("answers `own_servers_off` to a call of a server added before, and keeps it", async () => {
    const carolId = await world.userIdOf(carol);
    // Added while the switch was on: written as the self-add create writes it.
    await world.instance.stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { "connection:carol-earlier": null },
      mutations: [
        {
          type: "upsert",
          kind: "connection",
          name: "carol-earlier",
          config: {
            ...own("carol-earlier", [
              { name: "list_customers", effect: "reading", exposure: ["agent"] }
            ]),
            ownerPrincipalId: carolId,
            origin: "runtime",
            secretHandle: "secret_00000000-0000-4000-8000-000000000001"
          }
        }
      ]
    });
    const call = await world.call("carol-earlier", "list_customers", carol, "agent");
    expect(JSON.stringify(call.result)).toContain("own_servers_off");
    const test = await world.test("carol-earlier", carol);
    expect(test.text).toContain("own_servers_off");
    expect(
      await world.instance.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: "connection",
        name: "carol-earlier"
      })
    ).toMatchObject({ status: "active" });
  });
});
