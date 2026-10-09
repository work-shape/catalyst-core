import type { AuthAdapter } from "@vivd-catalyst/auth";
import { asApiCredentialId, asClientInstanceId, asServicePrincipalId } from "@vivd-catalyst/core";
import { z } from "zod";

/**
 * Who a request of a route-helper test claims to be. The header stands in for a credential:
 * the adapter below turns it into exactly that caller, so a test states the scopes, rights and
 * sign-in method it wants the helper to judge.
 */
const callerSchema = z.object({
  kind: z.enum(["user", "service"]).default("user"),
  /** Which user or service principal calls, where a test tells two of a kind apart. */
  id: z.string().optional(),
  scopes: z.array(z.string()).default(["*"]),
  roles: z.array(z.string()).default([]),
  permissions: z.array(z.string()).default([]),
  cookie: z.boolean().default(false)
});
export type TestCaller = z.input<typeof callerSchema>;

const CALLER_HEADER = "x-test-caller";

export function asCaller(caller: TestCaller = {}): { headers: Record<string, string> } {
  return { headers: { [CALLER_HEADER]: JSON.stringify(caller) } };
}

/** An ambient adapter: it must never run when a request carries an explicit credential. */
export function createCallerAuthAdapter(): AuthAdapter & { calls: number } {
  const adapter: AuthAdapter & { calls: number } = {
    id: "test-caller",
    credentialMode: "ambient",
    calls: 0,
    authenticate(request) {
      adapter.calls += 1;
      const header = request.headers[CALLER_HEADER];
      const caller = callerSchema.parse(typeof header === "string" ? JSON.parse(header) : {});
      const { scopes } = caller;
      const clientInstanceId = asClientInstanceId(request.clientInstanceId);
      return Promise.resolve(
        caller.kind === "service"
          ? {
              kind: "service",
              id: asServicePrincipalId(caller.id ?? "sp_test"),
              credentialId: asApiCredentialId("cred_test"),
              displayLabel: "Test service",
              permissionRefs: [],
              permissions: caller.permissions,
              clientInstanceId,
              authSource: "test",
              scopes
            }
          : {
              id: caller.id ?? "usr_test",
              externalUserId: "test-user",
              displayLabel: "Test user",
              roles: caller.roles,
              permissionRefs: [],
              permissions: caller.permissions,
              clientInstanceId,
              authSource: "test",
              scopes,
              ...(caller.cookie ? { authenticationMethod: "session-cookie" as const } : {})
            }
      );
    }
  };
  return adapter;
}
