import type { AuthAdapter } from "@vivd-catalyst/auth";
import {
  LEGACY_LIST_GRANTOR,
  LEGACY_PERMISSION_ACTIONS,
  PERMISSIONS,
  asApiCredentialId,
  asClientInstanceId,
  asServicePrincipalId,
  legacyGrantRows
} from "@vivd-catalyst/core";
import { z } from "zod";
import { withTestSql } from "./test-sql";

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

const LEGACY_ACTIONS: string[] = PERMISSIONS.flatMap((key) => [...LEGACY_PERMISSION_ACTIONS[key]]);

/**
 * Since AP-4 a caller's legacy list is its instance-wide grant rows, which the evaluator reads
 * from the store; the identity-resolving adapter writes them for a real sign-in. This writes
 * them for a test caller as the list it claims, on every request that claims one (a test may
 * have emptied the database since) and once more when a caller drops its list, so a caller
 * that never claims a right never touches the database. A service caller is stored too: a row
 * applies only to a principal the instance has.
 */
async function writeCallerRows(input: {
  clientInstanceId: string;
  holderKind: "user" | "service_principal";
  holderId: string;
  permissions: readonly string[];
}): Promise<void> {
  // One transaction under the instance's access lock: a request beside it sees the rows of
  // before or of after, never none.
  await withTestSql((connection) =>
    connection.begin(async (sql) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`access:${input.clientInstanceId}`}, 0))`;
      if (input.holderKind === "service_principal") {
        await sql`
        insert into service_principals
          (id, client_instance_id, display_label, status, permission_refs, created_at, updated_at)
        values (${input.holderId}, ${input.clientInstanceId}, 'Test service', 'active', '[]'::jsonb, now(), now())
        on conflict do nothing`;
      }
      await sql`
      delete from permission_grants
      where client_instance_id = ${input.clientInstanceId} and holder_kind = ${input.holderKind}
        and holder_id = ${input.holderId} and scope_kind = 'instance'
        and action in ${sql(LEGACY_ACTIONS)}`;
      for (const row of legacyGrantRows(input.permissions)) {
        await sql`
        insert into permission_grants
          (id, client_instance_id, holder_kind, holder_id, action, scope_kind, effect, granted_by, created_at)
        values
          (${`grant_${crypto.randomUUID()}`}, ${input.clientInstanceId}, ${input.holderKind},
           ${input.holderId}, ${row.action}, 'instance', ${row.effect}, ${LEGACY_LIST_GRANTOR}, now())`;
      }
    })
  );
}

/** An ambient adapter: it must never run when a request carries an explicit credential. */
export function createCallerAuthAdapter(): AuthAdapter & { calls: number } {
  const written = new Set<string>();
  const adapter: AuthAdapter & { calls: number } = {
    id: "test-caller",
    credentialMode: "ambient",
    calls: 0,
    async authenticate(request) {
      adapter.calls += 1;
      const header = request.headers[CALLER_HEADER];
      const caller = callerSchema.parse(typeof header === "string" ? JSON.parse(header) : {});
      const { scopes } = caller;
      const clientInstanceId = asClientInstanceId(request.clientInstanceId);
      const holderKind = caller.kind === "service" ? "service_principal" : "user";
      const holderId = caller.id ?? (caller.kind === "service" ? "sp_test" : "usr_test");
      const holder = `${clientInstanceId}|${holderKind}|${holderId}`;
      if (caller.permissions.length > 0 || written.has(holder)) {
        await writeCallerRows({
          clientInstanceId,
          holderKind,
          holderId,
          permissions: caller.permissions
        });
        if (caller.permissions.length > 0) written.add(holder);
        else written.delete(holder);
      }
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
