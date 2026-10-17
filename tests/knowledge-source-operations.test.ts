import { apiOperations } from "@work-shape/catalyst-api-contract";
import { runCli } from "@work-shape/catalyst-cli";
import { callTestPath, createTestFetch } from "./support/test-instance";
import postgres from "postgres";
import { fileTestDatabaseUrl } from "./support/test-database";
import { eventually } from "./support/assertions";
import { createActorAccess, KNOWLEDGE_BASE_ASSET_KIND } from "@work-shape/catalyst-core";
import { asUserId, LEGACY_LIST_GRANTOR } from "@work-shape/catalyst-core";
import { describe, expect, it, vi } from "vitest";
import { required } from "./support/assertions";
import { clientInstanceId } from "./support/data-store-instance";
import { useKnowledgeSync } from "./support/knowledge-sync";
const KB = "sync-test",
  SOURCE = "source";
describe("source sync operations (KB 74, 75)", () => {
  const { setup } = useKnowledgeSync();
  it("joins concurrent HTTP starts through two owned-store transactions and returns the same Operation Run (KB 74)", async () => {
    const world = await setup();
    const before = await world.sql`select id from catalyst_kb.sync_runs`;
    expect(before).toHaveLength(0);
    // Each request reaches the owned store on its own transaction/connection. Neither
    // response waits for a worker, so both must see the one running-row winner.
    const url = new URL(await fileTestDatabaseUrl());
    url.pathname = `/${world.record.location.database}`;
    const blocker = postgres(url.toString(), { max: 1, onnotice() {} });
    let release = () => {},
      locked = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holding = blocker.begin(async (sql) => {
      await sql`lock table catalyst_kb.sync_runs in access exclusive mode`;
      locked();
      await gate;
    });
    await ready;
    const requests = Promise.all(
      [0, 1].map((index) =>
        world.instance.api.call("knowledge_bases.sync", {
          params: { knowledgeBase: KB },
          payload: { source: SOURCE, mode: "full" },
          headers: { "idempotency-key": `join-${index}` }
        })
      )
    );
    try {
      await eventually(async () => {
        const [row] =
          await world.sql`select count(*)::int as n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like 'insert into catalyst_kb.sync_runs %'`;
        expect(row?.n).toBe(2);
      });
    } finally {
      release();
      await holding;
      await blocker.end();
    }
    const responses = await requests;
    for (const response of responses) expect(response.statusCode, response.body).toBe(202);
    expect(responses[0]?.json()).toEqual(responses[1]?.json());
    const replay = await world.instance.api.call("knowledge_bases.sync", {
      params: { knowledgeBase: KB },
      payload: { source: SOURCE, mode: "full" },
      headers: { "idempotency-key": "join-1" }
    });
    expect(replay.statusCode, replay.body).toBe(202);
    expect(replay.json()).toEqual(responses[1]?.json());
    const runs =
      await world.sql`select id,operation_run_id from catalyst_kb.sync_runs where state='running'`;
    expect(runs).toHaveLength(1);
    await world.drain(String(required(runs[0]).id));
    const run = await world.instance.stores.operationRuns.get({
      clientInstanceId,
      id: String(required(runs[0]).operation_run_id)
    });
    expect(run).toMatchObject({
      status: "done",
      output: { value: { counts: { discovered: 0, added: 0 } } }
    });
  });

  it("refuses a revoked connection.use before opening credentials at sync start", async () => {
    const list = vi.fn();
    const world = await setup((source) => ({
      ...source,
      list: (input, context) => {
        list();
        return source.list(input, context);
      }
    }));
    await world.platform`delete from permission_grants where holder_id in (select id from service_principals where owner_kind='knowledge_base' and owner_asset_id=${world.record.id})`;
    const started = await world.instance.api.call("knowledge_bases.sync", {
      params: { knowledgeBase: KB },
      payload: { source: SOURCE, mode: "full" }
    });
    expect(started.statusCode, started.body).toBe(202);
    await world.worker.runDue();
    // The per-call check also stops listing. Only the start check stops credentials opening.
    expect(world.openSource).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(await world.sql`select state,failure_code from catalyst_kb.sync_runs`).toEqual([
      { state: "failed", failure_code: "knowledge_source_refused" }
    ]);
    const [row] = await world.sql`select operation_run_id from catalyst_kb.sync_runs`;
    expect(
      await world.instance.stores.operationRuns.get({
        clientInstanceId,
        id: String(required(row).operation_run_id)
      })
    ).toMatchObject({ status: "failed", error: { code: "knowledge_source_refused" } });
  });

  it("ends a run whose source disappeared and lets the next start create a new run", async () => {
    const world = await setup();
    const start = () =>
      world.instance.api.call("knowledge_bases.sync", {
        params: { knowledgeBase: KB },
        payload: { source: SOURCE, mode: "full" }
      });
    const started = await start();
    expect(started.statusCode, started.body).toBe(202);
    const [before] = await world.sql`select id,operation_run_id from catalyst_kb.sync_runs`;
    const asset = required(
      await world.instance.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: KNOWLEDGE_BASE_ASSET_KIND,
        name: KB
      })
    );
    // Simulate a stored source no longer resolvable when its queued job starts.
    const missing = vi
      .spyOn(world.instance.stores.configAssets, "getConfigAsset")
      .mockResolvedValueOnce({
        ...asset,
        publishedConfig: {
          name: KB,
          title: "Source",
          description: "Synced test documents",
          methods: ["keyword", "semantic"],
          sources: []
        }
      });
    await world.worker.runDue();
    missing.mockRestore();
    expect(world.openSource).not.toHaveBeenCalled();
    expect(
      await world.sql`select state,failure_code,ended_at is not null as ended from catalyst_kb.sync_runs`
    ).toEqual([{ state: "failed", failure_code: "knowledge_source_unreachable", ended: true }]);
    expect(
      await world.instance.stores.operationRuns.get({
        clientInstanceId,
        id: String(required(before).operation_run_id)
      })
    ).toMatchObject({ status: "failed", error: { code: "knowledge_source_unreachable" } });
    const next = await start();
    expect(next.statusCode, next.body).toBe(202);
    const [running] = await world.sql`select id from catalyst_kb.sync_runs where state='running'`;
    expect(required(running).id).not.toBe(required(before).id);
  });

  it("refuses omitted and changes modes with not_supported_yet, and malformed modes as invalid", async () => {
    const world = await setup();
    for (const payload of [{ source: SOURCE }, { source: SOURCE, mode: "changes" }]) {
      const response = await world.instance.api.call("knowledge_bases.sync", {
        params: { knowledgeBase: KB },
        payload
      });
      expect(response.statusCode, response.body).toBe(422);
      expect(response.body).toContain("not_supported_yet");
    }
    for (const mode of ["initial", "garbage", 1, null]) {
      const response = await world.instance.api.call("knowledge_bases.sync", {
        params: { knowledgeBase: KB },
        payload: { source: SOURCE, mode }
      });
      expect(response.statusCode, response.body).toBe(422);
    }
    expect(await world.sql`select id from catalyst_kb.sync_runs`).toEqual([]);
  });

  it("hides owned principals from all administration paths and never authorizes an absent principal", async () => {
    const world = await setup();
    const owner = { kind: "knowledge_base", assetId: world.record.id };
    const principal = required(
      await world.instance.stores.apiAccess.findServicePrincipalByOwner({ clientInstanceId, owner })
    );
    const params = { servicePrincipalId: principal.id };
    for (const payload of [
      { displayLabel: "Hijacked" },
      { status: "disabled" },
      { status: "active" },
      { permissions: ["config_assets.read"] },
      { status: "disabled", displayLabel: "Hijacked", permissions: ["config_assets.read"] }
    ]) {
      const response = await world.instance.api.call("service_principals.update", {
        params,
        payload
      });
      expect(response.statusCode, response.body).toBe(404);
      expect(response.body).toContain("NOT_FOUND");
    }
    for (const servicePrincipalId of [principal.id, "spn_absent"]) {
      const response = await world.instance.api.call("api_credentials.create", {
        params: { servicePrincipalId },
        payload: { name: "Hijacked" }
      });
      expect(response.statusCode, response.body).toBe(404);
    }
    const absent = await world.instance.api.call("service_principals.update", {
      params: { servicePrincipalId: "spn_absent" },
      payload: { displayLabel: "Absent" }
    });
    expect(absent.statusCode, absent.body).toBe(404);
    const listed = await world.instance.api.call("service_principals.list", {});
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.body).not.toContain(principal.id);
    // Neither individual get nor delete is an administration operation today.
    for (const method of ["GET", "DELETE"] as const) {
      const response = await callTestPath(
        world.instance.api,
        method,
        apiOperations["service_principals.update"].buildPath({ params })
      );
      expect(response.statusCode, response.body).toBe(404);
    }
    const grants = await world.instance.stores.access.listGrants({
      clientInstanceId,
      holderKind: "service_principal",
      holderId: principal.id
    });
    const grant = required(grants[0]);
    const give = await world.instance.api.call("permissions.grant", {
      payload: {
        holderKind: "service_principal",
        holderId: principal.id,
        action: grant.action,
        effect: "allow",
        scopeKind: "asset",
        scopeId: grant.scopeId
      }
    });
    expect(give.statusCode, give.body).toBe(404);
    const take = await world.instance.api.call("permissions.revoke", {
      params: { grantId: grant.id }
    });
    expect(take.statusCode, take.body).toBe(404);
    const effective = await world.instance.api.call("permissions.effective", {
      query: { holderKind: "service_principal", holderId: principal.id }
    });
    expect(effective.statusCode, effective.body).toBe(404);
    for (const query of [{}, { holderKind: "service_principal", holderId: principal.id }]) {
      const grantList = await world.instance.api.call("permissions.list", { query });
      expect(grantList.statusCode, grantList.body).toBe(200);
      expect(grantList.body).not.toContain(principal.id);
    }
    expect(
      await world.instance.stores.apiAccess.findServicePrincipalByOwner({ clientInstanceId, owner })
    ).toEqual(principal);
    expect(
      await world.instance.stores.access.listGrants({
        clientInstanceId,
        holderKind: "service_principal",
        holderId: principal.id
      })
    ).toEqual(grants);
    expect(
      await world.instance.stores.apiAccess.listApiCredentials({
        clientInstanceId,
        servicePrincipalId: principal.id
      })
    ).toEqual([]);
  });

  it("stops the next fetch batch after the ingestion principal loses connection.use (KB 74)", async () => {
    const world = await setup();
    world.world.put({
      folderId: "folder",
      name: "grant.txt",
      mime: "text/plain",
      bytes: new TextEncoder().encode("text")
    });
    const started = await world.instance.api.call("knowledge_bases.sync", {
      params: { knowledgeBase: KB },
      payload: { source: SOURCE, mode: "full" }
    });
    expect(started.statusCode, started.body).toBe(202);
    await world.worker.runDue();
    const opened = world.openSource.mock.calls.length;
    await world.platform`delete from permission_grants where holder_id in (select id from service_principals where owner_kind='knowledge_base' and owner_asset_id=${world.record.id})`;
    await world.worker.runDue();
    expect(world.openSource.mock.calls.length).toBe(opened);
    expect(await world.sql`select state,failure_code from catalyst_kb.sync_runs`).toEqual([
      { state: "failed", failure_code: "knowledge_source_refused" }
    ]);
    expect(await world.sql`select count(*)::int as n from catalyst_kb.documents`).toEqual([
      { n: 0 }
    ]);
  });

  it("keeps file names, paths and text out of runs, audit and job payloads, with one sync audit pair (KB 75)", async () => {
    const world = await setup(undefined, {
      revision: 1,
      extract: async ({ bytes }) => ({
        pages: [{ page: 1, text: new TextDecoder().decode(bytes) }]
      })
    });
    const marker = "SRC1B_PRIVATE_MARKER_745";
    world.world.put({
      folderId: "folder",
      name: `${marker}.pdf`,
      mime: "application/pdf",
      bytes: new TextEncoder().encode(marker)
    });
    const started = await world.instance.api.call("knowledge_bases.sync", {
      params: { knowledgeBase: KB },
      payload: { source: SOURCE, mode: "full" }
    });
    expect(started.statusCode, started.body).toBe(202);
    const [run] = await world.sql`select id from catalyst_kb.sync_runs where state='running'`;
    await world.drain(String(required(run).id));
    expect(
      await world.platform`select count(*)::int as n from platform_jobs where kind='knowledge_base.extract'`
    ).toEqual([{ n: 1 }]);
    const deleted = await world.instance.api.call("assets.delete", {
      params: { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB },
      payload: { expectedRevision: 2 }
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    await world.worker.runDue();
    expect(JSON.stringify(world.logs)).not.toContain(marker);
    for (const table of ["operation_runs", "audit_events", "platform_jobs"]) {
      const rows = await world.platform.unsafe(`select * from ${table}`);
      expect(JSON.stringify(rows)).not.toContain(marker);
    }
    expect(
      await world.platform`select type,count(*)::int as n from audit_events where type in ('knowledge_base.sync_started','knowledge_base.sync_finished','knowledge_base.content_indexed') group by type order by type`
    ).toEqual([
      { type: "knowledge_base.sync_finished", n: 1 },
      { type: "knowledge_base.sync_started", n: 1 }
    ]);
  });

  it("reports derived state, bounded pages, failure codes and content-free locate; retry fetches failed source documents again", async () => {
    const world = await setup();
    const item = world.world.put({
      folderId: "folder",
      name: "inspect.txt",
      mime: "text/plain",
      bytes: new TextEncoder().encode("Inspection text")
    });
    const response = await world.instance.api.call("knowledge_bases.sync", {
      params: { knowledgeBase: KB },
      payload: { source: SOURCE, mode: "full" }
    });
    expect(response.statusCode, response.body).toBe(202);
    const [run] = await world.sql`select id from catalyst_kb.sync_runs`;
    await world.drain(String(required(run).id));
    const sources = await world.instance.api.call("knowledge_bases.sources", {
      params: { knowledgeBase: KB }
    });
    expect(sources.statusCode, sources.body).toBe(200);
    expect(sources.json()).toMatchObject({
      sources: [{ id: SOURCE, items: { indexed: 1 }, last: { state: "done" } }]
    });
    const items = await world.instance.api.call("knowledge_bases.source_items", {
      params: { knowledgeBase: KB, source: SOURCE },
      query: { limit: "1" }
    });
    expect(items.statusCode, items.body).toBe(200);
    const id = String(required(items.json<{ items: { id: string }[] }>().items[0]).id);
    const locate = await world.instance.api.call("knowledge_bases.locate", {
      params: { knowledgeBase: KB },
      query: { sourceItemId: id }
    });
    expect(locate.statusCode, locate.body).toBe(200);
    expect(locate.json()).toMatchObject({ sourceItemId: id, itemId: item, state: "indexed" });
    expect(locate.body).not.toContain("inspect.txt");
    expect(locate.body).not.toContain("Inspection text");
    await world.sql`update catalyst_kb.contents set state='failed',failure_code='knowledge_index_failed'`;
    const retry = await world.instance.api.call("knowledge_bases.retry_documents", {
      params: { knowledgeBase: KB },
      payload: { source: SOURCE, all: true }
    });
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json()).toMatchObject({ queued: 1 });
    const [again] = await world.sql`select id from catalyst_kb.sync_runs where state='running'`;
    await world.drain(String(required(again).id));
    expect(await world.sql`select attempts,state from catalyst_kb.source_items`).toEqual([
      { attempts: 1, state: "fetched" }
    ]);
    const [document] = await world.sql`select id from catalyst_kb.documents`;
    await world.sql`update catalyst_kb.contents set state='failed',failure_code='knowledge_index_failed'`;
    const byDocument = await world.instance.api.call("knowledge_bases.retry_documents", {
      params: { knowledgeBase: KB },
      payload: { documentIds: [String(required(document).id)] }
    });
    expect(byDocument.statusCode, byDocument.body).toBe(200);
    expect(byDocument.json()).toMatchObject({
      documents: [{ id: String(required(document).id), state: "pending" }],
      queued: 1
    });
  });

  it("keeps a retried unsupported item failed with its format code, without fetching it", async () => {
    const world = await setup();
    world.world.put({
      folderId: "folder",
      name: "archive.zip",
      mime: "application/zip",
      bytes: new Uint8Array([1, 2, 3])
    });
    await world.drain(await world.sync());
    const before = world.openSource.mock.calls.length;
    const response = await world.instance.api.call("knowledge_bases.retry_documents", {
      params: { knowledgeBase: KB },
      payload: { source: SOURCE, failureCode: "knowledge_file_format_unsupported" }
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ queued: 1 });
    await world.worker.runDue();
    expect(world.openSource.mock.calls.length).toBe(before);
    expect(await world.sql`select state,failure_code from catalyst_kb.source_items`).toEqual([
      { state: "failed", failure_code: "knowledge_file_format_unsupported" }
    ]);
  });

  it("enforces read and write key levels over HTTP and the CLI", async () => {
    const world = await setup();
    const principal = await world.instance.stores.apiAccess.createServicePrincipal({
      clientInstanceId,
      displayLabel: "Reader",
      permissions: ["config_assets.read"]
    });
    await world.instance.stores.access.createGrant({
      clientInstanceId,
      holderKind: "service_principal",
      holderId: principal.id,
      action: "knowledge_base.read",
      effect: "allow",
      scopeKind: "asset",
      scopeId: world.record.id,
      grantedBy: asUserId(LEGACY_LIST_GRANTOR)
    });
    const { secret } = await world.instance.stores.apiAccess.createApiCredential({
      clientInstanceId,
      servicePrincipalId: principal.id,
      name: "Read",
      scopes: ["config_assets:read"]
    });
    const token = await world.instance.api.call("access_tokens.exchange", {
      headers: { authorization: `Bearer ${secret}` }
    });
    expect(token.statusCode, token.body).toBe(200);
    const headers = {
      authorization: `Bearer ${token.json<{ accessToken: string }>().accessToken}`
    };
    expect(
      (
        await world.instance.api.call("knowledge_bases.sources", {
          params: { knowledgeBase: KB },
          headers
        })
      ).statusCode
    ).toBe(200);
    for (const [operation, payload] of [
      ["knowledge_bases.sync", { source: SOURCE, mode: "full" }],
      ["knowledge_bases.retry_documents", { source: SOURCE, all: true }]
    ] as const) {
      const result = await world.instance.api.call(operation, {
        params: { knowledgeBase: KB },
        payload,
        headers
      });
      expect(result.statusCode, result.body).toBe(403);
    }

    const admin = required(
      (await world.instance.stores.users.listUsers({ clientInstanceId })).find((user) =>
        user.roles.includes("superadmin")
      )
    );
    const personal = await world.instance.stores.personalApiKeys.createPersonalApiKey({
      clientInstanceId,
      ownerUserId: admin.id,
      name: "Write",
      scopes: ["knowledge_base.read", "knowledge_base.write"],
      expiresAt: new Date(Date.now() + 86400000).toISOString()
    });
    const stdout: string[] = [],
      stderr: string[] = [];
    const cliOptions = {
      cwd: world.instance.filesRoot,
      env: { CATALYST_API_KEY: personal.secret },
      fetchImpl: createTestFetch(world.instance.api),
      stdout: (text: string) => {
        stdout.push(text);
      },
      stderr: (text: string) => {
        stderr.push(text);
      }
    };
    const synced = await runCli(
      [
        "knowledge-base",
        "sync",
        KB,
        "--source",
        SOURCE,
        "--full",
        "--instance",
        "https://catalyst.test",
        "--json"
      ],
      cliOptions
    );
    expect(synced, stderr.join("")).toBe(0);
    expect(stdout.join("")).toContain('"running"');
    const retried = await runCli(
      [
        "knowledge-base",
        "source",
        "retry",
        KB,
        "--source",
        SOURCE,
        "--all",
        "--instance",
        "https://catalyst.test",
        "--json"
      ],
      cliOptions
    );
    expect(retried, stderr.join("")).toBe(0);
    expect(stdout.join("")).toContain('"queued"');
    const [run] = await world.sql`select id from catalyst_kb.sync_runs where state='running'`;
    await world.drain(String(required(run).id));
  });
  it("creates the principal and grant in the publish transaction; a failed publish leaves neither, and removal stays refused", async () => {
    const world = await setup();
    const definition = {
      name: "publish-source",
      title: "Published source",
      description: "Publish gate",
      methods: ["keyword"],
      sources: [{ id: SOURCE, connection: "fixture", folders: ["folder"] }]
    };
    const written = await world.instance.api.call("assets.put", {
      params: { kind: KNOWLEDGE_BASE_ASSET_KIND, name: definition.name },
      payload: { config: definition, expectedRevision: null }
    });
    expect(written.statusCode, written.body).toBe(200);
    const asset = required(
      await world.instance.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: KNOWLEDGE_BASE_ASSET_KIND,
        name: definition.name
      })
    );
    const owner = { kind: "knowledge_base", assetId: asset.id };
    const access = createActorAccess(
      {
        clientInstanceId,
        kind: "user",
        id: "publisher",
        roles: ["superadmin"],
        permissionRefs: []
      },
      { holderActive: true, grants: [] }
    );
    const publish = () =>
      world.instance.stores.transaction((stores) =>
        world.knowledge.publish(stores, {
          access,
          assetId: asset.id,
          revision: 1,
          config: definition,
          replaced: undefined
        })
      );
    const failing = vi
      .spyOn(world.dataStores.knowledgeBackend, "publish")
      .mockRejectedValueOnce(new Error("Injected publish failure"));
    await expect(publish()).rejects.toThrow("Injected publish failure");
    failing.mockRestore();
    expect(
      await world.instance.stores.apiAccess.findServicePrincipalByOwner({ clientInstanceId, owner })
    ).toBeUndefined();
    await publish();
    const principal = required(
      await world.instance.stores.apiAccess.findServicePrincipalByOwner({ clientInstanceId, owner })
    );
    expect(
      await world.instance.stores.apiAccess.listApiCredentials({
        clientInstanceId,
        servicePrincipalId: principal.id
      })
    ).toEqual([]);
    const grants = await world.instance.stores.access.listGrants({
      clientInstanceId,
      holderKind: "service_principal",
      holderId: principal.id,
      action: "connection.use"
    });
    expect(grants).toHaveLength(1);
    await expect(
      world.instance.stores.apiAccess.createApiCredential({
        clientInstanceId,
        servicePrincipalId: principal.id,
        name: "Forbidden"
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      world.instance.stores.transaction((stores) =>
        world.knowledge.publish(stores, {
          access,
          assetId: asset.id,
          revision: 2,
          config: { ...definition, sources: [] },
          replaced: definition
        })
      )
    ).rejects.toMatchObject({ details: { reason: "not_supported_yet" } });
    const denied = createActorAccess(
      { clientInstanceId, kind: "user", id: "publisher", roles: [], permissionRefs: [] },
      { holderActive: true, grants: [] }
    );
    await expect(
      world.instance.stores.transaction((stores) =>
        world.knowledge.publish(stores, {
          access: denied,
          assetId: asset.id,
          revision: 1,
          config: definition,
          replaced: undefined
        })
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN", details: { action: "connection.use" } });
    // An unchanged source (including a title-only publish) lends no new access.
    await expect(
      world.instance.stores.transaction((stores) =>
        world.knowledge.publish(stores, {
          access: denied,
          assetId: asset.id,
          revision: 2,
          config: { ...definition, title: "Renamed" },
          replaced: definition
        })
      )
    ).resolves.toBeUndefined();
    // Adding another source on the same Connection still asks connection.use.
    await expect(
      world.instance.stores.transaction((stores) =>
        world.knowledge.publish(stores, {
          access: denied,
          assetId: asset.id,
          revision: 3,
          config: {
            ...definition,
            sources: [
              ...definition.sources,
              { id: "second", connection: "fixture", folders: ["other"] }
            ]
          },
          replaced: definition
        })
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN", details: { action: "connection.use" } });
    await world.knowledge.retire(world.instance.stores, asset.id, definition);
    expect(
      await world.instance.stores.apiAccess.findServicePrincipalByOwner({ clientInstanceId, owner })
    ).toBeUndefined();
    expect(
      await world.instance.stores.access.listGrants({
        clientInstanceId,
        holderKind: "service_principal",
        holderId: principal.id
      })
    ).toEqual([]);
  });
});
