import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  adminConsentUrl,
  asksAdminConsent,
  createHttpApiConnectorType,
  parseCatalogueEntry
} from "@work-shape/catalyst-connections";
import {
  REST_CLIENT_ID,
  REST_CONNECTION,
  callbackPathOf,
  createOAuthWorld,
  landingOf,
  redirectUriOf,
  type OAuthWorld
} from "./support/oauth-sign-in-world";
import { withTestSql } from "./support/test-sql";

// MS-APP-2: where the organisation lets only an administrator approve the app, the provider
// refuses a person's sign-in with an error the catalogue entry names. The sign-in lands on
// "needs IT approval" with the admin-consent link; the link brings the administrator back to
// the same callback, which says the app is approved and changes nothing; then the same person
// connects. The vendor-free stand-in is the demo sample's REST provider (`/oauth-rest`).

const ENTRY = "sample-approval";
/** The code the sample server's refusal carries while its client awaits approval. */
const SAMPLE_ADMIN_CONSENT_ERROR_CODE = "SAMPLE_ADMIN_CONSENT";
const startSchema = z.object({
  authorizationUrl: z.string().url(),
  adminConsentUrl: z.string().url().optional()
});
const detailSchema = z.object({
  oauth: z.object({ adminConsentUrl: z.string().url().optional() }).optional()
});

let world: OAuthWorld;

function entryAt(base: string, port: number) {
  const value = {
    id: ENTRY,
    version: 1,
    service: "sample-approval",
    title: { en: "Sample approval", de: "Beispielfreigabe" },
    description: { en: "Read sample customers.", de: "Beispielkunden lesen." },
    category: "other",
    examplePrompts: [{ en: "List the sample customers.", de: "Zeig die Beispielkunden." }],
    mark: { color: "#325676" },
    tools: {
      connectorType: "http_api",
      name: REST_CONNECTION,
      description: { en: "Read sample customers.", de: "Beispielkunden lesen." },
      authScheme: "oauth",
      credentialModes: ["user"],
      oauth: {
        authorizationUrl: `${base}/oauth-rest/authorize`,
        tokenUrl: `${base}/oauth-rest/token`,
        revocationUrl: `${base}/oauth-rest/revoke`,
        tokenAuthMethod: "client_secret_post",
        adminConsent: {
          url: `${base}/oauth-rest/adminconsent`,
          errorCodes: [SAMPLE_ADMIN_CONSENT_ERROR_CODE]
        }
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
        en: "Each person connects their own account.",
        de: "Jede Person verbindet ihr eigenes Konto."
      }
    }
  };
  return parseCatalogueEntry(JSON.stringify(value), `${ENTRY}/entry.yaml`);
}

function installed() {
  return {
    displayName: "Sample approval",
    connectorType: "http_api",
    service: "sample-approval",
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
        adminConsent: {
          url: `${world.sample}/oauth-rest/adminconsent`,
          errorCodes: [SAMPLE_ADMIN_CONSENT_ERROR_CODE]
        },
        managedClient: "sample",
        scopes: ["sample.identity", "sample.read"]
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
    enabled: true
  };
}

async function started(cookie: string) {
  const answer = await world.start(REST_CONNECTION, cookie);
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return startSchema.parse(answer.body);
}

async function storedForConnection() {
  return withTestSql(async (sql) => ({
    bindings: (
      await sql`select b.state from connection_bindings b join config_assets a
        on a.id = b.connection_asset_id where a.name = ${REST_CONNECTION}`
    ).length,
    tokenSets: (
      await sql`select s.subject from secrets s join config_assets a
        on a.id = s.connection_asset_id where a.name = ${REST_CONNECTION}`
    ).length
  }));
}

beforeAll(async () => {
  world = await createOAuthWorld({
    managedClient: "sample",
    catalogue: (base, port) => [entryAt(base, port)]
  });
  const alice = await world.signIn("alice");
  expect(await world.putConnection(REST_CONNECTION, installed(), alice)).toBe(200);
}, 60_000);

afterAll(async () => {
  await world?.close();
});

describe("admin consent on a sign-in", () => {
  it("refuses a call before the person connected as not connected", async () => {
    const alice = await world.signIn("alice");
    const outcome = await world.call(REST_CONNECTION, "listCustomers", alice, "agent");
    expect(JSON.stringify(outcome.result)).toContain("connection_not_connected");
  });

  it("names the approval link in the start and on the Connection's page", async () => {
    const alice = await world.signIn("alice");
    const { adminConsentUrl: link } = await started(alice);
    const url = new URL(link ?? "");
    expect(`${url.origin}${url.pathname}`).toBe(`${world.sample}/oauth-rest/adminconsent`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: REST_CLIENT_ID,
      scope: "sample.identity sample.read",
      redirect_uri: redirectUriOf(REST_CONNECTION),
      state: "admin_consent"
    });
    const detail = detailSchema.parse(JSON.parse(await world.detail(REST_CONNECTION, alice)));
    expect(detail.oauth?.adminConsentUrl).toBe(link);
  });

  it("lands on needs-approval when the provider asks for an administrator, and stores nothing", async () => {
    const alice = await world.signIn("alice");
    world.oauth.controls.restAdminConsentRequired = true;
    const { authorizationUrl } = await started(alice);
    const back = await world.authorize(authorizationUrl);
    expect(back.searchParams.get("code")).toBeNull();
    const before = await storedForConnection();
    expect(landingOf((await world.callback(back, { cookie: alice })).location)).toEqual({
      signIn: "oauth_admin_consent_required",
      connection: REST_CONNECTION
    });
    expect(await storedForConnection()).toEqual(before);
    const [refusal] = await withTestSql(
      (sql) => sql<{ reason: string }[]>`
        select reason from audit_events where type = 'connection.oauth_refused'
        order by created_at desc limit 1`
    );
    expect(refusal?.reason).toBe("oauth_admin_consent_required");
  });

  it("lands an administrator back from the link on approved, signed in or not, and changes nothing", async () => {
    const alice = await world.signIn("alice");
    const { adminConsentUrl: link } = await started(alice);
    const before = await storedForConnection();
    // The administrator approves at the provider, which sends the browser back to the callback.
    const back = await world.authorize(link ?? "");
    expect(back.pathname).toBe(callbackPathOf(REST_CONNECTION));
    expect(back.searchParams.get("state")).toBe("admin_consent");
    for (const headers of [{}, { cookie: alice }] as Record<string, string>[]) {
      expect(landingOf((await world.callback(back, headers)).location)).toEqual({
        signIn: "admin_consented",
        connection: REST_CONNECTION
      });
    }
    // An administrator who declined lands on declined.
    const declined = new URL(back);
    declined.search = "";
    declined.searchParams.set("error", "access_denied");
    declined.searchParams.set("state", "admin_consent");
    expect(landingOf((await world.callback(declined)).location)).toEqual({
      signIn: "oauth_denied",
      connection: REST_CONNECTION
    });
    expect(await storedForConnection()).toEqual(before);
  });

  it("connects the same person once the administrator approved", async () => {
    expect(world.oauth.controls.restAdminConsentRequired).toBe(false);
    const alice = await world.signIn("alice");
    const { authorizationUrl } = await started(alice);
    const back = await world.authorize(authorizationUrl);
    expect(landingOf((await world.callback(back, { cookie: alice })).location)).toEqual({
      signIn: "connected",
      connection: REST_CONNECTION
    });
  });

  it("keeps any other refusal as declined", async () => {
    const alice = await world.signIn("alice");
    const { authorizationUrl } = await started(alice);
    const declined = new URL(await world.authorize(authorizationUrl));
    declined.searchParams.delete("code");
    declined.searchParams.set("error", "access_denied");
    declined.searchParams.set("error_description", "The person cancelled.");
    expect(landingOf((await world.callback(declined, { cookie: alice })).location)).toEqual({
      signIn: "oauth_denied",
      connection: REST_CONNECTION
    });
  });
});

describe("the admin-consent settings", () => {
  const endpoints = {
    clientId: "client-1",
    scopes: ["openid", "Mail.Read"],
    adminConsent: {
      url: "https://login.example.test/organizations/v2.0/adminconsent",
      errorCodes: ["CODE65001", "CODE90094"]
    }
  };

  it("match a code as the error or a word of its description, never a part of one", () => {
    expect(asksAdminConsent(endpoints, { error: "CODE65001" })).toBe(true);
    expect(
      asksAdminConsent(endpoints, {
        error: "access_denied",
        error_description: "CODE90094: The grant requires admin permission."
      })
    ).toBe(true);
    expect(
      asksAdminConsent(endpoints, { error: "access_denied", error_description: "XCODE65001" })
    ).toBe(false);
    expect(asksAdminConsent({}, { error: "CODE65001" })).toBe(false);
  });

  it("build the link from the client id, the scopes and the redirect URI only", () => {
    expect(adminConsentUrl(endpoints, "https://chat.example.test/cb")).toBe(
      "https://login.example.test/organizations/v2.0/adminconsent?client_id=client-1&scope=openid+Mail.Read&redirect_uri=https%3A%2F%2Fchat.example.test%2Fcb&state=admin_consent"
    );
    expect(adminConsentUrl(endpoints, undefined)).toBeUndefined();
  });

  it("refuse an address on another origin than the sign-in's, or with a query", () => {
    const type = createHttpApiConnectorType({});
    const settings = (url: string) => ({
      baseUrl: "https://api.example.test",
      oauth: {
        authorizationUrl: "https://login.example.test/{tenant}/authorize",
        tokenUrl: "https://login.example.test/{tenant}/token",
        pathParams: { tenant: "organizations" },
        clientId: "client-1",
        adminConsent: { url, errorCodes: ["CODE65001"] }
      }
    });
    expect(
      type.settingsSchema.safeParse(settings("https://login.example.test/{tenant}/adminconsent"))
        .success
    ).toBe(true);
    expect(
      type.settingsSchema.safeParse(settings("https://elsewhere.example.test/adminconsent")).success
    ).toBe(false);
    expect(
      type.settingsSchema.safeParse(settings("https://login.example.test/adminconsent?x=1")).success
    ).toBe(false);
    const parsed = type.settingsSchema.safeParse(
      settings("https://login.example.test/{tenant}/adminconsent")
    );
    if (!parsed.success) throw new Error("The settings did not parse");
    const endpointsOf = type.oauthEndpoints?.(parsed.data);
    expect(endpointsOf?.adminConsent?.url).toBe(
      "https://login.example.test/organizations/adminconsent"
    );
  });
});
