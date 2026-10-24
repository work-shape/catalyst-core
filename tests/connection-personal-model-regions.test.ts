import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { OperationCallRuntime } from "@work-shape/catalyst-core";
import { createOAuthWorld, landingOf, type OAuthWorld } from "./support/oauth-sign-in-world";
import { createPersonalOAuthProvider } from "./support/personal-oauth-provider";
import { getTestExecution } from "./support/test-instance";

// MODEL-REGION-2: release config widens the regions a personal call admits. The instance is
// assembled from that config, so the test also proves the setting reaches the check.
let world: OAuthWorld;
let fake: Awaited<ReturnType<typeof createPersonalOAuthProvider>>;
let alice: string;

beforeAll(async () => {
  fake = await createPersonalOAuthProvider();
  world = await createOAuthWorld({
    extraPort: Number(new URL(fake.base).port),
    personalModelRegions: ["eu", "us"]
  });
  alice = await world.signIn("alice");
  expect(await world.putConnection("mailbox", definition(), alice)).toBe(200);
  expect(await world.setSecret("mailbox", fake.clientSecret, alice)).toBe(200);
  const started = await world.start("mailbox", alice);
  const url = new URL(
    z.object({ authorizationUrl: z.string() }).parse(started.body).authorizationUrl
  );
  url.searchParams.set("person", "A");
  expect(
    landingOf((await world.callback(await world.authorize(url.href), { cookie: alice })).location)
      .signIn
  ).toBe("connected");
}, 60_000);
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await world?.close();
  await fake?.close();
});

function definition() {
  return {
    connectorType: "http_api",
    displayName: "Personal mail",
    credentialMode: "user",
    settings: {
      baseUrl: `${fake.base}/personal-api`,
      oauth: {
        authorizationUrl: `${fake.base}/authorize`,
        tokenUrl: `${fake.base}/token`,
        clientId: "personal-client",
        scopes: ["openid", "email", "sample.read"]
      }
    },
    authScheme: "oauth",
    enabled: true,
    operations: [
      {
        name: "who",
        description: "Read the current account",
        method: "GET",
        path: "/who",
        effect: "reading",
        exposure: ["agent"],
        enabled: true
      }
    ]
  };
}

function resolverSpy() {
  const resolver = getTestExecution(world.worker).connections?.credentials;
  if (!resolver) throw new Error("No credential resolver");
  return vi.spyOn(resolver, "resolveSignIn");
}

const call = (modelRoutes: OperationCallRuntime["modelRoutes"]) =>
  world.call("mailbox", "who", alice, "agent", modelRoutes);

describe("personal model regions widened to eu and us", () => {
  it("admits a run whose every route is in the list", async () => {
    for (const modelRoutes of [
      [{ id: "outside", region: "us" }],
      [
        { id: "primary", region: "eu" },
        { id: "fallback", region: "us" }
      ]
    ]) {
      expect((await call(modelRoutes)).result).toMatchObject({ status: "done" });
    }
  });

  it("refuses a route outside the list or without a region, naming the allowed regions only", async () => {
    const spy = resolverSpy();
    const before = fake.headers.length;
    const routes: OperationCallRuntime["modelRoutes"][] = [
      [{ id: "route-name-canary", region: "global" }],
      [
        { id: "primary", region: "eu" },
        { id: "route-name-canary", region: "apac-canary" }
      ],
      [{ id: "route-name-canary" }],
      []
    ];
    for (const modelRoutes of routes) {
      const answer = await call(modelRoutes);
      expect(answer.result).toMatchObject({
        status: "failed",
        error: {
          code: "FORBIDDEN",
          message:
            "This instance cannot use personal Connections with its model setup. Every model route of the run has to declare one of the regions allowed for personal Connections: eu, us."
        }
      });
      if (answer.result.status === "failed") {
        // No Connect card: the details carry the reason alone.
        expect(answer.result.error.details).toEqual({ reason: "personal_connection_region" });
      }
      expect(JSON.stringify(answer)).not.toMatch(/canary/u);
    }
    expect(spy).not.toHaveBeenCalled();
    expect(fake.headers).toHaveLength(before);
  });
});
