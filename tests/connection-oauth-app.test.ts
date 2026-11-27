import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { parseCatalogueEntry } from "@work-shape/catalyst-connections";
import { asClientInstanceId } from "@work-shape/catalyst-core";
import { partOffer, type CatalogueEntryOffer } from "@work-shape/catalyst-chat-ui/build-area";
import { captureProcessOutput, dumpDatabaseText, findLeak } from "./support/test-connector";
import {
  REST_CLIENT_ID,
  REST_CONNECTION,
  createOAuthWorld,
  landingOf,
  type OAuthWorld
} from "./support/oauth-sign-in-world";
import { withTestSql } from "./support/test-sql";
import { required } from "./support/assertions";

// OAUTH-APP: an admin enters the client secret of one OAuth app once per instance. A Connection
// on the app's server and client id without a secret of its own signs in, calls and refreshes
// with it; the catalogue installs a part on that server with no client field; the write deletes
// own secrets that are exact copies and leaves any other. The secret is never answered.
// The stand-in is the demo sample's REST provider (`/oauth-rest`), which checks the secret.

const instanceId = asClientInstanceId("demo-local");
const ENTRY = "sample-app";
const startSchema = z.object({ authorizationUrl: z.string().url() });
const appSchema = z.object({
  service: z.string().optional(),
  clientId: z.string(),
  version: z.number(),
  moved: z.array(z.string())
});
const detailSchema = z.object({
  oauthApp: z.object({ clientId: z.string(), version: z.number(), inUse: z.boolean() }).optional()
});

let world: OAuthWorld;
let output: { stop(): string } | undefined;
const answers: string[] = [];

const customers = {
  name: "list_customers",
  description: "Lists the customers.",
  effect: "reading",
  exposure: ["agent"],
  enabled: true,
  method: "GET",
  path: "/customers"
};

/** The sample's REST provider as a catalogue entry with a shared tools part. */
function entryAt(base: string, port: number) {
  const value = {
    id: ENTRY,
    version: 1,
    service: "sample-app",
    title: { en: "Sample", de: "Beispiel" },
    description: { en: "Read sample customers.", de: "Beispielkunden lesen." },
    category: "other",
    examplePrompts: [{ en: "List the sample customers.", de: "Zeig die Beispielkunden." }],
    mark: { color: "#325676" },
    tools: {
      connectorType: "http_api",
      name: REST_CONNECTION,
      description: { en: "Read sample customers.", de: "Beispielkunden lesen." },
      authScheme: "oauth",
      credentialModes: ["shared"],
      oauth: {
        authorizationUrl: `${base}/oauth-rest/authorize`,
        tokenUrl: `${base}/oauth-rest/token`,
        revocationUrl: `${base}/oauth-rest/revoke`,
        tokenAuthMethod: "client_secret_post"
      },
      settings: { baseUrl: `${base}/oauth-rest/api`, testPath: "/customers" },
      fields: [
        { setting: "oauth.clientId", label: { en: "Client ID", de: "Client-ID" } },
        { secret: true, label: { en: "Client secret", de: "Client-Secret" } }
      ],
      egress: [
        { protocol: "http", host: "127.0.0.1", port, network: "private", cidrs: ["127.0.0.1/32"] }
      ],
      operations: [
        {
          name: "list_customers",
          description: "Read the invented customers.",
          effect: "reading",
          recommended: true,
          method: "GET",
          path: "/customers"
        }
      ],
      sharedAccountNote: { en: "One account for everyone.", de: "Ein Konto für alle." }
    }
  };
  return parseCatalogueEntry(JSON.stringify(value), `${ENTRY}/entry.yaml`);
}

beforeAll(async () => {
  world = await createOAuthWorld({ catalogue: (base, port) => [entryAt(base, port)] });
  output = captureProcessOutput();
}, 60_000);

afterAll(async () => {
  output?.stop();
  await world?.close();
});

/** A runtime `http_api` Connection on the REST provider's server and client. */
function restConnection(clientId = REST_CLIENT_ID): Record<string, unknown> {
  const base = `${world.sample}/oauth-rest`;
  return {
    displayName: "Sample REST",
    connectorType: "http_api",
    service: "sample-app",
    settings: {
      baseUrl: `${base}/api`,
      testPath: "/customers",
      oauth: {
        authorizationUrl: `${base}/authorize`,
        tokenUrl: `${base}/token`,
        revocationUrl: `${base}/revoke`,
        clientId,
        scopes: ["sample.read"]
      }
    },
    authScheme: "oauth",
    operations: [customers],
    enabled: true
  };
}

async function setApp(name: string, body: Record<string, unknown>, cookie: string) {
  const stored = await world.instance.stores.configAssets.getConfigAsset({
    clientInstanceId: instanceId,
    kind: "connection",
    name
  });
  const path = apiOperations["connections.set_oauth_app"].buildPath({ params: { name } });
  const response = await fetch(`${world.api}${path}`, {
    method: "PUT",
    headers: { cookie, origin: "http://localhost:5173", "content-type": "application/json" },
    body: JSON.stringify({ ...body, expectedRevision: stored?.revision ?? 1 })
  });
  const text = await response.text();
  answers.push(text);
  return { status: response.status, text };
}

/** The Connections of this file that hold a secret of their own. */
async function ownSecrets(): Promise<string[]> {
  const mine = ["copy-a", "copy-b", "other", "another-client", REST_CONNECTION];
  const rows = await withTestSql(
    (sql) => sql<{ name: string }[]>`
      select a.name from secrets s join config_assets a on a.id = s.connection_asset_id
      where a.kind = 'connection' and s.subject = 'shared' order by a.name`
  );
  return rows.map((row) => row.name).filter((name) => mine.includes(name));
}

describe("an instance's OAuth app", () => {
  it("is adopted from one Connection, and own copies of the same secret collapse into it", async () => {
    const alice = await world.signIn("alice");
    for (const name of ["copy-a", "copy-b", "other"]) {
      expect(await world.putConnection(name, restConnection(), alice)).toBe(200);
    }
    expect(await world.setSecret("copy-a", world.restClientSecret, alice)).toBe(200);
    expect(await world.setSecret("copy-b", world.restClientSecret, alice)).toBe(200);
    expect(await world.setSecret("other", "another-secret-of-the-app", alice)).toBe(200);

    const adopted = await setApp("copy-a", { expectedVersion: null }, alice);
    expect(adopted.status, adopted.text).toBe(200);
    expect(appSchema.parse(JSON.parse(adopted.text))).toEqual({
      clientId: REST_CLIENT_ID,
      version: 1,
      moved: ["copy-a", "copy-b"],
      service: "sample-app"
    });
    // A Connection with another secret keeps it as its own.
    expect(await ownSecrets()).toEqual(["other"]);
    const detail = detailSchema.parse(JSON.parse(await world.detail("copy-b", alice)));
    expect(detail.oauthApp).toEqual({ clientId: REST_CLIENT_ID, version: 1, inUse: true });
  });

  it("installs a catalogue part on its server with no client field", async () => {
    const alice = await world.signIn("alice");
    const descriptor = apiOperations["connections.connector_types"];
    const response = await fetch(`${world.api}${descriptor.buildPath({ params: {} })}`, {
      headers: { cookie: alice, origin: "http://localhost:5173" }
    });
    const text = await response.text();
    answers.push(text);
    expect(response.status, text).toBe(200);
    const entry = required(
      z
        .object({ entries: z.array(z.custom<CatalogueEntryOffer>()) })
        .parse(JSON.parse(text))
        .entries.find((item) => item.id === ENTRY)
    );
    const part = required(entry.parts[0]);
    expect(part.oauthApp).toEqual({ clientId: REST_CLIENT_ID, mayEnter: true });
    const offer = partOffer(entry, part);
    expect(offer.fields).toEqual([]);
    expect(offer.settings).toMatchObject({ oauth: { clientId: REST_CLIENT_ID } });
  });

  it("signs a Connection without a secret of its own in, calls and refreshes with the app", async () => {
    const alice = await world.signIn("alice");
    expect(await world.putConnection(REST_CONNECTION, restConnection(), alice)).toBe(200);
    const started = await world.start(REST_CONNECTION, alice);
    answers.push(JSON.stringify(started.body));
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const back = await world.authorize(startSchema.parse(started.body).authorizationUrl);
    const landed = await world.callback(back, { cookie: alice });
    answers.push(landed.body);
    expect(landingOf(landed.location)).toEqual({
      signIn: "connected",
      connection: REST_CONNECTION
    });
    expect(await ownSecrets()).toEqual(["other"]);

    world.oauth.expireAccessTokens();
    const before = world.oauth.counts();
    const outcome = await world.call(REST_CONNECTION, "list_customers", alice, "agent");
    answers.push(JSON.stringify(outcome.result));
    expect(outcome.result).toMatchObject({ status: "done" });
    expect(world.oauth.counts().refreshToken - before.refreshToken).toBe(1);
  });

  it("is replaced over the version its writer saw, never stale nor from under a Connection using it", async () => {
    const alice = await world.signIn("alice");
    const stale = await setApp(
      "other",
      { value: "a-new-secret-of-the-app", expectedVersion: null },
      alice
    );
    expect(stale.status, stale.text).toBe(409);
    expect(stale.text).toContain("secret_write_conflict");
    const replaced = await setApp(
      REST_CONNECTION,
      { value: world.restClientSecret, expectedVersion: 1 },
      alice
    );
    expect(replaced.status, replaced.text).toBe(200);
    expect(appSchema.parse(JSON.parse(replaced.text))).toMatchObject({ version: 2, moved: [] });

    // Another client id on the same server would leave "rest", which uses the app, without one.
    const other = restConnection("another-client");
    expect(await world.putConnection("another-client", other, alice)).toBe(200);
    const inUse = await setApp(
      "another-client",
      { value: "a-secret-of-another-client", expectedVersion: 2 },
      alice
    );
    expect(inUse.status, inUse.text).toBe(409);
    expect(inUse.text).toContain("oauth_app_in_use");
  });

  it("keeps the app's secret out of every answer, log line and row", async () => {
    const logged = output?.stop() ?? "";
    output = undefined;
    const database = await dumpDatabaseText();
    expect(findLeak(logged, world.restClientSecret)).toBeUndefined();
    expect(findLeak(database, world.restClientSecret)).toBeUndefined();
    expect(findLeak(answers.join("\n"), world.restClientSecret)).toBeUndefined();
  });
});
