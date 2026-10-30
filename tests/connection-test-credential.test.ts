import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { appActionSchema, appActionsSchema } from "@work-shape/catalyst-api-contract";
import { TEST_CREDENTIAL_SUBJECT } from "@work-shape/catalyst-core";
import { clientInstanceId } from "./support/access-instance";
import { expectStatus } from "./support/app-instance";
import { resultSchema, setupAppActions, type AppActionsInstance } from "./support/app-actions";
import {
  URL_OF_HOST,
  URL_OF_SECOND_HOST,
  agentOrigin,
  operationOf
} from "./support/connection-operations";
import { generateTestSecret } from "./support/test-connector";

// The test credential of a shared Connection (ADR-0031, DT-3), on the real call path, the real
// Secret Store and Postgres: set and rotated write-only, chosen by the call's target alone. A
// draft's call reaches it and never the live credential; every other call reaches the live one
// and never it. The App `orders` has a published revision and a draft; `save` calls
// `crm.write`, `load` calls `crm.echo`.

const testCredentialSchema = z.object({
  state: z.string(),
  version: z.number().optional(),
  endpoint: z.string().optional(),
  account: z.string().optional(),
  takesEndpoint: z.boolean()
});
const detailSchema = z.looseObject({ testCredential: testCredentialSchema.optional() });
const refusalSchema = z.object({
  error: z.looseObject({ code: z.string(), details: z.looseObject({}).optional() })
});

describe("the test credential of a shared Connection", () => {
  let t: AppActionsInstance;
  /** The hosts the Connector type was sent to, since the last clear. */
  const hosts: string[] = [];

  beforeAll(async () => {
    t = await setupAppActions();
    t.setBehaviour((_operation, input, context) => {
      hosts.push(context.target.host);
      return Promise.resolve(input);
    });
  });
  afterAll(() => t.closeAll());
  beforeEach(async () => {
    hosts.length = 0;
    t.state.centralSettings = [];
    t.state.hostAllowed = true;
    await t.stores.connections.deleteConnectionTestCredential({
      clientInstanceId,
      connectionAssetId: t.crm
    });
    await t.stores.connections.deleteSecrets({
      clientInstanceId,
      connectionAssetId: t.crm,
      subject: TEST_CREDENTIAL_SUBJECT
    });
  });

  const revisionOf = async () => {
    const read = await t.call(t.admin.id, "assets.get", {
      params: { kind: "connection", name: "crm" }
    });
    expectStatus(read, 200);
    return z.object({ revision: z.number() }).parse(read.json()).revision;
  };
  const setTest = async (
    value: string,
    further: { endpoint?: string; account?: string; expectedVersion?: number | null } = {}
  ) =>
    t.call(t.admin.id, "connections.set_test_credential", {
      params: { name: "crm" },
      payload: {
        value,
        expectedVersion: further.expectedVersion ?? null,
        expectedRevision: await revisionOf(),
        ...(further.endpoint === undefined ? {} : { endpoint: further.endpoint }),
        ...(further.account === undefined ? {} : { account: further.account })
      }
    });
  const detail = async () => {
    const response = await t.call(t.admin.id, "connections.get", { params: { name: "crm" } });
    expectStatus(response, 200);
    return { body: response.body, view: detailSchema.parse(response.json()).testCredential };
  };
  const save = async (mode: "draft" | "published", note: string) =>
    t.callAction(
      t.admin.id,
      await t.openApp(t.admin.id, mode),
      "save",
      { note },
      {
        "idempotency-key": crypto.randomUUID()
      }
    );
  const load = async (mode: "draft" | "published") =>
    t.callAction(t.admin.id, await t.openApp(t.admin.id, mode), "load", { text: "row" });
  const listedTargets = async () => {
    const response = await t.call(t.admin.id, "apps.actions.list", { query: { app: "orders" } });
    expectStatus(response, 200);
    const actions = appActionsSchema.parse(response.json()).apps[0]?.actions ?? [];
    return Object.fromEntries(
      actions.map((entry) => [entry.name, appActionSchema.parse(entry).target])
    );
  };
  const auditOf = async (type: string) =>
    (await t.stores.audit.listAuditEvents({ clientInstanceId, limit: 500 })).filter(
      (event) => event.type === type
    );

  // Check 30.
  it("is set write-only, and a draft's calls reach it while the published App's reach the live one", async () => {
    const testValue = generateTestSecret();
    expect((await detail()).view).toEqual({ state: "not_set", takesEndpoint: true });
    expect(await listedTargets()).toMatchObject({ save: "dry_run", load: "live" });

    const set = await setTest(testValue, { account: "Sandbox tenant" });
    expectStatus(set, 200);
    expect(set.json()).toEqual({ state: "set", version: 1 });
    const read = await detail();
    expect(read.view).toMatchObject({ state: "set", version: 1, account: "Sandbox tenant" });
    expect(read.body).not.toContain(testValue);

    // A draft's changing and reading calls go to the test credential, and only to it.
    let before = t.handed.length;
    const changed = await save("draft", "to the sandbox");
    expectStatus(changed, 200);
    expect(await t.runOf(resultSchema.parse(changed.json()).runId)).toMatchObject({
      operation: "app.orders.save",
      target: "test",
      status: "done"
    });
    const draftRead = await load("draft");
    expectStatus(draftRead, 200);
    expect(await t.runOf(resultSchema.parse(draftRead.json()).runId)).toMatchObject({
      target: "test"
    });
    expect(t.handed.slice(before)).toEqual([testValue, testValue]);
    expect(await listedTargets()).toMatchObject({ save: "test", load: "test" });

    // The published App and an agent reach the live credential, never the test one.
    t.state.agentTools.set("assistant", ["connection.crm.echo"]);
    before = t.handed.length;
    const live = await save("published", "for real");
    expectStatus(live, 200);
    expect(await t.runOf(resultSchema.parse(live.json()).runId)).toMatchObject({
      target: "live"
    });
    expectStatus(await load("published"), 200);
    expect(
      (
        await t.invoke(
          t.admin,
          "connection.crm.echo",
          { text: "agent" },
          {
            origin: agentOrigin("connection.crm.echo")
          }
        )
      ).run
    ).toMatchObject({ status: "done", target: "live" });
    expect(t.handed.slice(before)).toEqual([t.secret, t.secret, t.secret]);

    // Neither the runs, nor the audit, nor a log of the write keeps the value.
    const runs = await t.stores.operationRuns.list({ clientInstanceId });
    expect(JSON.stringify(runs)).not.toContain(testValue);
    const audited = await auditOf("connection.test_credential_set");
    expect(audited).toHaveLength(1);
    expect(audited[0]?.metadata).toEqual({
      connectionName: "crm",
      connectionRevision: expect.any(Number),
      subjectKind: "test",
      version: 1,
      rotated: false
    });
    const everything = JSON.stringify(
      await t.stores.audit.listAuditEvents({ clientInstanceId, limit: 500 })
    );
    expect(everything).not.toContain(testValue);
    expect(everything).not.toContain("Sandbox tenant");
  });

  it("rotates to the next version over the version the writer saw, and refuses a stale one", async () => {
    expectStatus(await setTest(generateTestSecret()), 200);
    const rotated = generateTestSecret();
    const stale = await setTest(rotated, { expectedVersion: null });
    expectStatus(stale, 409);
    expect(refusalSchema.parse(stale.json()).error.details).toMatchObject({
      reason: "secret_write_conflict"
    });
    const next = await setTest(rotated, { expectedVersion: 1 });
    expectStatus(next, 200);
    expect(next.json()).toEqual({ state: "set", version: 2 });
    const before = t.handed.length;
    expectStatus(await save("draft", "rotated"), 200);
    expect(t.handed.slice(before)).toEqual([rotated]);
    expect((await auditOf("connection.test_credential_set"))[0]?.metadata).toMatchObject({
      version: 2,
      rotated: true
    });
  });

  it("is removed: a draft's changing call is simulated again and its reading call goes live", async () => {
    const testValue = generateTestSecret();
    expectStatus(await setTest(testValue), 200);
    const removed = await t.call(t.admin.id, "connections.remove_test_credential", {
      params: { name: "crm" }
    });
    expectStatus(removed, 200);
    expect(removed.json()).toEqual({ state: "not_set" });
    expect(
      await t.stores.connections.findSecret({
        clientInstanceId,
        binding: { connectionAssetId: t.crm, subject: TEST_CREDENTIAL_SUBJECT }
      })
    ).toBeUndefined();
    expect((await auditOf("connection.test_credential_removed")).length).toBeGreaterThan(0);

    const before = t.handed.length;
    const simulated = await save("draft", "after removal");
    expectStatus(simulated, 200);
    expect(simulated.json()).toMatchObject({ status: "dry_run" });
    const read = await load("draft");
    expect(await t.runOf(resultSchema.parse(read.json()).runId)).toMatchObject({
      target: "live"
    });
    expect(t.handed.slice(before)).toEqual([t.secret]);
    expect(await listedTargets()).toMatchObject({ save: "dry_run", load: "live" });

    const again = await t.call(t.admin.id, "connections.remove_test_credential", {
      params: { name: "crm" }
    });
    expectStatus(again, 409);
    expect(refusalSchema.parse(again.json()).error.details).toMatchObject({
      reason: "test_credential_not_set"
    });
  });

  // Check 31.
  it("takes an address of its own only where the egress list names it, and calls go there", async () => {
    const value = generateTestSecret();
    const blocked = await setTest(value, { endpoint: "https://blocked.example.com/api" });
    expectStatus(blocked, 422);
    expect(refusalSchema.parse(blocked.json()).error.details).toMatchObject({
      reason: "egress_denied",
      host: "blocked.example.com"
    });
    expect((await detail()).view).toMatchObject({ state: "not_set" });
    expect(
      await t.stores.connections.findSecret({
        clientInstanceId,
        binding: { connectionAssetId: t.crm, subject: TEST_CREDENTIAL_SUBJECT }
      })
    ).toBeUndefined();

    expectStatus(await setTest(value, { endpoint: URL_OF_SECOND_HOST }), 200);
    expect((await detail()).view).toMatchObject({ state: "set", endpoint: URL_OF_SECOND_HOST });
    expect((await auditOf("connection.test_credential_set"))[0]?.metadata).toMatchObject({
      endpointHost: "second.example.com"
    });
    expectStatus(await save("draft", "to the second host"), 200);
    expectStatus(await save("published", "to the first host"), 200);
    expect(hosts).toEqual(["second.example.com", "outside.example.com"]);
  });

  it("refuses a draft's call whose test credential no longer fits, and never sends it live", async () => {
    const value = generateTestSecret();
    expectStatus(await setTest(value), 200);
    // The Connection moved to another address: the test credential was set for the first.
    await t.seed("crm", {
      settings: { url: URL_OF_SECOND_HOST },
      operations: [
        operationOf("echo", { exposure: ["bridge", "agent"] }),
        operationOf("write", { effect: "changing", exposure: ["bridge"] })
      ]
    });
    expect((await detail()).view).toMatchObject({ state: "stale" });
    const before = t.handed.length;
    for (const call of [() => save("draft", "stale"), () => load("draft")]) {
      const refused = await call();
      expectStatus(refused, 409);
      expect(refusalSchema.parse(refused.json()).error.details).toMatchObject({
        reason: "test_target_missing"
      });
    }
    expect(t.handed.length).toBe(before);
    // A failed test call says nothing of the live credential's health.
    expect(await t.health(t.crm)).not.toBe("needs_configuration");
    await t.seed("crm", {
      settings: { url: URL_OF_HOST },
      operations: [
        operationOf("echo", { exposure: ["bridge", "agent"] }),
        operationOf("write", { effect: "changing", exposure: ["bridge"] })
      ]
    });
  });

  it("refuses a draft's call whose test secret is gone, and never sends it live", async () => {
    expectStatus(await setTest(generateTestSecret()), 200);
    await t.stores.connections.deleteSecrets({
      clientInstanceId,
      connectionAssetId: t.crm,
      subject: TEST_CREDENTIAL_SUBJECT
    });
    const before = t.handed.length;
    const refused = await save("draft", "no secret");
    expectStatus(refused, 409);
    expect(t.handed.length).toBe(before);
  });

  it("is refused for a Connection that sends no typed secret, and to a member without connection.write", async () => {
    const denied = await t.call(t.kai.id, "connections.set_test_credential", {
      params: { name: "crm" },
      payload: { value: "nope", expectedVersion: null, expectedRevision: await revisionOf() }
    });
    expectStatus(denied, 403);
    expect(denied.body).not.toContain("nope");
    const runs = await t.stores.operationRuns.list({ clientInstanceId });
    expect(JSON.stringify(runs)).not.toContain("nope");

    await t.seed("open", { authScheme: "none", operations: [operationOf("echo")] });
    const read = await t.call(t.admin.id, "assets.get", {
      params: { kind: "connection", name: "open" }
    });
    const unsupported = await t.call(t.admin.id, "connections.set_test_credential", {
      params: { name: "open" },
      payload: {
        value: generateTestSecret(),
        expectedVersion: null,
        expectedRevision: z.object({ revision: z.number() }).parse(read.json()).revision
      }
    });
    expectStatus(unsupported, 409);
    expect(refusalSchema.parse(unsupported.json()).error.details).toMatchObject({
      reason: "test_credential_unsupported"
    });
  });
});
