import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createHttpApiConnectorType,
  createManagedOAuthClients,
  endStaleManagedSignIns,
  parseCatalogueEntry,
  NO_MANAGED_OAUTH_CLIENTS,
  type ManagedOAuthClients
} from "@work-shape/catalyst-connections";
import { asClientInstanceId, createConnectorTypeRegistry } from "@work-shape/catalyst-core";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { partOffer, type CatalogueEntryOffer } from "@work-shape/catalyst-chat-ui/build-area";
import { captureProcessOutput, dumpDatabaseText, findLeak } from "./support/test-connector";
import {
  MANAGED_CLIENT_SECRET_NAME,
  REST_CLIENT_ID,
  REST_CONNECTION,
  createOAuthWorld,
  landingOf,
  type OAuthWorld
} from "./support/oauth-sign-in-world";
import { withTestSql } from "./support/test-sql";
import { required } from "./support/assertions";

// MS-APP-1: a catalogue part that asks for the operator's managed OAuth client installs with
// no field, and a person connects with the client release config names. Its secret is read
// from the host at each token exchange and is kept in no table, answer, log or audit record.
// The vendor-free stand-in is the demo sample's REST provider (`/oauth-rest`).

const instanceId = asClientInstanceId("demo-local");
const ENTRY = "sample-managed";
const startSchema = z.object({ authorizationUrl: z.string().url() });
const detailSchema = z.object({
  oauth: z.object({ registration: z.string(), redirectUri: z.string().optional() }).optional()
});
const offersSchema = z.object({
  entries: z.array(
    z.object({
      id: z.string(),
      parts: z.array(z.object({ name: z.string(), managedClient: z.string().optional() }))
    })
  )
});

/** Settings without the consent scopes, which follow from the enabled operations. */
function withoutScopes(settings: unknown) {
  const parsed = z
    .looseObject({ oauth: z.looseObject({ scopes: z.unknown().optional() }) })
    .parse(settings);
  const { scopes: _scopes, ...oauth } = parsed.oauth;
  return { ...parsed, oauth };
}

let world: OAuthWorld;
let output: { stop(): string } | undefined;
const answers: string[] = [];

/** The entry the instance ships: the sample's REST provider on the managed client `sample`. */
function entryAt(base: string, port: number) {
  const value = {
    id: ENTRY,
    version: 1,
    service: "sample-managed",
    title: { en: "Sample mail", de: "Beispielpost" },
    description: { en: "Read sample customers.", de: "Beispielkunden lesen." },
    category: "other",
    examplePrompts: [{ en: "List the sample customers.", de: "Zeig die Beispielkunden." }],
    mark: { color: "#325676" },
    tools: {
      connectorType: "http_api",
      name: REST_CONNECTION,
      description: { en: "Read sample customers.", de: "Beispielkunden lesen." },
      authScheme: "oauth",
      credentialModes: ["user", "shared"],
      defaultCredentialMode: "user",
      oauth: {
        authorizationUrl: `${base}/oauth-rest/authorize`,
        tokenUrl: `${base}/oauth-rest/token`,
        revocationUrl: `${base}/oauth-rest/revoke`,
        tokenAuthMethod: "client_secret_post"
      },
      managedClient: "sample",
      settings: { baseUrl: `${base}/oauth-rest/api`, testPath: "/customers" },
      fields: [
        { setting: "oauth.clientId", label: { en: "Client ID", de: "Client-ID" } },
        { secret: true, label: { en: "Client secret", de: "Client-Secret" } }
      ],
      egress: [
        {
          protocol: "http",
          host: "127.0.0.1",
          port,
          network: "private",
          cidrs: ["127.0.0.1/32"]
        }
      ],
      groups: [
        {
          id: "identity",
          title: { en: "Identity", de: "Identität" },
          scopes: ["sample.identity"]
        },
        { id: "read", title: { en: "Read", de: "Lesen" }, scopes: ["sample.read"] }
      ],
      operations: [
        {
          name: "listCustomers",
          description: "Read the invented customers.",
          effect: "reading",
          recommended: true,
          group: "read",
          method: "GET",
          path: "/customers"
        }
      ],
      sharedAccountNote: {
        en: "Everyone allowed reads the same sample account in shared mode.",
        de: "Im gemeinsamen Modus lesen alle Berechtigten dasselbe Beispielkonto."
      }
    }
  };
  return parseCatalogueEntry(JSON.stringify(value), `${ENTRY}/entry.yaml`);
}

beforeAll(async () => {
  world = await createOAuthWorld({
    managedClient: "sample",
    catalogue: (base, port) => [entryAt(base, port)]
  });
  output = captureProcessOutput();
}, 60_000);

afterAll(async () => {
  output?.stop();
  await world?.close();
});

/** What the install writes on the managed client: no client id, no secret. */
function installed(overrides: Record<string, unknown> = {}) {
  return {
    displayName: "Sample mail",
    connectorType: "http_api",
    service: "sample-managed",
    authScheme: "oauth",
    credentialMode: "user",
    catalogue: { entry: ENTRY, part: "tools", version: 1 },
    settings: {
      baseUrl: `${world.sample}/oauth-rest/api`,
      testPath: "/customers",
      oauth: {
        authorizationUrl: `${world.sample}/oauth-rest/authorize`,
        tokenUrl: `${world.sample}/oauth-rest/token`,
        revocationUrl: `${world.sample}/oauth-rest/revoke`,
        tokenAuthMethod: "client_secret_post",
        managedClient: "sample"
      }
    },
    operations: [
      {
        name: "listCustomers",
        description: "Read the invented customers.",
        effect: "reading",
        method: "GET",
        path: "/customers",
        exposure: ["agent"],
        enabled: true
      }
    ],
    enabled: true,
    ...overrides
  };
}

async function connect(cookie: string) {
  const started = await world.start(REST_CONNECTION, cookie);
  answers.push(JSON.stringify(started.body));
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const authorizationUrl = new URL(startSchema.parse(started.body).authorizationUrl);
  const back = await world.authorize(authorizationUrl.href);
  expect(back.searchParams.get("error")).toBeNull();
  const landed = await world.callback(back, { cookie });
  answers.push(landed.body);
  expect(landingOf(landed.location)).toEqual({
    signIn: "connected",
    connection: REST_CONNECTION
  });
  return authorizationUrl;
}

async function bindingOf(cookie: string) {
  const userId = await world.userIdOf(cookie);
  const [row] = await withTestSql(
    (sql) => sql<{ state: string; reason: string | null; secrets: number }[]>`
      select b.state, b.state_reason as reason,
        (select count(*)::int from secrets s
          where s.connection_asset_id = a.id and s.subject like ${`%user:${userId}`}) as secrets
      from config_assets a join connection_bindings b
        on b.connection_asset_id = a.id and b.subject = ${`user:${userId}`}
      where a.kind = 'connection' and a.name = ${REST_CONNECTION}
      limit 1`
  );
  return row;
}

async function secretSubjects(): Promise<string[]> {
  const rows = await withTestSql(
    (sql) => sql<{ subject: string }[]>`
      select s.subject from secrets s join config_assets a on a.id = s.connection_asset_id
      where a.kind = 'connection' and a.name = ${REST_CONNECTION} order by s.subject`
  );
  return rows.map((row) => row.subject);
}

async function put(name: string, config: Record<string, unknown>, cookie: string) {
  const answer = await world.instance.call(
    "assets.put",
    {
      params: { kind: "connection", name },
      payload: { config: { name, ...config }, expectedRevision: null }
    },
    { headers: { cookie, origin: "http://localhost:5173" } }
  );
  answers.push(JSON.stringify(answer.json()));
  return answer;
}

/** Ends the stale sign-ins as a start of the instance with these managed clients would. */
async function startWith(clients: ManagedOAuthClients) {
  return endStaleManagedSignIns({
    clientInstanceId: instanceId,
    stores: world.instance.stores,
    connectorTypes: createConnectorTypeRegistry([createHttpApiConnectorType({}, clients)]),
    managedClients: clients,
    logger: { info: vi.fn(), warn: vi.fn() }
  });
}

describe("a catalogue part on the operator's managed OAuth client", () => {
  it("is offered with the managed client and no secret", async () => {
    const alice = await world.signIn("alice");
    const descriptor = apiOperations["connections.connector_types"];
    const response = await fetch(`${world.api}${descriptor.buildPath({ params: {} })}`, {
      headers: { cookie: alice, origin: "http://localhost:5173" }
    });
    const text = await response.text();
    answers.push(text);
    expect(response.status, text).toBe(200);
    const entry = offersSchema.parse(JSON.parse(text)).entries.find((item) => item.id === ENTRY);
    expect(entry?.parts[0]).toMatchObject({ name: REST_CONNECTION, managedClient: "sample" });
    expect(text).not.toContain(MANAGED_CLIENT_SECRET_NAME);
    // The install dialog writes the settings a managed Connection is held to; the scopes follow
    // from the operations it enables.
    const offered = z
      .object({ entries: z.array(z.custom<CatalogueEntryOffer>()) })
      .parse(JSON.parse(text))
      .entries.find((item) => item.id === ENTRY);
    const part = required(offered?.parts[0]);
    expect(withoutScopes(partOffer(required(offered), part, true).settings)).toEqual(
      installed().settings
    );
  });

  it("installs with no field, and a person connects and calls with the managed client", async () => {
    const alice = await world.signIn("alice");
    expect(await world.putConnection(REST_CONNECTION, installed(), alice)).toBe(200);
    const authorizationUrl = await connect(alice);
    expect(authorizationUrl.searchParams.get("client_id")).toBe(REST_CLIENT_ID);
    // The token set of the person and nothing else: no client secret was ever stored.
    const userId = await world.userIdOf(alice);
    expect(await secretSubjects()).toEqual([`oauth:user:${userId}`]);

    const outcome = await world.call(REST_CONNECTION, "listCustomers", alice, "agent");
    answers.push(JSON.stringify(outcome.result));
    expect(outcome.result).toMatchObject({ status: "done" });

    const text = await world.detail(REST_CONNECTION, alice);
    answers.push(text);
    expect(detailSchema.parse(JSON.parse(text)).oauth).toMatchObject({ registration: "managed" });
  });

  it("refreshes the token with the managed client's secret", async () => {
    const alice = await world.signIn("alice");
    const before = world.oauth.counts();
    world.oauth.expireAccessTokens();
    const outcome = await world.call(REST_CONNECTION, "listCustomers", alice, "agent");
    answers.push(JSON.stringify(outcome.result));
    expect(outcome.result).toMatchObject({ status: "done" });
    expect(world.oauth.counts().refreshToken - before.refreshToken).toBe(1);
  });

  it("refuses the managed client to a second Connection or one not installed from the part", async () => {
    const alice = await world.signIn("alice");
    for (const [name, config] of [
      ["second-mailbox", installed()],
      ["unlinked", installed({ catalogue: undefined })]
    ] as const) {
      const answer = await put(name, config, alice);
      expect(answer.statusCode, name).toBe(422);
      expect(JSON.stringify(answer.json())).toContain("managed_client_unavailable");
    }
  });

  it("keeps a managed Connection on its part's servers, address and headers", async () => {
    // The client secret goes to the token and revocation endpoints, and a person's token to the
    // base address: an admin who moved one of them would receive it.
    const alice = await world.signIn("alice");
    const moved = (settings: object, oauth: object = {}) => {
      const config = installed();
      return {
        ...config,
        settings: { ...config.settings, ...settings, oauth: { ...config.settings.oauth, ...oauth } }
      };
    };
    for (const [why, config] of [
      ["token endpoint", moved({}, { tokenUrl: `${world.sample}/oauth-rest/token/elsewhere` })],
      [
        "revocation endpoint",
        moved({}, { revocationUrl: `${world.sample}/oauth-rest/api/customers` })
      ],
      [
        "authorization endpoint",
        moved({}, { authorizationUrl: `${world.sample}/oauth-rest/api/authorize` })
      ],
      ["token auth method", moved({}, { tokenAuthMethod: "client_secret_basic" })],
      ["tenant", moved({}, { pathParams: { tenant: "elsewhere" } })],
      ["base address", moved({ baseUrl: `${world.sample}/oauth-rest` })],
      ["fixed headers", moved({ headers: { "x-extra": "1" } })],
      // The client credentials grant would hand the admin a token of the operator's app itself.
      ["client credentials grant", { ...installed(), authScheme: "oauth_client" }]
    ] as const) {
      const answer = await world.instance.call(
        "assets.put",
        {
          params: { kind: "connection", name: REST_CONNECTION },
          payload: {
            config: { name: REST_CONNECTION, ...config },
            expectedRevision:
              (
                await world.instance.stores.configAssets.getConfigAsset({
                  clientInstanceId: instanceId,
                  kind: "connection",
                  name: REST_CONNECTION
                })
              )?.revision ?? null
          }
        },
        { headers: { cookie: alice, origin: "http://localhost:5173" } }
      );
      answers.push(JSON.stringify(answer.json()));
      expect(answer.statusCode, why).toBe(422);
      expect(JSON.stringify(answer.json()), why).toContain("managed_client_unavailable");
    }
    // The install as the part has it still saves.
    expect(await world.putConnection(REST_CONNECTION, installed(), alice)).toBe(200);
  });

  it("runs a personal call on the managed client through the personal model regions", async () => {
    const alice = await world.signIn("alice");
    await connect(alice);
    const outcome = await world.call(REST_CONNECTION, "listCustomers", alice, "agent", [
      { id: "outside", region: "us" }
    ]);
    expect(outcome.result).toMatchObject({ status: "failed" });
    expect(JSON.stringify(outcome.result)).toContain("personal_connection_region");
  });

  it("keeps the sign-ins while the provider refuses only the managed client's secret", async () => {
    // A secret that expired or was rotated at the provider before the host has the new one is
    // the operator's to fix; each person's grant is still good and is not thrown away.
    const alice = await world.signIn("alice");
    world.oauth.controls.refuseClients = true;
    try {
      world.oauth.expireAccessTokens();
      const refused = await world.call(REST_CONNECTION, "listCustomers", alice, "agent");
      answers.push(JSON.stringify(refused.result));
      expect(refused.result).not.toMatchObject({ status: "done" });
      expect(await bindingOf(alice)).toMatchObject({ state: "connected", secrets: 1 });
    } finally {
      world.oauth.controls.refuseClients = false;
    }
    const outcome = await world.call(REST_CONNECTION, "listCustomers", alice, "agent");
    expect(outcome.result).toMatchObject({ status: "done" });
  });

  it("keeps the sign-ins at a start whose host misses only the managed client's secret", async () => {
    const alice = await world.signIn("alice");
    const unset = await createManagedOAuthClients({
      clients: { sample: { clientId: REST_CLIENT_ID, credentialSecret: "UNSET_SECRET" } },
      secrets: {
        resolve: () => Promise.reject(new Error("not set"))
      },
      logger: { warn: vi.fn() }
    });
    expect((await startWith(unset)).ended).toBe(0);
    expect(await bindingOf(alice)).toMatchObject({ state: "connected", secrets: 1 });
  });

  it("revokes at the provider with the managed client when the person disconnects", async () => {
    const alice = await world.signIn("alice");
    const before = world.oauth.counts();
    const answer = await world.disconnect(REST_CONNECTION, alice);
    answers.push(JSON.stringify(answer.body));
    expect(answer.status).toBe(200);
    expect(world.oauth.counts().revocation - before.revocation).toBe(1);
    expect(await secretSubjects()).toEqual([]);
  });

  it("asks for a new connect when the instance loses the client or its id changes", async () => {
    const alice = await world.signIn("alice");
    const logger = { warn: vi.fn() };
    const changedId = await createManagedOAuthClients({
      clients: { sample: { clientId: "another-client", credentialSecret: "UNUSED_SECRET" } },
      secrets: { resolve: async () => "unused" },
      logger
    });
    for (const clients of [NO_MANAGED_OAUTH_CLIENTS, changedId]) {
      await connect(alice);
      expect(await bindingOf(alice)).toMatchObject({ state: "connected" });
      expect((await startWith(clients)).ended).toBe(1);
      expect(await bindingOf(alice)).toMatchObject({
        state: "needs_reconnect",
        reason: "invalid_client",
        secrets: 0
      });
    }
    // With the client as it was, a connected sign-in stays.
    await connect(alice);
    const same = await createManagedOAuthClients({
      clients: { sample: { clientId: REST_CLIENT_ID, credentialSecret: "UNUSED_SECRET" } },
      secrets: { resolve: async () => "unused" },
      logger
    });
    expect((await startWith(same)).ended).toBe(0);
    expect(await bindingOf(alice)).toMatchObject({ state: "connected" });
  });

  it("keeps the client secret out of logs, answers, the database and the audit records", async () => {
    const logged = output?.stop() ?? "";
    output = undefined;
    const database = await dumpDatabaseText();
    const events = await withTestSql(
      (sql) => sql<{ metadata: unknown }[]>`select metadata from audit_events`
    );
    for (const value of [world.restClientSecret, ...world.secrets]) {
      expect(findLeak(logged, value)).toBeUndefined();
      expect(findLeak(database, value)).toBeUndefined();
      expect(findLeak(answers.join("\n"), value)).toBeUndefined();
      expect(findLeak(JSON.stringify(events), value)).toBeUndefined();
    }
  });
});
