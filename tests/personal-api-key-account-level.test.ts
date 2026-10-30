import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  apiOperations,
  operationPathParamNames,
  type Operation
} from "@work-shape/catalyst-api-contract";
import {
  asCollaborationWorkspaceId,
  PERSONAL_API_KEY_ACCOUNT_LEVEL_ACTIONS,
  PERSONAL_API_KEY_ACTIONS,
  operationScopesOfPersonalApiKey,
  parsePersonalApiKeyScope,
  requirePersonalApiKeyScopes
} from "@work-shape/catalyst-core";
import { clientInstanceId, errorSchema } from "./support/access-instance";
import {
  inDays,
  setupPersonalKeyInstance,
  type PersonalKeyInstance
} from "./support/personal-api-keys";
import type { TestCallInput, TestOperationName } from "./support/operations";

// CLI-PARITY-5: the account and workspaces level of a personal key. `account.manage` changes the
// person's own name and model preference and revokes their keys; `collaboration_workspace.manage`
// reaches the Shared Workspaces through the same checks as the screen. A key without the level is
// refused each with the action named, and the level opens nothing beside these operations.

const NOW = new Date().toISOString();
const ACCOUNT = "account.manage";
const WORKSPACES = "collaboration_workspace.manage";

const workspaceSchema = z.object({ id: z.string(), name: z.string() }).loose();
const pageSchema = z.object({ items: z.array(z.record(z.string(), z.unknown())) });
const createdKeySchema = z.object({ key: z.object({ id: z.string() }).loose() }).loose();

/** The operations of the level, each with the action a key must name for it. */
type LevelAction = typeof ACCOUNT | typeof WORKSPACES;
const LEVEL_OPERATIONS = Object.values<Operation>(apiOperations).flatMap(
  (operation): (readonly [string, LevelAction])[] =>
    operation.personalKeyScope === "account:manage"
      ? [[operation.id, ACCOUNT] as const]
      : operation.personalKeyScope === "workspaces:manage"
        ? [[operation.id, WORKSPACES] as const]
        : []
);

function isTestOperation(name: string): name is TestOperationName {
  return Object.hasOwn(apiOperations, name);
}

/** The path parameters an operation takes, each from the values given. */
function paramsOf(operation: string, values: Record<string, string>) {
  const path = Object.values<Operation>(apiOperations).find((item) => item.id === operation)?.path;
  return Object.fromEntries(
    operationPathParamNames(path ?? "").map((name) => [name, values[name] ?? "x"])
  );
}

async function person(t: PersonalKeyInstance, name: string) {
  return t.stores.users.createUser({
    clientInstanceId,
    displayLabel: name,
    email: `${name.toLowerCase()}@example.test`,
    roles: ["user"]
  });
}

async function keyHeaders(t: PersonalKeyInstance, userId: string, scopes: string[]) {
  const { secret, key } = await t.issue(scopes, userId);
  return { headers: await t.tokenFor(secret), keyId: key.id };
}

/** The same call made on the screen and with a key: the answer is the same. */
async function sameAsScreen(
  t: PersonalKeyInstance,
  userId: string,
  headers: Record<string, string>,
  operation: TestOperationName,
  input: TestCallInput
) {
  const screen = await t.call(userId, operation, input);
  const key = await t.call(userId, operation, { ...input, headers });
  expect(screen.statusCode, `${operation} on the screen: ${screen.body}`).toBeGreaterThanOrEqual(
    400
  );
  expect({ status: key.statusCode, error: errorSchema.parse(key.json()).error }).toEqual({
    status: screen.statusCode,
    error: errorSchema.parse(screen.json()).error
  });
  return errorSchema.parse(key.json()).error;
}

async function auditEvents(t: PersonalKeyInstance, type: string) {
  return (await t.stores.audit.listAuditEvents({ clientInstanceId, limit: 500 })).filter(
    (event) => event.type === type
  );
}

describe("the account and workspaces level of a personal key", () => {
  it("is two actions: the account over the whole account, the workspaces narrowed to one workspace at most", () => {
    expect([...PERSONAL_API_KEY_ACCOUNT_LEVEL_ACTIONS]).toEqual([ACCOUNT, WORKSPACES]);
    for (const action of PERSONAL_API_KEY_ACCOUNT_LEVEL_ACTIONS) {
      expect(PERSONAL_API_KEY_ACTIONS).toContain(action);
      expect(requirePersonalApiKeyScopes([action])).toEqual([{ action }]);
    }
    expect(operationScopesOfPersonalApiKey([ACCOUNT], NOW)).toEqual(["me:read", "account:manage"]);
    expect(operationScopesOfPersonalApiKey([WORKSPACES], NOW)).toEqual([
      "me:read",
      "workspaces:manage"
    ]);
    expect(parsePersonalApiKeyScope(`${WORKSPACES}:ws-1`)).toEqual({
      action: WORKSPACES,
      workspaceId: "ws-1"
    });
    for (const scope of [`${ACCOUNT}:ws-1`, `${ACCOUNT}:ws-1/a`, `${WORKSPACES}:ws-1/a`]) {
      expect(parsePersonalApiKeyScope(scope)).toBeUndefined();
      expect(() => requirePersonalApiKeyScopes([scope])).toThrow("no scope");
    }
    // `me:write` and `collaboration_workspace:*` stay off every key, also the widest.
    const widest = operationScopesOfPersonalApiKey(PERSONAL_API_KEY_ACTIONS, NOW);
    for (const scope of [
      "me:write",
      "collaboration_workspace:read",
      "collaboration_workspace:manage"
    ]) {
      expect(widest).not.toContain(scope);
    }
    expect(LEVEL_OPERATIONS.map(([id]) => id).sort()).toEqual(
      [
        "me.update",
        "me.model_preference.set",
        "me.api_keys.revoke",
        "workspaces.list",
        "workspaces.create",
        "workspaces.directory.list",
        "workspaces.get",
        "workspaces.update",
        "workspaces.deletion_impact.get",
        "workspaces.delete",
        "workspaces.members.list",
        "workspaces.member_candidates.list",
        "workspaces.members.add",
        "workspaces.members.update_role",
        "workspaces.members.remove",
        "workspaces.members.leave",
        "workspaces.access_requests.create",
        "workspaces.access_requests.list",
        "workspaces.access_requests.approve",
        "workspaces.access_requests.decline"
      ].sort()
    );
  });

  it("is issued to a person who holds no right at all, since no grant gives it", async () => {
    const t = await setupPersonalKeyInstance();
    const { key } = await t.issue([ACCOUNT, WORKSPACES, `${WORKSPACES}:${t.kaiTeam}`]);
    expect(key.scopes).toEqual([ACCOUNT, WORKSPACES, `${WORKSPACES}:${t.kaiTeam}`]);
    const unknown = await t.call(t.kai.id, "me.api_keys.create", {
      payload: { name: "Nowhere", scopes: [`${WORKSPACES}:ws-none`], expiresAt: inDays(1) }
    });
    expect(unknown.statusCode).toBe(422);
  });

  it("refuses every operation of the level to a key without it, naming the action the key lacks", async () => {
    const t = await setupPersonalKeyInstance();
    // Every action a key may name but the level's: the widest key without it.
    const without = PERSONAL_API_KEY_ACTIONS.filter(
      (action) => !PERSONAL_API_KEY_ACCOUNT_LEVEL_ACTIONS.some((level) => level === action)
    );
    const keys = [
      (await keyHeaders(t, t.root.id, [...without])).headers,
      (await keyHeaders(t, t.root.id, ["agent.read", "agent.write", "workflow.use"])).headers
    ];
    // Each half of the level opens its own operations only.
    const halves = {
      [ACCOUNT]: (await keyHeaders(t, t.root.id, [WORKSPACES])).headers,
      [WORKSPACES]: (await keyHeaders(t, t.root.id, [ACCOUNT])).headers
    };
    for (const [operation, action] of LEVEL_OPERATIONS) {
      if (!isTestOperation(operation)) throw new Error(operation);
      const params = paramsOf(operation, {
        collaborationWorkspaceId: t.kaiTeam,
        userId: t.kai.id
      });
      for (const headers of [...keys, halves[action]]) {
        const response = await t.call(t.root.id, operation, { params, headers });
        expect(response.statusCode, `${operation}: ${response.body}`).toBe(403);
        const { error } = errorSchema.parse(response.json());
        expect(error.message).toContain(`'${action}'`);
        expect(error.message).toContain("account and workspaces level");
        expect(error.details).toEqual({ action, reason: "outside_key_scope" });
      }
    }
  });

  it("keeps the account's other changes, key issuance and a workspace's usage out of a key with the level", async () => {
    const t = await setupPersonalKeyInstance();
    const { headers } = await keyHeaders(t, t.root.id, [ACCOUNT, WORKSPACES]);
    const values = { collaborationWorkspaceId: t.kaiTeam, userCode: "BCDF-GHJK", userId: t.kai.id };
    for (const operation of [
      "me.api_keys.create",
      "me.connect_codes.confirm",
      "me.password.change",
      "me.delete",
      "me.operation_settings.set",
      "me.chat_skills.set",
      "workspaces.usage.get",
      "workspaces.member_usage.list",
      "workspaces.files.list",
      "personal_api_keys.revoke",
      "users.update",
      "permissions.grant"
    ] as const) {
      const response = await t.call(t.root.id, operation, {
        params: paramsOf(operation, values),
        headers
      });
      expect(response.statusCode, `${operation}: ${response.body}`).toBe(403);
    }
  });

  it("changes the person's own account with account.manage, and revokes their keys as the screen audits it", async () => {
    const t = await setupPersonalKeyInstance();
    const { headers, keyId } = await keyHeaders(t, t.kai.id, [ACCOUNT]);
    const renamed = await t.call(t.kai.id, "me.update", {
      payload: { displayLabel: "Kai K." },
      headers
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json()).toMatchObject({ displayLabel: "Kai K." });
    const preference = { reasoningEfforts: {} };
    const set = await t.call(t.kai.id, "me.model_preference.set", {
      payload: preference,
      headers
    });
    expect(set.statusCode, set.body).toBe(200);
    const read = await t.call(t.kai.id, "me.model_preference.get", { headers });
    expect(read.json()).toEqual(preference);

    // Another key of Kai's, revoked with this one: the row names this key as the credential.
    const other = createdKeySchema.parse(await t.issue([ACCOUNT])).key.id;
    const revoked = await t.call(t.kai.id, "me.api_keys.revoke", {
      params: { keyId: other },
      headers
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    const [event] = await auditEvents(t, "api_access.personal_key_revoked");
    expect(event).toMatchObject({
      subject: other,
      actor: { userId: t.kai.id, credentialId: keyId }
    });
    // The screen records the same event, without a credential.
    const third = createdKeySchema.parse(await t.issue([ACCOUNT])).key.id;
    await t.expectOk(t.kai.id, "me.api_keys.revoke", { params: { keyId: third } });
    const screen = (await auditEvents(t, "api_access.personal_key_revoked")).find(
      (row) => row.subject === third
    );
    expect(screen?.actor).toMatchObject({ userId: t.kai.id });
    expect(screen?.actor).not.toHaveProperty("credentialId");

    // Someone else's key is not the person's to revoke, as on the screen.
    const lenas = createdKeySchema.parse(await t.issue([ACCOUNT], t.lena.id)).key.id;
    await sameAsScreen(t, t.kai.id, headers, "me.api_keys.revoke", { params: { keyId: lenas } });

    // The key revokes itself, and its next call is refused.
    const itself = await t.call(t.kai.id, "me.api_keys.revoke", { params: { keyId }, headers });
    expect(itself.statusCode, itself.body).toBe(200);
    expect((await t.call(t.kai.id, "me.get", { headers })).statusCode).toBe(401);
  });

  it("manages Shared Workspaces with collaboration_workspace.manage through the screen's checks, and audits a deletion as the screen does", async () => {
    const t = await setupPersonalKeyInstance();
    const mia = await person(t, "Mia");
    const nora = await person(t, "Nora");
    const { headers, keyId } = await keyHeaders(t, t.kai.id, [WORKSPACES]);

    const created = await t.call(t.kai.id, "workspaces.create", {
      payload: { name: "Kai CLI", visibility: "discoverable" },
      headers
    });
    expect(created.statusCode, created.body).toBe(200);
    const workspace = workspaceSchema.parse(created.json());
    expect(created.json()).toMatchObject({ role: "owner" });
    const collaborationWorkspaceId = workspace.id;
    const params = { collaborationWorkspaceId };

    const listed = pageSchema.parse(
      (await t.call(t.kai.id, "workspaces.list", { headers })).json()
    );
    expect(listed.items.map((item) => item["id"])).toContain(collaborationWorkspaceId);
    expect((await t.call(t.kai.id, "workspaces.get", { params, headers })).statusCode).toBe(200);
    const updated = await t.call(t.kai.id, "workspaces.update", {
      params,
      payload: { name: "Kai CLI Team" },
      headers
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json()).toMatchObject({ name: "Kai CLI Team" });

    const added = await t.call(t.kai.id, "workspaces.members.add", {
      params,
      payload: { email: "mia@example.test" },
      headers
    });
    expect(added.statusCode, added.body).toBe(200);
    const role = await t.call(t.kai.id, "workspaces.members.update_role", {
      params: { ...params, userId: mia.id },
      payload: { role: "admin" },
      headers
    });
    expect(role.statusCode, role.body).toBe(200);
    const members = pageSchema.parse(
      (await t.call(t.kai.id, "workspaces.members.list", { params, headers })).json()
    );
    expect(members.items).toHaveLength(2);
    const candidates = await t.call(t.kai.id, "workspaces.member_candidates.list", {
      params,
      query: { q: "nora" },
      headers
    });
    expect(candidates.statusCode, candidates.body).toBe(200);

    // Nora asks to join on the screen; the key lists and declines, then approves a new ask.
    const directory = pageSchema.parse(
      (await t.call(t.kai.id, "workspaces.directory.list", { headers })).json()
    );
    expect(directory.items.map((item) => item["id"])).toContain(collaborationWorkspaceId);
    await t.expectOk(nora.id, "workspaces.access_requests.create", { params });
    const requests = pageSchema.parse(
      (await t.call(t.kai.id, "workspaces.access_requests.list", { params, headers })).json()
    );
    expect(requests.items.map((item) => item["userId"])).toEqual([nora.id]);
    const declined = await t.call(t.kai.id, "workspaces.access_requests.decline", {
      params: { ...params, userId: nora.id },
      headers
    });
    expect(declined.statusCode, declined.body).toBe(200);
    await t.expectOk(nora.id, "workspaces.access_requests.create", { params });
    const approved = await t.call(t.kai.id, "workspaces.access_requests.approve", {
      params: { ...params, userId: nora.id },
      headers
    });
    expect(approved.statusCode, approved.body).toBe(200);
    const removed = await t.call(t.kai.id, "workspaces.members.remove", {
      params: { ...params, userId: nora.id },
      headers
    });
    expect(removed.statusCode, removed.body).toBe(200);

    // Mia leaves with a key of her own.
    const mias = await keyHeaders(t, mia.id, [WORKSPACES]);
    const left = await t.call(mia.id, "workspaces.members.leave", {
      params,
      headers: mias.headers
    });
    expect(left.statusCode, left.body).toBe(200);
    // Nora asks to join with a key.
    const noras = await keyHeaders(t, nora.id, [WORKSPACES]);
    const asked = await t.call(nora.id, "workspaces.access_requests.create", {
      params,
      headers: noras.headers
    });
    expect(asked.statusCode, asked.body).toBe(200);

    const impact = await t.call(t.kai.id, "workspaces.deletion_impact.get", { params, headers });
    expect(impact.statusCode, impact.body).toBe(200);
    const wrongName = await t.call(t.kai.id, "workspaces.delete", {
      params,
      payload: { confirmName: "Kai CLI" },
      headers
    });
    expect(wrongName.statusCode).toBe(422);
    const deleted = await t.call(t.kai.id, "workspaces.delete", {
      params,
      payload: { confirmName: "Kai CLI Team" },
      headers
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    const [deletion] = await auditEvents(t, "collaboration_workspace.deletion_requested");
    expect(deletion).toMatchObject({ actor: { userId: t.kai.id, credentialId: keyId } });
    for (const type of [
      "collaboration_workspace.created",
      "collaboration_workspace.updated",
      "collaboration_workspace.member_added",
      "collaboration_workspace.member_role_changed",
      "collaboration_workspace.member_removed"
    ]) {
      const [event] = await auditEvents(t, type);
      expect(event, type).toMatchObject({ actor: { credentialId: keyId } });
    }
  });

  it("refuses member changes to a non-admin with a key exactly as on the screen", async () => {
    const t = await setupPersonalKeyInstance();
    const mia = await person(t, "Mia");
    const nora = await person(t, "Nora");
    const owner = await keyHeaders(t, t.kai.id, [WORKSPACES]);
    const created = await t.call(t.kai.id, "workspaces.create", {
      payload: { name: "Kai Rules", visibility: "discoverable" },
      headers: owner.headers
    });
    const collaborationWorkspaceId = workspaceSchema.parse(created.json()).id;
    const params = { collaborationWorkspaceId };
    for (const [email, role] of [
      ["mia@example.test", "member"],
      ["nora@example.test", "admin"]
    ] as const) {
      const added = await t.expectOk(t.kai.id, "workspaces.members.add", {
        params,
        payload: { email }
      });
      const userId = z.object({ userId: z.string() }).loose().parse(added.json()).userId;
      if (role === "admin") {
        await t.expectOk(t.kai.id, "workspaces.members.update_role", {
          params: { ...params, userId },
          payload: { role }
        });
      }
    }
    await t.expectOk(t.lena.id, "workspaces.access_requests.create", { params });

    // Mia is a regular Member: every change of members is refused, as on the screen.
    const member = (await keyHeaders(t, mia.id, [WORKSPACES])).headers;
    const memberCases: [TestOperationName, TestCallInput][] = [
      ["workspaces.members.add", { params, payload: { email: "lena@example.test" } }],
      [
        "workspaces.members.update_role",
        { params: { ...params, userId: nora.id }, payload: { role: "member" } }
      ],
      ["workspaces.members.remove", { params: { ...params, userId: nora.id } }],
      ["workspaces.access_requests.approve", { params: { ...params, userId: t.lena.id } }],
      ["workspaces.access_requests.decline", { params: { ...params, userId: t.lena.id } }],
      ["workspaces.update", { params, payload: { name: "Mia's" } }],
      ["workspaces.delete", { params, payload: { confirmName: "Kai Rules" } }],
      ["workspaces.member_candidates.list", { params }]
    ];
    for (const [operation, input] of memberCases) {
      const error = await sameAsScreen(t, mia.id, member, operation, input);
      expect(error.code, operation).toBe("FORBIDDEN");
    }

    // Nora is an Admin: she changes regular Members only, and deletes nothing.
    const admin = (await keyHeaders(t, nora.id, [WORKSPACES])).headers;
    const adminCases: [TestOperationName, TestCallInput][] = [
      [
        "workspaces.members.update_role",
        { params: { ...params, userId: t.kai.id }, payload: { role: "member" } }
      ],
      [
        "workspaces.members.update_role",
        { params: { ...params, userId: mia.id }, payload: { role: "owner" } }
      ],
      ["workspaces.members.remove", { params: { ...params, userId: t.kai.id } }],
      ["workspaces.delete", { params, payload: { confirmName: "Kai Rules" } }]
    ];
    for (const [operation, input] of adminCases) {
      await sameAsScreen(t, nora.id, admin, operation, input);
    }

    // Lena is no member: the workspace is not there for her, with a key as on the screen.
    const outsider = (await keyHeaders(t, t.lena.id, [WORKSPACES])).headers;
    for (const [operation, input] of memberCases) {
      await sameAsScreen(t, t.lena.id, outsider, operation, input);
    }
    expect(
      (
        await t.stores.workspaces.listMemberships({
          clientInstanceId,
          collaborationWorkspaceId: asCollaborationWorkspaceId(collaborationWorkspaceId)
        })
      ).length
    ).toBe(3);
  });

  it("gives a superadmin's key their memberships only, never the Owner role of another person's workspace", async () => {
    const t = await setupPersonalKeyInstance();
    const created = await t.expectOk(t.kai.id, "workspaces.create", {
      payload: { name: "Kai Private" }
    });
    const collaborationWorkspaceId = workspaceSchema.parse(created.json()).id;
    const params = { collaborationWorkspaceId };
    const ids = (response: { json(): unknown }) =>
      pageSchema.parse(response.json()).items.map((item) => item["id"]);

    // In their own session the superadmin is Owner of every Shared Workspace, as before.
    expect(ids(await t.expectOk(t.root.id, "workspaces.list"))).toContain(collaborationWorkspaceId);
    expect((await t.expectOk(t.root.id, "workspaces.get", { params })).json()).toMatchObject({
      role: "owner",
      membershipRole: null
    });

    // Their key with the workspaces level acts on their memberships alone.
    const { headers } = await keyHeaders(t, t.root.id, [WORKSPACES]);
    const listed = await t.call(t.root.id, "workspaces.list", { headers });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(ids(listed)).not.toContain(collaborationWorkspaceId);
    for (const [operation, input] of [
      ["workspaces.get", { params }],
      ["workspaces.members.list", { params }],
      ["workspaces.deletion_impact.get", { params }],
      ["workspaces.update", { params, payload: { name: "Taken" } }],
      ["workspaces.members.add", { params, payload: { email: "lena@example.test" } }],
      ["workspaces.delete", { params, payload: { confirmName: "Kai Private" } }]
    ] as const) {
      const response = await t.call(t.root.id, operation, { ...input, headers });
      expect(response.statusCode, `${operation}: ${response.body}`).toBe(404);
    }
    expect((await t.expectOk(t.kai.id, "workspaces.get", { params })).json()).toMatchObject({
      name: "Kai Private"
    });
    expect(
      await t.stores.workspaces.listMemberships({
        clientInstanceId,
        collaborationWorkspaceId: asCollaborationWorkspaceId(collaborationWorkspaceId)
      })
    ).toHaveLength(1);
  });

  it("reaches one workspace only with a key limited to it, and neither lists nor creates workspaces", async () => {
    const t = await setupPersonalKeyInstance();
    const ownerKey = (await keyHeaders(t, t.kai.id, [WORKSPACES])).headers;
    const ids: string[] = [];
    for (const name of ["Kai One", "Kai Two"]) {
      const created = await t.call(t.kai.id, "workspaces.create", {
        payload: { name },
        headers: ownerKey
      });
      ids.push(workspaceSchema.parse(created.json()).id);
    }
    const [one = "", two = ""] = ids;
    const { headers } = await keyHeaders(t, t.kai.id, [`${WORKSPACES}:${one}`]);
    expect(
      (
        await t.call(t.kai.id, "workspaces.get", {
          params: { collaborationWorkspaceId: one },
          headers
        })
      ).statusCode
    ).toBe(200);
    const elsewhere = await t.call(t.kai.id, "workspaces.update", {
      params: { collaborationWorkspaceId: two },
      payload: { name: "Taken" },
      headers
    });
    expect(elsewhere.statusCode).toBe(403);
    expect(errorSchema.parse(elsewhere.json()).error.details).toEqual({
      action: WORKSPACES,
      reason: "outside_key_scope"
    });
    for (const [operation, input] of [
      ["workspaces.list", {}],
      ["workspaces.directory.list", {}],
      ["workspaces.create", { payload: { name: "Kai Three" } }]
    ] as const) {
      const response = await t.call(t.kai.id, operation, { ...input, headers });
      expect(response.statusCode, `${operation}: ${response.body}`).toBe(403);
      expect(errorSchema.parse(response.json()).error.details).toEqual({
        action: WORKSPACES,
        reason: "outside_key_scope"
      });
    }
    const after = await t.call(t.kai.id, "workspaces.get", {
      params: { collaborationWorkspaceId: two },
      headers: ownerKey
    });
    expect(after.json()).toMatchObject({ name: "Kai Two" });
  });
});
