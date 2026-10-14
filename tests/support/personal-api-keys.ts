import { expect } from "vitest";
import { z } from "zod";
import {
  ApiKeyAccessTokenExchange,
  CompositeAuthAdapter,
  HmacServiceAccessTokenAuthAdapter
} from "@vivd-catalyst/auth";
import {
  clientInstanceId,
  recordAuthAdapter,
  setupAccessInstance,
  type AccessInstance
} from "./access-instance";

// The instance behind the personal API key tests: the access test instance, signed in by an
// access token where a request carries one, with the module `personalApiKeys` and the
// Namespace `kai-`.

const DAY_MS = 24 * 60 * 60 * 1000;
const createdSchema = z.object({
  key: z.object({ id: z.string(), ownerUserId: z.string(), scopes: z.array(z.string()) }).loose(),
  secret: z.string()
});
const tokenSchema = z.object({ accessToken: z.string() });

export interface PersonalKeyInstance extends AccessInstance {
  /** Kai, or whoever is named, issues a key in Settings. Returns the key and its secret. */
  issue(scopes: string[], userId?: string): Promise<z.infer<typeof createdSchema>>;
  /** What the CLI does with a key: exchange it for an access token, as a request header. */
  tokenFor(secret: string): Promise<{ authorization: string }>;
}

export async function setupPersonalKeyInstance(
  options: { module?: boolean } = {}
): Promise<PersonalKeyInstance> {
  const t = await setupAccessInstance({
    modules: { personalApiKeys: { enabled: options.module ?? true } },
    server: (stores) => {
      const keys = {
        secret: "a-test-service-access-token-secret-with-enough-length",
        clientInstanceId,
        apiAccessStore: stores.apiAccess,
        ...(options.module === false
          ? {}
          : { personalApiKeys: { store: stores.personalApiKeys, users: stores.users } })
      };
      return {
        authAdapter: new CompositeAuthAdapter([
          new HmacServiceAccessTokenAuthAdapter(keys),
          recordAuthAdapter(stores)
        ]),
        serviceAccessToken: { exchange: new ApiKeyAccessTokenExchange(keys) }
      };
    }
  });
  await t.createNamespace("kai-");
  return {
    ...t,
    async issue(scopes: string[], userId = t.kai.id) {
      const response = await t.expectOk(userId, "me.api_keys.create", {
        payload: { name: "Claude Code", scopes, expiresAt: inDays(30) }
      });
      return createdSchema.parse(response.json());
    },
    async tokenFor(secret: string) {
      const response = await t.instance.call("access_tokens.exchange", {
        headers: { authorization: `Bearer ${secret}` }
      });
      expect(response.statusCode, response.body).toBe(200);
      return bearer(tokenSchema.parse(response.json()).accessToken);
    }
  };
}

export function inDays(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString();
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

/** Kai holds reading and writing agents and reading skills in the Namespace `kai-` only. */
export async function grantKaiNamespace(t: AccessInstance) {
  const grants: Record<string, string> = {};
  for (const action of ["agent.read", "agent.write", "skill.read"]) {
    grants[action] = await t.grant(t.kai.id, action, { namespace: "kai-" });
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
