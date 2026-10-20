import { expect } from "vitest";
import { z } from "zod";
import {
  ApiKeyAccessTokenExchange,
  CompositeAuthAdapter,
  HmacServiceAccessTokenAuthAdapter
} from "@work-shape/catalyst-auth";
import {
  clientInstanceId,
  recordAuthAdapter,
  setupAccessInstance,
  type AccessInstance
} from "./access-instance";
import type { TestStore } from "./test-instance";

// The instance behind the personal API key tests: the access test instance, signed in by an
// access token where a request carries one, with the module `personalApiKeys` and the
// Shared Workspace `Kai Spezis`.

const DAY_MS = 24 * 60 * 60 * 1000;
const createdSchema = z.object({
  key: z.object({ id: z.string(), ownerUserId: z.string(), scopes: z.array(z.string()) }).loose(),
  secret: z.string()
});
const tokenSchema = z.object({ accessToken: z.string() });

export interface PersonalKeyInstance extends AccessInstance {
  /** The id of the Shared Workspace `Kai Spezis`, which the administrator created. */
  kaiTeam: string;
  /** Kai, or whoever is named, issues a key in Settings. Returns the key and its secret. */
  issue(scopes: string[], userId?: string): Promise<z.infer<typeof createdSchema>>;
  /** What the CLI does with a key: exchange it for an access token, as a request header. */
  tokenFor(secret: string): Promise<{ authorization: string }>;
}

/**
 * What an instance needs to take personal keys: the module on, a request signed in by an
 * access token where it carries one, and the exchange of a key for a token.
 */
export function personalKeyServer(stores: TestStore, moduleOn = true) {
  const keys = {
    secret: "a-test-service-access-token-secret-with-enough-length",
    clientInstanceId,
    apiAccessStore: stores.apiAccess,
    ...(moduleOn ? { personalApiKeys: { store: stores.personalApiKeys, users: stores.users } } : {})
  };
  return {
    authAdapter: new CompositeAuthAdapter([
      new HmacServiceAccessTokenAuthAdapter(keys),
      recordAuthAdapter()
    ]),
    serviceAccessToken: { exchange: new ApiKeyAccessTokenExchange(keys) }
  };
}

/** Kai, or whoever is named, issues a key in Settings. Returns the key and its secret. */
export async function issuePersonalKey(
  t: AccessInstance,
  scopes: string[],
  userId: string = t.kai.id
) {
  const response = await t.expectOk(userId, "me.api_keys.create", {
    payload: { name: "Claude Code", scopes, expiresAt: inDays(30) }
  });
  return createdSchema.parse(response.json());
}

/** What the CLI does with a key: exchange it for an access token, as a request header. */
export async function personalKeyToken(t: AccessInstance, secret: string) {
  const response = await t.instance.call("access_tokens.exchange", {
    headers: { authorization: `Bearer ${secret}` }
  });
  expect(response.statusCode, response.body).toBe(200);
  return bearer(tokenSchema.parse(response.json()).accessToken);
}

export async function setupPersonalKeyInstance(
  options: { module?: boolean } = {}
): Promise<PersonalKeyInstance> {
  const t = await setupAccessInstance({
    modules: { personalApiKeys: { enabled: options.module ?? true } },
    server: (stores) => personalKeyServer(stores, options.module !== false)
  });
  const kaiTeam = await t.sharedWorkspace("Kai Spezis");
  return {
    ...t,
    kaiTeam,
    issue: (scopes, userId) => issuePersonalKey(t, scopes, userId),
    tokenFor: (secret) => personalKeyToken(t, secret)
  };
}

export function inDays(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString();
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

/** Kai holds reading and writing agents and reading skills in the workspace `Kai Spezis` only. */
export async function grantKaiWorkspace(t: PersonalKeyInstance) {
  const grants: Record<string, string> = {};
  for (const action of ["agent.read", "agent.write", "skill.read"]) {
    grants[action] = await t.grant(t.kai.id, action, { workspaceId: t.kaiTeam });
  }
  return grants;
}

export function agentConfig(name: string) {
  return {
    name,
    displayName: name,
    instructions: "Help.",
    modelProviderId: "local",
    toolNames: [],
    skillNames: [],
    initialPrompts: []
  };
}
