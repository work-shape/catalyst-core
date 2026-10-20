import { describe, expect, it } from "vitest";
import { z } from "zod";
import { withTestSql } from "./support/test-sql";
import { clientInstanceId, errorSchema } from "./support/access-instance";
import {
  agentConfig,
  grantKaiWorkspace,
  inDays,
  setupPersonalKeyInstance as setup
} from "./support/personal-api-keys";

const keySchema = z.object({
  id: z.string(),
  ownerUserId: z.string(),
  name: z.string(),
  keyPrefix: z.string(),
  scopes: z.array(z.string()),
  revokedAt: z.string().optional()
});
const startedSchema = z.object({
  userCode: z.string(),
  deviceCode: z.string(),
  confirmPath: z.string(),
  intervalSeconds: z.number()
});
const listSchema = z.object({
  items: z.array(keySchema.extend({ ownerDisplayLabel: z.string() }))
});

describe("personal API keys", () => {
  it("act as their owner inside the owner's workspace and are refused outside it", async () => {
    const t = await setup();
    await grantKaiWorkspace(t);
    await t.putAgent(t.admin.id, "other-helper");
    const { key, secret } = await t.issue([`agent.read:${t.kaiTeam}`, `agent.write:${t.kaiTeam}`]);
    expect(secret).toMatch(/^cat\.apic_/u);
    expect(key).toMatchObject({
      ownerUserId: t.kai.id,
      scopes: [`agent.read:${t.kaiTeam}`, `agent.write:${t.kaiTeam}`]
    });
    const headers = await t.tokenFor(secret);

    const put = await t.call(t.kai.id, "assets.put", {
      params: { kind: "agent", name: "kai-helper" },
      payload: { config: agentConfig("kai-helper"), workspaceId: t.kaiTeam },
      headers
    });
    expect(put.statusCode, put.body).toBe(200);
    const listed = await t.call(t.kai.id, "assets.list", {
      params: { kind: "agent" },
      query: { workspaceId: t.kaiTeam },
      headers
    });
    expect(listed.statusCode).toBe(200);
    const names = z
      .object({ items: z.array(z.object({ name: z.string() })) })
      .parse(listed.json())
      .items.map((item) => item.name);
    expect(names).toEqual(["kai-helper"]);

    const outside = await t.call(t.kai.id, "assets.put", {
      params: { kind: "agent", name: "other-helper" },
      payload: { config: agentConfig("other-helper") },
      headers
    });
    expect(outside.statusCode).toBe(403);
    expect(errorSchema.parse(outside.json()).error.details).toMatchObject({
      action: "agent.write",
      reason: "no_grant"
    });

    // Audit names the person and the key, and no row or run holds the key itself.
    const actors = z
      .array(
        z.object({
          actor: z
            .object({
              userId: z.string().optional(),
              credentialId: z.string().optional(),
              delegatedActor: z.object({ kind: z.string() }).optional()
            })
            .nullable()
        })
      )
      .parse(
        await withTestSql(
          (sql) =>
            sql`select actor from audit_events where client_instance_id = ${clientInstanceId}`
        )
      );
    expect(actors.map((row) => row.actor)).toContainEqual({
      userId: t.kai.id,
      credentialId: key.id,
      delegatedActor: expect.objectContaining({ kind: "api_key" })
    });
    const everything = await withTestSql(
      (sql) => sql`
        select (select coalesce(json_agg(a), '[]'::json) from audit_events a)::text as audit,
               (select coalesce(json_agg(r), '[]'::json) from operation_runs r)::text as runs`
    );
    expect(JSON.stringify(everything)).not.toContain(secret.slice(-64));
  });

  it("never does more than its scopes, even where the owner may", async () => {
    const t = await setup();
    await grantKaiWorkspace(t);
    const put = async (scopes: string[]) =>
      t.call(t.kai.id, "assets.put", {
        params: { kind: "agent", name: "kai-helper" },
        payload: { config: agentConfig("kai-helper"), workspaceId: t.kaiTeam },
        headers: await t.tokenFor((await t.issue(scopes)).secret)
      });

    // A reading key reaches no writing operation at all.
    const reading = await put([`agent.read:${t.kaiTeam}`]);
    expect(reading.statusCode).toBe(403);
    expect(errorSchema.parse(reading.json()).error.message).toContain("config_assets:write");
    // A key for one asset of the workspace, narrower than the owner's grant, is refused by the key
    // for any other.
    const narrower = await put([`agent.read:${t.kaiTeam}`, `agent.write:${t.kaiTeam}/kai-tax`]);
    expect(narrower.statusCode).toBe(403);
    expect(errorSchema.parse(narrower.json()).error.details).toMatchObject({
      action: "agent.write",
      reason: "outside_key_scope"
    });
    const headers = await t.tokenFor((await t.issue([`agent.read:${t.kaiTeam}`])).secret);
    // No key issues a key: its calls carry no `me:write`.
    const issued = await t.call(t.kai.id, "me.api_keys.create", {
      payload: { name: "second", scopes: [`agent.read:${t.kaiTeam}`], expiresAt: inDays(1) },
      headers
    });
    expect(issued.statusCode).toBe(403);
  });

  it("narrow at once when the owner loses a grant, and stop on the next call when revoked", async () => {
    const t = await setup();
    const grants = await grantKaiWorkspace(t);
    const { key, secret } = await t.issue([`agent.read:${t.kaiTeam}`, `agent.write:${t.kaiTeam}`]);
    const headers = await t.tokenFor(secret);
    const put = () =>
      t.call(t.kai.id, "assets.put", {
        params: { kind: "agent", name: "kai-helper" },
        payload: { config: agentConfig("kai-helper"), workspaceId: t.kaiTeam },
        headers
      });
    expect((await put()).statusCode).toBe(200);

    await t.expectOk(t.admin.id, "permissions.revoke", {
      params: { grantId: grants["agent.write"] ?? "" }
    });
    const narrowed = await put();
    expect(narrowed.statusCode).toBe(403);
    expect(errorSchema.parse(narrowed.json()).error.details).toMatchObject({
      action: "agent.write",
      reason: "no_grant"
    });

    await t.expectOk(t.kai.id, "me.api_keys.revoke", { params: { keyId: key.id } });
    const revoked = await t.call(t.kai.id, "assets.list", {
      params: { kind: "agent" },
      query: { workspaceId: t.kaiTeam },
      headers
    });
    expect(revoked.statusCode).toBe(401);
    const exchange = await t.instance.call("access_tokens.exchange", {
      headers: { authorization: `Bearer ${secret}` }
    });
    expect(exchange.statusCode).toBe(401);
  });

  it("stop working for a disabled owner", async () => {
    const t = await setup();
    await grantKaiWorkspace(t);
    const { secret } = await t.issue([`agent.read:${t.kaiTeam}`]);
    const headers = await t.tokenFor(secret);
    await t.stores.users.updateUser({ clientInstanceId, userId: t.kai.id, status: "disabled" });
    const call = await t.call(t.kai.id, "assets.list", {
      params: { kind: "agent" },
      query: { workspaceId: t.kaiTeam },
      headers
    });
    expect(call.statusCode).toBe(403);
  });

  it("are issued only with scopes the person holds, a known grammar and a year at most", async () => {
    const t = await setup();
    await grantKaiWorkspace(t);
    const refused = async (scopes: string[], expiresAt = inDays(30)) => {
      const response = await t.call(t.kai.id, "me.api_keys.create", {
        payload: { name: "x", scopes, expiresAt }
      });
      return { status: response.statusCode, error: errorSchema.parse(response.json()).error };
    };
    const lenaTeam = await t.sharedWorkspace("Lena Spezis");
    expect(await refused([`agent.write:${lenaTeam}`])).toMatchObject({
      status: 422,
      error: {
        code: "VALIDATION_FAILED",
        details: { action: "agent.write", workspaceId: lenaTeam }
      }
    });
    // A scope of a name prefix, as keys once held, names a workspace that does not exist.
    expect(await refused(["agent.write:kai-"])).toMatchObject({
      status: 422,
      error: {
        code: "VALIDATION_FAILED",
        details: { reason: "unknown_workspace", workspaceId: "kai-" }
      }
    });
    expect(await refused(["skill.write"])).toMatchObject({ status: 422 });
    expect(await refused([`agent.write:${t.kaiTeam}/`])).toMatchObject({ status: 422 });
    expect(await refused(["users.manage"])).toMatchObject({ status: 422 });
    expect(await refused([])).toMatchObject({ status: 422 });
    expect(await refused([`agent.read:${t.kaiTeam}`], inDays(400))).toMatchObject({ status: 422 });
    expect(await refused([`agent.read:${t.kaiTeam}`], inDays(-1))).toMatchObject({ status: 422 });
  });

  it("are listed and revoked by whoever administers API access, and by nobody else", async () => {
    const t = await setup();
    await grantKaiWorkspace(t);
    const { key } = await t.issue([`agent.read:${t.kaiTeam}`]);

    const own = z.object({ items: z.array(keySchema) });
    expect(own.parse((await t.expectOk(t.lena.id, "me.api_keys.list")).json()).items).toEqual([]);
    expect(
      own
        .parse((await t.expectOk(t.kai.id, "me.api_keys.list")).json())
        .items.map((item) => item.id)
    ).toEqual([key.id]);
    await t.expectRefused(
      t.kai.id,
      "personal_api_keys.list",
      {},
      t.forbidden("api_access.manage", "no_grant")
    );
    await t.expectRefused(
      t.lena.id,
      "me.api_keys.revoke",
      { params: { keyId: key.id } },
      { status: 404, code: "NOT_FOUND" }
    );

    const every = listSchema.parse((await t.expectOk(t.root.id, "personal_api_keys.list")).json());
    expect(every.items.find((item) => item.id === key.id)).toMatchObject({
      ownerUserId: t.kai.id,
      ownerDisplayLabel: "Kai"
    });
    const revoked = keySchema.parse(
      (
        await t.expectOk(t.root.id, "personal_api_keys.revoke", { params: { keyId: key.id } })
      ).json()
    );
    expect(revoked.revokedAt).toBeDefined();
  });

  it("are refused, issued and read nowhere while the module is off", async () => {
    const t = await setup({ module: false });
    const response = await t.call(t.kai.id, "me.api_keys.create", {
      payload: { name: "x", scopes: ["agent.read"], expiresAt: inDays(1) }
    });
    expect(response.statusCode).toBe(404);
    expect(errorSchema.parse(response.json()).error.details).toMatchObject({
      reason: "module_off"
    });
    const start = await t.instance.call("connect_codes.start", { payload: {} });
    expect(start.statusCode).toBe(404);
  });
});

describe("connect codes", () => {
  it("let the CLI collect a key once, after its owner confirmed the code", async () => {
    const t = await setup();
    await grantKaiWorkspace(t);
    const started = startedSchema.parse(
      (
        await t.instance.call("connect_codes.start", {
          payload: { clientLabel: "catalyst CLI on mini" }
        })
      ).json()
    );
    expect(started.userCode).toMatch(/^[A-Z]{4}-[A-Z]{4}$/u);
    expect(started.confirmPath).toBe(`/settings/you/api-keys?code=${started.userCode}`);
    const redeem = () =>
      t.instance.call("connect_codes.redeem", { payload: { deviceCode: started.deviceCode } });
    expect((await redeem()).json()).toEqual({ status: "pending" });

    // The person reads what asks before confirming, the code typed in any case and spacing.
    const typed = started.userCode.toLowerCase().replace("-", " ");
    const shown = await t.expectOk(t.kai.id, "me.connect_codes.get", {
      params: { userCode: typed }
    });
    expect(shown.json()).toMatchObject({ clientLabel: "catalyst CLI on mini" });
    await t.expectOk(t.kai.id, "me.connect_codes.confirm", {
      params: { userCode: started.userCode },
      payload: {
        name: "Mini",
        scopes: [`agent.read:${t.kaiTeam}`, `agent.write:${t.kaiTeam}`],
        expiresAt: inDays(30)
      }
    });
    await t.expectRefused(
      t.lena.id,
      "me.connect_codes.confirm",
      {
        params: { userCode: started.userCode },
        payload: { name: "Taken", scopes: [`agent.read:${t.kaiTeam}`], expiresAt: inDays(30) }
      },
      { status: 404, code: "NOT_FOUND" }
    );

    const issued = z
      .object({ status: z.literal("issued"), key: keySchema, secret: z.string() })
      .parse((await redeem()).json());
    expect(issued.key).toMatchObject({ ownerUserId: t.kai.id, name: "Mini" });
    expect((await redeem()).statusCode).toBe(404);
    const headers = await t.tokenFor(issued.secret);
    const put = await t.call(t.kai.id, "assets.put", {
      params: { kind: "agent", name: "kai-helper" },
      payload: { config: agentConfig("kai-helper"), workspaceId: t.kaiTeam },
      headers
    });
    expect(put.statusCode, put.body).toBe(200);
  });

  it("refuse a code that expired, is malformed or belongs to nobody", async () => {
    const t = await setup();
    await grantKaiWorkspace(t);
    const started = startedSchema.parse(
      (await t.instance.call("connect_codes.start", { payload: {} })).json()
    );
    await withTestSql(
      (sql) => sql`update api_connect_codes set expires_at = now() - interval '1 second'`
    );
    await t.expectRefused(
      t.kai.id,
      "me.connect_codes.get",
      { params: { userCode: started.userCode } },
      { status: 404, code: "NOT_FOUND" }
    );
    const redeemed = await t.instance.call("connect_codes.redeem", {
      payload: { deviceCode: started.deviceCode }
    });
    expect(redeemed.statusCode).toBe(404);
    for (const userCode of ["AEIO-UAEI", "short", "BCDF-GHJK-LMNP"]) {
      await t.expectRefused(
        t.kai.id,
        "me.connect_codes.get",
        { params: { userCode } },
        {
          status: 404,
          code: "NOT_FOUND"
        }
      );
    }
  });
});
