import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { parseCatalogueEntry } from "@work-shape/catalyst-connections";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { asClientInstanceId } from "@work-shape/catalyst-core";
import {
  catalogueUpdateOf,
  type CatalogueEntryOffer
} from "@work-shape/catalyst-chat-ui/build-area";
import {
  REST_CONNECTION,
  createOAuthWorld,
  landingOf,
  type OAuthWorld
} from "./support/oauth-sign-in-world";
import { withTestSql } from "./support/test-sql";
import { required } from "./support/assertions";

// MS-APP-RELINK: a Connection on the operator's managed OAuth client keeps the settings of its
// catalogue part exactly (MS-APP-1), and a release ships one version of each entry. A Connection
// installed from an earlier version is refused every change until its page relinks it to the
// current version. The relink is an ordinary write of the current version's settings: the
// people's sign-ins stay where the entry's addresses did, and end where they moved.

const instanceId = asClientInstanceId("demo-local");
const ENTRY = "sample-managed";
const offersSchema = z.object({ entries: z.array(z.custom<CatalogueEntryOffer>()) });
const storedSchema = z.looseObject({
  catalogue: z.object({ entry: z.string(), part: z.string(), version: z.number() }),
  settings: z.looseObject({
    oauth: z.looseObject({ revocationUrl: z.string(), scopes: z.array(z.string()) })
  })
});

let world: OAuthWorld;

/** Version 2 of the entry: version 1 had no admin-consent address. */
function entryAt(base: string, port: number) {
  const value = {
    id: ENTRY,
    version: 2,
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
        tokenAuthMethod: "client_secret_post",
        adminConsent: { url: `${base}/oauth-rest/adminconsent`, errorCodes: ["SAMPLE_CONSENT"] }
      },
      managedClient: "sample",
      settings: { baseUrl: `${base}/oauth-rest/api`, testPath: "/customers" },
      fields: [
        { setting: "oauth.clientId", label: { en: "Client ID", de: "Client-ID" } },
        { secret: true, label: { en: "Client secret", de: "Client-Secret" } }
      ],
      egress: [
        { protocol: "http", host: "127.0.0.1", port, network: "private", cidrs: ["127.0.0.1/32"] }
      ],
      groups: [
        { id: "identity", title: { en: "Identity", de: "Identität" }, scopes: ["sample.identity"] },
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
}, 60_000);

afterAll(async () => {
  await world?.close();
});

/** What the install dialog writes for version 2, on the managed client. */
function installed() {
  const offered = entryAt(world.sample, Number(new URL(world.sample).port)).tools;
  return {
    displayName: "Sample mail",
    connectorType: "http_api",
    service: "sample-managed",
    authScheme: "oauth",
    credentialMode: "user",
    catalogue: { entry: ENTRY, part: "tools", version: 2 },
    settings: {
      ...offered?.settings,
      oauth: { ...offered?.oauth, managedClient: "sample" }
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
    enabled: true
  };
}

async function connect(cookie: string): Promise<void> {
  const started = await world.start(REST_CONNECTION, cookie);
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const authorizationUrl = z.object({ authorizationUrl: z.string() }).parse(started.body);
  const back = await world.authorize(authorizationUrl.authorizationUrl);
  const landed = await world.callback(back, { cookie });
  expect(landingOf(landed.location)).toEqual({ signIn: "connected", connection: REST_CONNECTION });
}

async function bindingOf(cookie: string) {
  const userId = await world.userIdOf(cookie);
  const [row] = await withTestSql(
    (sql) => sql<{ state: string; secrets: number }[]>`
      select b.state,
        (select count(*)::int from secrets s
          where s.connection_asset_id = a.id and s.subject like ${`%user:${userId}`}) as secrets
      from config_assets a join connection_bindings b
        on b.connection_asset_id = a.id and b.subject = ${`user:${userId}`}
      where a.kind = 'connection' and a.name = ${REST_CONNECTION}
      limit 1`
  );
  return row ?? { state: "none", secrets: 0 };
}

/**
 * Turns the stored Connection into one an earlier release installed from version 1: the link
 * at version 1, no admin-consent address, and the revocation address of `revocationUrl`.
 */
async function storedAsVersion1(revocationUrl: string): Promise<void> {
  await withTestSql(async (sql) => {
    const [row] = await sql<{ id: string; config: unknown }[]>`
      select r.id, r.config from config_assets a
      join config_asset_revisions r on r.id = a.active_revision_id
      where a.kind = 'connection' and a.name = ${REST_CONNECTION}`;
    const config = storedSchema.parse(required(row).config);
    const { adminConsent: _adminConsent, ...oauth } = config.settings.oauth;
    const older = {
      ...config,
      catalogue: { ...config.catalogue, version: 1 },
      settings: { ...config.settings, oauth: { ...oauth, revocationUrl } }
    };
    await sql`update config_asset_revisions set config = ${sql.json(older)}
      where id = ${required(row).id}`;
  });
}

async function stored() {
  const asset = await world.instance.stores.configAssets.getConfigAsset({
    clientInstanceId: instanceId,
    kind: "connection",
    name: REST_CONNECTION
  });
  return required(asset);
}

async function put(config: Record<string, unknown>, cookie: string) {
  const answer = await world.instance.call(
    "assets.put",
    {
      params: { kind: "connection", name: REST_CONNECTION },
      payload: {
        config: { ...config, name: REST_CONNECTION },
        expectedRevision: (await stored()).revision
      }
    },
    { headers: { cookie, origin: "http://localhost:5173" } }
  );
  return { status: answer.statusCode, body: JSON.stringify(answer.json()) };
}

/** The update the Connection's page offers, from the entries the instance offers. */
async function offeredUpdate(cookie: string) {
  const descriptor = apiOperations["connections.connector_types"];
  const response = await fetch(`${world.api}${descriptor.buildPath({ params: {} })}`, {
    headers: { cookie, origin: "http://localhost:5173" }
  });
  const offers = offersSchema.parse(await response.json());
  const config = z.record(z.string(), z.unknown()).parse((await stored()).config);
  return required(catalogueUpdateOf(config, offers.entries));
}

describe("a managed Connection installed from an earlier entry version", () => {
  it("is refused other changes, and its relink keeps the sign-ins where the addresses stayed", async () => {
    const alice = await world.signIn("alice");
    expect(await world.putConnection(REST_CONNECTION, installed(), alice)).toBe(200);
    await connect(alice);
    await storedAsVersion1(`${world.sample}/oauth-rest/revoke`);

    // Turning its tool off waits for the update.
    const config = z.record(z.string(), z.unknown()).parse((await stored()).config);
    const toolOff = await put(
      {
        ...config,
        operations: installed().operations.map((operation) => ({ ...operation, enabled: false }))
      },
      alice
    );
    expect(toolOff.status, toolOff.body).toBe(422);
    expect(toolOff.body).toContain("catalogue_update_required");

    const update = await offeredUpdate(alice);
    expect(update.from).toBe(1);
    expect(update.changed).toEqual(["oauth.adminConsent"]);
    const relinked = await put(update.config, alice);
    expect(relinked.status, relinked.body).toBe(200);
    const after = storedSchema.parse((await stored()).config);
    expect(after.catalogue.version).toBe(2);
    expect(after.settings.oauth.scopes).toEqual(["sample.identity", "sample.read"]);

    // Alice stays signed in and her agent reads as before.
    expect(await bindingOf(alice)).toEqual({ state: "connected", secrets: 1 });
    const outcome = await world.call(REST_CONNECTION, "listCustomers", alice, "agent");
    expect(outcome.result).toMatchObject({ status: "done" });
    // And now the tool can be turned off.
    const later = z.record(z.string(), z.unknown()).parse((await stored()).config);
    const turnedOff = await put(
      {
        ...later,
        operations: installed().operations.map((operation) => ({ ...operation, enabled: false }))
      },
      alice
    );
    expect(turnedOff.status, turnedOff.body).toBe(200);
  });

  it("ends the sign-ins where the current version signs in at another address", async () => {
    const alice = await world.signIn("alice");
    expect(await world.putConnection(REST_CONNECTION, installed(), alice)).toBe(200);
    await connect(alice);
    expect(await bindingOf(alice)).toMatchObject({ state: "connected" });
    // Version 1 revoked at another address: the relink moves where the sign-in's grant goes.
    await storedAsVersion1(`${world.sample}/oauth-rest/revoke-v1`);

    const update = await offeredUpdate(alice);
    expect(update.changed).toEqual(["oauth.adminConsent", "oauth.revocationUrl"]);
    const relinked = await put(update.config, alice);
    expect(relinked.status, relinked.body).toBe(200);
    const ended = await bindingOf(alice);
    expect(ended.state).not.toBe("connected");
    expect(ended.secrets).toBe(0);
  });
});

describe("the relink takes only the current version", () => {
  it("refuses a write that names another version, and a revert to the revision before it", async () => {
    const alice = await world.signIn("alice");
    expect(await world.putConnection(REST_CONNECTION, installed(), alice)).toBe(200);
    await storedAsVersion1(`${world.sample}/oauth-rest/revoke`);
    const before = (await stored()).revision;
    const update = await offeredUpdate(alice);
    expect((await put(update.config, alice)).status).toBe(200);

    // The current settings under an earlier or a later version's link: refused either way.
    for (const version of [1, 3]) {
      const forged = await put(
        { ...update.config, catalogue: { entry: ENTRY, part: "tools", version } },
        alice
      );
      expect(forged.status, forged.body).toBe(422);
      expect(storedSchema.parse((await stored()).config).catalogue.version).toBe(2);
    }
    // The revision of version 1 cannot come back by a revert either.
    const reverted = await world.instance.call(
      "assets.revert",
      {
        params: { kind: "connection", name: REST_CONNECTION },
        payload: { revision: before, expectedRevision: (await stored()).revision }
      },
      { headers: { cookie: alice, origin: "http://localhost:5173" } }
    );
    expect(reverted.statusCode, JSON.stringify(reverted.json())).toBe(422);
    expect(JSON.stringify(reverted.json())).toMatch(
      /catalogue_entry_not_offered|catalogue_update_required/u
    );
    // No refusal names the entry's settings.
    expect(JSON.stringify(reverted.json())).not.toContain("oauth-rest");
    expect(storedSchema.parse((await stored()).config).catalogue.version).toBe(2);
  });
});
