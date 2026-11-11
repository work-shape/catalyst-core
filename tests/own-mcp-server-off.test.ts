import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { getOwnServers, parseClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import {
  DEFAULT_OWN_SERVERS,
  asClientInstanceId,
  type JsonObject
} from "@work-shape/catalyst-core";
import { z } from "zod";
import { createOAuthWorld, type OAuthWorld } from "./support/oauth-sign-in-world";

// The operator's switch `modules.connections.ownServers.enabled` (PMCP-2, connections
// acceptance check 76): on where release config leaves it out since PMCP-5, and here turned
// off by the operator. Off, a person's create answers `own_servers_off`, and a server added before stops: its
// calls, its test, its discovery and its sign-in answer `own_servers_off`, and nothing is
// deleted.

const clientInstanceId = asClientInstanceId("demo-local");
const PUBLIC_URL = "http://localhost:5173";
const reasonSchema = z.object({ error: z.object({ details: z.object({ reason: z.string() }) }) });

let world: OAuthWorld;
let carol: string;

beforeAll(async () => {
  // The operator turns the switch off.
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

/** A Connection route in Carol's session: its status and refusal reason. */
async function post(operation: "connections.discover" | "connections.oauth_start", name: string) {
  const response = await fetch(
    `${world.api}${apiOperations[operation].buildPath({ params: { name } })}`,
    {
      method: "POST",
      headers: { cookie: carol, origin: PUBLIC_URL, "content-type": "application/json" },
      body: "{}"
    }
  );
  const parsed = reasonSchema.safeParse(await response.json());
  return {
    status: response.status,
    reason: parsed.success ? parsed.data.error.details.reason : ""
  };
}

describe("people's own servers with the switch off", () => {
  it("are on where release config leaves the switch out", () => {
    expect(DEFAULT_OWN_SERVERS.enabled).toBe(true);
    const config = parseClientInstanceConfig({
      version: 1,
      clientInstance: { id: "own-servers-test", displayName: "Test", environment: "development" },
      auth: { development: { enabled: true, user: { permissionRefs: [] } } },
      localization: { defaultLocale: "en", supportedLocales: ["en", "de"] },
      infrastructure: { models: { local: { provider: "deterministic", model: "local" } } },
      modules: { connections: { enabled: true } }
    });
    expect(getOwnServers(config)).toMatchObject({ enabled: true });
  });

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

  it("answers `own_servers_off` to the call, test, discovery and sign-in of a server added before, and keeps it", async () => {
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
    // Both would contact the server: neither is queued or started.
    expect(await post("connections.discover", "carol-earlier")).toEqual({
      status: 403,
      reason: "own_servers_off"
    });
    expect(await post("connections.oauth_start", "carol-earlier")).toEqual({
      status: 403,
      reason: "own_servers_off"
    });
    expect(
      await world.instance.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: "connection",
        name: "carol-earlier"
      })
    ).toMatchObject({ status: "active" });
  });
});
