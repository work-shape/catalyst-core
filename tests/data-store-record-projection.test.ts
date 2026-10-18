import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  createPlatformId,
  createOperationRegistry,
  StoreBackedAuditRecorder,
  NoopAuditRecorder,
  type AuthenticatedUser,
  type JsonObject,
  type JobControl,
  type OperationBatchFailure
} from "@work-shape/catalyst-core";
import { runOperation } from "@work-shape/catalyst-tool-execution";
import { manifest, refusal, useDataStoreWorld } from "./support/data-store-world";
import { accessOf } from "./support/access";
import { eventually, required } from "./support/assertions";

const schema = {
  path: "migrations/0001_objects.sql",
  text: "create table objekt (objekt_nr integer primary key, adresse text, baujahr integer, kaufpreis numeric, wohnflaeche numeric);"
};
const records = (key = 'fromPath: "/Objekte/{objekt_nr}/"', always = "[]") =>
  manifest(
    `records:\n  - table: objekt\n    key: { column: objekt_nr, ${key} }\n    precedence: [kaufvertrag, baubeschreibung, expose]\n    review: { always: ${always} }\n`
  );

describe("REC-1a records projection through the public operation source", () => {
  const {
    db,
    setup,
    publish,
    published,
    call,
    connect,
    recordOf,
    settle,
    platformRole,
    takeOver,
    platformDatabase
  } = useDataStoreWorld("record_projection");
  const actorOf = (clientInstanceId: AuthenticatedUser["clientInstanceId"]): AuthenticatedUser => ({
    id: "records-admin",
    externalUserId: "records-admin",
    displayLabel: "Records admin",
    roles: ["admin"],
    permissionRefs: [],
    authSource: "test",
    clientInstanceId
  });
  async function asset(
    world: Awaited<ReturnType<typeof published>>,
    kind: string,
    name: string,
    config: JsonObject
  ) {
    const key = `${kind}:${name}`;
    const written = await db.store.configAssets.applyConfigAssetMutations({
      clientInstanceId: world.clientInstanceId,
      baseRevisions: { [key]: null },
      mutations: [{ type: "upsert", kind, name, config, draft: true }]
    });
    const revision = required(written.revisions[key]);
    const stored = required(
      await db.store.configAssets.getConfigAssetRevision({
        clientInstanceId: world.clientInstanceId,
        kind,
        name,
        revision
      })
    );
    const id = required(written.assetIds[key]);
    await db.store.configAssets.publishConfigAssetRevision({
      clientInstanceId: world.clientInstanceId,
      kind,
      name,
      assetId: id,
      revision,
      revisionId: stored.id
    });
    return id;
  }
  async function world(
    label: string,
    files = [records(), schema],
    load?: { rows: number; bytes: number; timeoutMs: number },
    datasets?: { read(): AsyncIterable<readonly JsonObject[]> },
    databaseUrl = db.databaseUrl
  ) {
    const failures: OperationBatchFailure[][] = [];
    const ready = await setup(label, load ? { load } : {}, databaseUrl, datasets, {
      write: async (items) => {
        failures.push([...items]);
        return {
          $dataset: `failures_${failures.length}`,
          rowCount: items.length,
          bytes: JSON.stringify(items).length
        };
      }
    });
    const id = await publish(ready, files);
    const world = { ...ready, id, record: await settle(ready, id, files.length - 1) };
    const kbId = await asset(world, "knowledge_base", "unterlagen", {
      name: "unterlagen",
      title: "Objektunterlagen",
      description: "Test documents",
      methods: ["keyword"]
    });
    await world.dataStores.knowledgeBackend.publish(db.store, {
      target: { backend: "builtin", assetId: kbId, name: "unterlagen", methods: ["keyword"] },
      replaced: undefined,
      access: accessOf(actorOf(world.clientInstanceId))
    });
    await settle(world, kbId, 12);
    const source = connect((await recordOf(world, kbId)).location.database);
    const target = connect(world.record.location.database);
    async function item(
      documentId: string,
      kind: string,
      values: JsonObject,
      date = "2026-10-17",
      path = "/Objekte/1402/file.pdf"
    ) {
      const hash = documentId.padEnd(64, "a").slice(0, 64);
      const text = Object.values(values).join(" ");
      await source`insert into catalyst_kb.contents(sha256,format,state) values (${hash},'pdf','extracted') on conflict do nothing`;
      await source`insert into catalyst_kb.documents(id,managed_file_id,content_sha256,title,file_name) values (${documentId},${documentId},${hash},'Document','file.pdf') on conflict do nothing`;
      await source`insert into catalyst_kb.chunks(id,content_sha256,chunking_revision,position,page,text,token_count) values (${documentId},${hash},1,0,1,${text},10) on conflict do nothing`;
      return {
        knowledgeBaseId: kbId,
        documentId,
        kind,
        documentDate: date,
        path,
        fields: Object.entries(values).map(([name, value]) => ({
          name,
          value,
          page: 1,
          quote: String(value)
        }))
      };
    }
    return { ...world, failures, kbId, source, target, item };
  }

  async function migrateTogether(w: Awaited<ReturnType<typeof world>>, id: string) {
    const handler = required(
      w.dataStores.jobHandlers.find(({ kind }) => kind.kind === "data_store.migrate")
    );
    const jobs = await Promise.all(
      Array.from({ length: 5 }, () =>
        db.store.jobs.enqueue(
          handler.kind,
          { storeId: id },
          {
            clientInstanceId: w.clientInstanceId,
            dedupeKey: createPlatformId("probe")
          }
        )
      )
    );
    const control: JobControl = {
      leaseToken: "schema-probe",
      signal: AbortSignal.timeout(10_000),
      attempt: 1,
      logger: w.logger,
      transaction: (work) => db.store.transaction(work)
    };
    if ((await recordOf(w, id)).ownerKnowledgeBaseId) {
      await Promise.all(jobs.map((job) => handler.bind(job).run(control)));
    } else {
      for (const job of jobs) await handler.bind(job).run(control);
    }
    expect((await recordOf(w, id)).failure).toBeUndefined();
  }

  it.each(["customer", "owned"] as const)(
    "%s ensure is idempotent across repeated upgrades (owned attempts run five in parallel)",
    async (kind) => {
      const w = await world(`ensure-${kind}`);
      const record = kind === "owned" ? await recordOf(w, w.kbId) : w.record;
      const sql = connect(record.location.database);
      await sql`drop function catalyst.project_record(text,jsonb)`;
      if (kind === "owned") {
        // Start before schema creation: even the losing CREATE/REVOKE attempts must be safe.
        await sql.unsafe("drop schema catalyst_kb cascade");
        await db.store.dataStores.putDataStore({ ...record, level: 0, migrations: [] });
      } else await sql`alter table catalyst.record_fields drop column content_sha256`;
      await migrateTogether(w, record.id);
      const before =
        await sql`select oid,prosrc,proowner,prosecdef,proconfig,proacl from pg_proc where oid='catalyst.project_record(text,jsonb)'::regprocedure`;
      await migrateTogether(w, record.id);
      expect(
        await sql`select oid,prosrc,proowner,prosecdef,proconfig,proacl from pg_proc where oid='catalyst.project_record(text,jsonb)'::regprocedure`
      ).toEqual(before);
      expect(
        await sql`select count(*)::int as n from information_schema.columns where table_schema='catalyst' and table_name='record_fields' and column_name='content_sha256'`
      ).toEqual([{ n: 1 }]);
      if (kind === "owned")
        expect(await sql`select number from catalyst_kb.migrations order by number`).toHaveLength(
          12
        );
    }
  );

  it.each(["customer", "owned"] as const)(
    "%s store: eight concurrent proposals take no ACCESS EXCLUSIVE lock and run no DDL",
    async (kind) => {
      const w = await world(`concurrent-${kind}`);
      if (kind === "owned") {
        // The public operation is customer-only. Point its test definition at the owned
        // database to exercise the very same writer after the owned upgrade path.
        const owned = await recordOf(w, w.kbId);
        // The hosted platform role is named catalyst, which is also a schema. Customer
        // tables belong to public, regardless of the bootstrap connection's search path.
        await w.source.unsafe(`set search_path=public; ${schema.text}`);
        await w.source.unsafe(
          `grant select,insert,update,delete on objekt to "${owned.roles.app}"`
        );
        await db.store.dataStores.putDataStore({
          ...w.record,
          location: owned.location,
          roles: owned.roles
        });
      }
      const targetRecord = await recordOf(w, w.id);
      const observer = connect(targetRecord.location.database);
      const holder = await connect(targetRecord.location.database).reserve();
      const items = await Promise.all(
        Array.from({ length: 8 }, (_, n) =>
          w.item(
            `d${n}`,
            "kaufvertrag",
            { kaufpreis: 100 + n },
            "2026-10-18",
            `/Objekte/${1400 + n}/file.pdf`
          )
        )
      );
      await observer.unsafe(`create function public.no_propose_ddl() returns event_trigger language plpgsql as $body$
        begin raise exception 'DDL in records.propose'; end $body$;
        create event trigger no_propose_ddl on ddl_command_end execute function public.no_propose_ddl();`);
      await holder`begin`;
      await holder`lock table catalyst.record_fields in access share mode`;
      let finished = false;
      const pending = Promise.allSettled(
        items.map((item, n) =>
          call(w, "records.propose", { table: "objekt", items: [item] }, `parallel-${n}`)
        )
      ).then((results) => {
        finished = true;
        return results;
      });
      let exclusiveLocks: { mode: string }[] = [];
      try {
        await eventually(async () => {
          exclusiveLocks = await observer<
            { mode: string }[]
          >`select mode from pg_locks where relation='catalyst.record_fields'::regclass and mode='AccessExclusiveLock'`;
          expect(finished || exclusiveLocks.length > 0).toBe(true);
        });
        expect(exclusiveLocks).toEqual([]);
      } finally {
        await holder`rollback`;
        holder.release();
        await pending;
        await observer.unsafe("drop event trigger no_propose_ddl");
        if (kind === "owned") await db.store.dataStores.putDataStore(w.record);
      }
      const results = await pending;
      for (const result of results) if (result.status === "rejected") throw result.reason;
      expect(results.map((result) => result.status)).toEqual(Array(8).fill("fulfilled"));
      for (const result of results)
        if (result.status === "fulfilled")
          expect(result.value).toMatchObject({ done: 1, failed: 0 });
      expect(await observer`select count(*)::int as n from objekt`).toEqual([{ n: 8 }]);
      expect(await observer`select count(*)::int as n from catalyst.record_fields`).toEqual([
        { n: 8 }
      ]);
    }
  );

  it.each(["column", "frame"] as const)(
    "refuses a missing %s with a named EN/DE upgrade message and never repairs it",
    async (missing) => {
      const w = await world(`missing-${missing}`);
      if (missing === "column")
        await w.target`alter table catalyst.record_fields drop column content_sha256`;
      else await w.target`drop function catalyst.project_record(text,jsonb)`;
      for (const locale of ["en", "de"] as const) {
        const error = await refusal(
          call(w, "records.propose", { table: "objekt", items: [] }, undefined, locale)
        );
        expect(error).toMatchObject({
          code: "CONFLICT",
          details: { reason: "record_store_upgrade_required", store: "findings" }
        });
        expect(error.message).toContain("findings");
        expect(error.message).toContain(
          locale === "de" ? "benötigt sein Upgrade" : "needs its upgrade"
        );
      }
      expect(await w.target`select count(*)::int as n from catalyst.loads`).toEqual([{ n: 0 }]);
    }
  );

  it("uses the installed frame without app-login repair or credentials on its fixed reads", async () => {
    const w = await world("frame-login");
    await takeOver(w.record.roles.app);
    const item = await w.item("a0", "kaufvertrag", { kaufpreis: 100 });
    expect(await call(w, "records.propose", { table: "objekt", items: [item] })).toMatchObject({
      done: 1,
      failed: 0
    });
    expect(await w.target`select kaufpreis::float8 from objekt`).toEqual([{ kaufpreis: 100 }]);
  });

  it("refuses an app-owned frame changed to SECURITY INVOKER by an earlier trigger", async () => {
    const w = await world("frame-flags");
    const item = await w.item("af", "kaufvertrag", { kaufpreis: 100 });
    await w.target
      .unsafe(`create function public.change_frame() returns trigger language plpgsql as $body$
      begin alter function catalyst.project_record(text,jsonb) security invoker; return new; end $body$;
      create trigger change_frame after insert on objekt for each row execute function public.change_frame();`);
    expect(
      await refusal(call(w, "records.propose", { table: "objekt", items: [item] }))
    ).toMatchObject({ details: { sqlState: "42501" } });
    expect(await w.target`select count(*)::int as n from objekt`).toEqual([{ n: 0 }]);
  });

  it("check 84: merges Exposé, Kaufvertrag and Baubeschreibung, projects one row, flags Widerspruch and Objekt zuordnen, and lists Gefüllt von with the Knowledge Base", async () => {
    const w = await world("check84");
    const items = [
      await w.item("a1", "expose", { adresse: "Teststraße", kaufpreis: 150 }, "2026-10-18"),
      await w.item("b1", "kaufvertrag", { kaufpreis: 100 }),
      await w.item("c1", "baubeschreibung", { baujahr: 2000, wohnflaeche: 80 }),
      await w.item("f1", "sonstiges", { kaufpreis: 999 }, "2026-10-19")
    ];
    expect(await call(w, "records.propose", { table: "objekt", items })).toMatchObject({
      done: 4,
      failed: 0
    });
    expect(
      await w.target`select objekt_nr,adresse,baujahr,kaufpreis::float8,wohnflaeche::float8 from objekt`
    ).toEqual([
      { objekt_nr: 1402, adresse: "Teststraße", baujahr: 2000, kaufpreis: 100, wohnflaeche: 80 }
    ]);
    expect(
      await w.target`select count(*)::int as n from catalyst.record_fields where content_sha256 is not null`
    ).toEqual([{ n: 6 }]);
    const conflict = await w.item("d1", "kaufvertrag", { kaufpreis: 200 });
    await call(w, "records.propose", { table: "objekt", items: [conflict] }, "conflict");
    expect(await w.target`select kaufpreis from objekt`).toEqual([{ kaufpreis: null }]);
    expect(
      await w.target`select distinct state from catalyst.record_fields where field_name='kaufpreis'`
    ).toEqual([{ state: "conflict" }]);
    const missing = await w.item(
      "e1",
      "expose",
      { adresse: "Unassigned" },
      "2026-10-18",
      "/Other/file.pdf"
    );
    await call(w, "records.propose", { table: "objekt", items: [missing] }, "unassigned");
    expect(
      await w.target`select record_key from catalyst.record_fields where document_id='e1'`
    ).toEqual([{ record_key: null }]);
    expect(await w.target`select count(*)::int as n from objekt`).toEqual([{ n: 1 }]);
    await asset(w, "workflow", "fill", {
      manifest: {
        id: "fill",
        name: "Objekte füllen",
        kind: "data",
        steps: [
          { id: "extract", type: "operation", operation: "knowledge.unterlagen.extract_fields" },
          { id: "propose", type: "operation", operation: "data_store.findings.records.propose" }
        ]
      }
    });
    const using = required(
      await w.dataStores.operationSource.resolve("data_store.findings.used_by")
    );
    // The operation's context has the same instance admin as the public call helper.
    const operation = required(
      await w.dataStores.operationSource.resolve("data_store.findings.describe")
    );
    expect(operation.action).toBe("data_store.read");
    expect(
      using.outputSchema.safeParse(
        await using.execute(
          {},
          {
            runId: createPlatformId("opr"),
            actor: actorOf(w.clientInstanceId),
            origin: { kind: "user" },
            correlationId: "records",
            runtime: {},
            access: accessOf(actorOf(w.clientInstanceId)),
            audit: new NoopAuditRecorder()
          }
        )
      ).data
    ).toMatchObject({
      workflows: [
        {
          name: "fill",
          writes: true,
          sources: [{ knowledgeBase: "unterlagen", title: "Objektunterlagen" }]
        }
      ]
    });
  });

  it("rejects an incompatible whole item, keeps evidence failures for review, resolves field keys, and replays an idempotency key", async () => {
    const w = await world("fieldkey", [records("fromField: objekt_nr"), schema]);
    const good = await w.item("a2", "kaufvertrag", { objekt_nr: 1402, kaufpreis: 100 });
    const bad = {
      ...good,
      documentId: "bad",
      fields: [...good.fields, { name: "absent", value: 12, page: 1, quote: "12" }]
    };
    expect(
      await call(w, "records.propose", { table: "objekt", items: [bad, good] }, "batch")
    ).toMatchObject({ done: 1, failed: 1, failures: { rowCount: 1 } });
    expect(w.failures[0]).toMatchObject([{ code: "record_field_unknown" }]);
    expect(
      await call(w, "records.propose", { table: "objekt", items: [bad, good] }, "batch")
    ).toMatchObject({ done: 1, failed: 1 });
    expect(await w.target`select count(*)::int as n from catalyst.record_fields`).toEqual([
      { n: 2 }
    ]);
    const noEvidence = await w.item("b2", "kaufvertrag", { objekt_nr: 1403, kaufpreis: 200 });
    noEvidence.fields[1] = { name: "kaufpreis", value: 900, page: 1, quote: "200" };
    await call(w, "records.propose", { table: "objekt", items: [noEvidence] }, "evidence");
    expect(await w.target`select kaufpreis from objekt where objekt_nr=1403`).toEqual([
      { kaufpreis: null }
    ]);
    expect(
      await w.target`select evidence from catalyst.record_fields where document_id='b2' and field_name='kaufpreis'`
    ).toEqual([{ evidence: { status: "failed", reason: "value_not_parsed" } }]);
  });

  it("rolls back candidates and customer rows together when load constraints refuse a projection, without exposing a value", async () => {
    const w = await world("rollback");
    await w.target`alter table objekt add constraint bounded_price check(kaufpreis<1000)`;
    const good = await w.item("a3", "kaufvertrag", { kaufpreis: 100 });
    const bad = await w.item(
      "b3",
      "kaufvertrag",
      { kaufpreis: 123456789 },
      "2026-10-18",
      "/Objekte/1403/file.pdf"
    );
    const error = await refusal(
      call(w, "records.propose", { table: "objekt", items: [good, bad] })
    );
    expect(error).toMatchObject({ details: { sqlState: "23514" } });
    expect(JSON.stringify(error)).not.toContain("123456789");
    expect(await w.target`select count(*)::int as n from catalyst.record_fields`).toEqual([
      { n: 0 }
    ]);
    expect(await w.target`select count(*)::int as n from objekt`).toEqual([{ n: 0 }]);
  });
  it.each([
    { kind: "unique", constraint: "unique_address", code: "23505" },
    { kind: "check", constraint: "bounded_price", code: "23514" },
    { kind: "not-null", constraint: "NOT NULL (baujahr)", code: "23502" },
    { kind: "foreign-key", constraint: "known_year", code: "23503" }
  ])(
    "names the $kind constraint for load and records in EN/DE, rolls back and keeps values out of errors, logs and Operation Runs",
    async ({ kind, constraint, code }) => {
      const marker = "row-value-must-stay-private";
      let rows: JsonObject[] = [];
      const w = await world(
        `constraint-${kind}`,
        [
          records(),
          {
            path: "migrations/0001_objects.sql",
            text: `create table years (year integer primary key);
        insert into years values (2000);
        create table objekt (
          objekt_nr integer primary key,
          adresse text constraint unique_address unique,
          baujahr integer not null constraint known_year references years(year),
          kaufpreis numeric constraint bounded_price check(kaufpreis < 1000),
          wohnflaeche numeric
        );
        insert into objekt values (7, '${kind === "unique" ? marker : "existing"}', 2000, 1, null);`
          }
        ],
        undefined,
        {
          async *read() {
            yield rows;
          }
        }
      );
      const before = await w.target`select * from objekt order by objekt_nr`;
      const values: JsonObject = {
        adresse: marker,
        ...(kind === "not-null" ? {} : { baujahr: kind === "foreign-key" ? 1999 : 2000 }),
        kaufpreis: kind === "check" ? 123456789 : 100
      };
      const good = await w.item("ca", "kaufvertrag", {
        adresse: "good",
        baujahr: 2000,
        kaufpreis: 100
      });
      const bad = await w.item("cb", "kaufvertrag", values, "2026-10-18", "/Objekte/1403/file.pdf");
      rows = [
        { objekt_nr: 1402, adresse: "good", baujahr: 2000, kaufpreis: 100 },
        { objekt_nr: 1403, baujahr: null, ...values }
      ];
      const registry = createOperationRegistry();
      registry.addSource(w.dataStores.operationSource);
      const actor = actorOf(w.clientInstanceId);
      for (const verb of ["load", "records.propose"] as const) {
        for (const locale of ["en", "de"] as const) {
          const outcome = await runOperation(
            {
              operation: `data_store.findings.${verb}`,
              effect: "changing",
              input:
                verb === "load"
                  ? {
                      table: "objekt",
                      dataset: {
                        $dataset: "constraint-rows",
                        rowCount: rows.length,
                        bytes: JSON.stringify(rows).length
                      }
                    }
                  : { table: "objekt", items: [good, bad] },
              actor,
              origin: {
                kind: "workflow",
                workflowRunId: "constraint-run",
                stepRunId: `${verb}-${locale}`
              },
              idempotencyKey: `constraint-${verb}-${locale}`,
              correlationId: "constraint-test"
            },
            {
              clientInstanceId: w.clientInstanceId,
              registry,
              resolveResource: (resource) => Promise.resolve({ resource }),
              runs: db.store.operationRuns,
              authorizer: { forActor: async () => accessOf(actor) },
              events: { emit: async () => ({ outcome: "allow", guardrails: [] }) },
              audit: new StoreBackedAuditRecorder({
                clientInstanceId: w.clientInstanceId,
                store: db.store.audit
              }),
              policy: {
                instanceDefaults: { reading: "allow", changing: "allow" },
                centralSettings: () => []
              },
              logger: w.logger
            },
            { locale }
          );
          expect(outcome.result).toMatchObject({
            status: "failed",
            error: {
              code: "VALIDATION_FAILED",
              details: { sqlState: code },
              message: expect.stringContaining(constraint)
            }
          });
          if (outcome.result.status !== "failed") throw new Error("Expected constraint refusal");
          expect(outcome.result.error.message).toContain("objekt");
          expect(outcome.result.error.message).toContain(
            locale === "de" ? "verletzt die Einschränkung" : "violates constraint"
          );
          const stored = await db.store.operationRuns.get({
            clientInstanceId: w.clientInstanceId,
            id: outcome.run.id
          });
          expect(stored).toMatchObject({
            status: "failed",
            error: { message: expect.stringContaining(constraint) }
          });
          const exposed = inspect(
            { result: outcome.result, run: stored, logs: w.logged },
            { depth: null }
          );
          expect(exposed).not.toContain(marker);
          expect(exposed).not.toContain("123456789");
          expect(await w.target`select * from objekt order by objekt_nr`).toEqual(before);
          expect(await w.target`select count(*)::int as n from catalyst.record_fields`).toEqual([
            { n: 0 }
          ]);
          expect(await w.target`select count(*)::int as n from catalyst.loads`).toEqual([{ n: 0 }]);
        }
      }
    }
  );

  it("replays a Workflow step without a call key, including its original failures reference", async () => {
    const w = await world("step-replay");
    const item = await w.item("a4", "kaufvertrag", { kaufpreis: 100 });
    const operation = required(
      await w.dataStores.operationSource.resolve("data_store.findings.records.propose")
    );
    const context = {
      runId: createPlatformId<"OperationRunId">("opr"),
      actor: actorOf(w.clientInstanceId),
      origin: {
        kind: "workflow",
        workflowRunId: "records-run",
        stepRunId: "records-step"
      } as const,
      correlationId: "replay",
      runtime: {},
      access: accessOf(actorOf(w.clientInstanceId)),
      audit: new NoopAuditRecorder()
    };
    const first = await operation.execute({ table: "objekt", items: [item] }, context);
    await w.target`update objekt set kaufpreis=999`;
    expect(await operation.execute({ table: "objekt", items: [item] }, context)).toEqual(first);
    expect(w.failures).toHaveLength(1);
    expect(await w.target`select kaufpreis::float8 from objekt`).toEqual([{ kaufpreis: 999 }]);
  });

  it("cannot elevate a customer deferred trigger to the platform role", async () => {
    const w = await world("trigger-role");
    await w.target
      .unsafe(`create function public.try_platform() returns trigger language plpgsql as $body$ begin execute 'reset role'; return new; end $body$;
      create constraint trigger try_platform after insert or update on objekt deferrable initially deferred for each row execute function public.try_platform();`);
    const item = await w.item("a5", "kaufvertrag", { kaufpreis: 100 });
    const error = await refusal(call(w, "records.propose", { table: "objekt", items: [item] }));
    expect(error).toMatchObject({ details: { sqlState: "42501" } });
    expect(await w.target`select count(*)::int as n from catalyst.record_fields`).toEqual([
      { n: 0 }
    ]);
    expect(await w.target`select count(*)::int as n from objekt`).toEqual([{ n: 0 }]);
  });
  it("uses load's row-byte accounting and honours an operator timeout above the default", async () => {
    const row = { objekt_nr: 1402, kaufpreis: 100 };
    const w = await world("load-ceilings", undefined, {
      rows: 1,
      bytes: Buffer.byteLength(JSON.stringify(row)),
      timeoutMs: 700_000
    });
    const operation = required(
      await w.dataStores.operationSource.resolve("data_store.findings.records.propose")
    );
    expect(operation.timeoutMs).toBe(730_000);
    const item = await w.item("a6", "kaufvertrag", { kaufpreis: 100 });
    expect(await call(w, "records.propose", { table: "objekt", items: [item] })).toMatchObject({
      done: 1,
      failed: 0
    });
    expect(await w.target`select objekt_nr,kaufpreis::float8 from objekt`).toEqual([row]);
  });
  it("preserves quoted customer column names in records and the shared load path", async () => {
    const w = await world("column-names", undefined, undefined, {
      async *read() {
        yield [{ objekt_nr: 1402, ["__proto__"]: "loaded" }];
      }
    });
    await w.target.unsafe('alter table objekt add column "__proto__" text');
    const item = await w.item("a7", "kaufvertrag", { ["__proto__"]: "proposed" });
    await call(w, "records.propose", { table: "objekt", items: [item] });
    expect(await w.target.unsafe('select "__proto__" as stored from objekt')).toEqual([
      { stored: "proposed" }
    ]);
    await call(w, "load", {
      table: "objekt",
      dataset: { $dataset: "quoted-columns", rowCount: 1, bytes: 100 },
      key: ["objekt_nr"],
      onConflict: "update"
    });
    expect(await w.target.unsafe('select "__proto__" as stored from objekt')).toEqual([
      { stored: "loaded" }
    ]);
  });
  it("refuses a stale failures reference before any customer write", async () => {
    const w = await published("stale-failures", [records(), schema], undefined, {
      write: async () => ({ $dataset: "old-failures", rowCount: 1, bytes: 1 })
    });
    expect(await refusal(call(w, "records.propose", { table: "objekt", items: [] }))).toMatchObject(
      { code: "INTERNAL" }
    );
    const target = connect(w.record.location.database);
    expect(await target`select count(*)::int as n from catalyst.loads`).toEqual([{ n: 0 }]);
    expect(await target`select count(*)::int as n from objekt`).toEqual([{ n: 0 }]);
  });
  it("projects as a non-superuser platform account and preserves its original role memberships", async () => {
    const platform = await platformRole();
    await db.sql.unsafe(`alter role "${platform.name}" createdb createrole`);
    await db.sql.unsafe(`alter database "${platformDatabase()}" owner to "${platform.name}"`);
    const w = await world("non-super", undefined, undefined, undefined, platform.databaseUrl);
    const memberships = async () =>
      (
        await db.sql<
          { grantor: string; admin_option: boolean; inherit_option: boolean; set_option: boolean }[]
        >`select m.grantor::text,m.admin_option,m.inherit_option,m.set_option
      from pg_auth_members m join pg_roles r on r.oid=m.roleid join pg_roles u on u.oid=m.member
      where r.rolname=${w.record.roles.app} and u.rolname=${platform.name} order by m.grantor`
      ).map((row) => ({ ...row }));
    const before = await memberships();
    expect(before).toHaveLength(1);
    expect(before.every((row) => row.set_option === false)).toBe(true);
    const item = await w.item("a8", "kaufvertrag", { kaufpreis: 100 });
    expect(await call(w, "records.propose", { table: "objekt", items: [item] })).toMatchObject({
      done: 1,
      failed: 0
    });
    expect(await w.target`select kaufpreis::float8 from objekt`).toEqual([{ kaufpreis: 100 }]);
    expect(await memberships()).toEqual(before);
    // A grant by this account is separate from the bootstrap administrator's grant.
    await w.target.unsafe(
      `grant "${w.record.roles.app}" to "${platform.name}" with inherit true, set false, admin false granted by "${platform.name}"`
    );
    const custom = await memberships();
    expect(custom).toHaveLength(2);
    const newer = await w.item("a9", "kaufvertrag", { kaufpreis: 150 }, "2026-10-18");
    await call(w, "records.propose", { table: "objekt", items: [newer] });
    expect(await memberships()).toEqual(custom);
  });
  it("uses newest document dates with empty precedence and withholds always-reviewed fields until confirmed", async () => {
    const rules = records(undefined, "[kaufpreis]");
    rules.text = rules.text.replace(
      "precedence: [kaufvertrag, baubeschreibung, expose]",
      "precedence: []"
    );
    const w = await world("default-rules", [rules, schema]);
    const older = await w.item("aa", "first-kind", { kaufpreis: 100, wohnflaeche: 80 });
    const newer = await w.item(
      "bb",
      "another-kind",
      { kaufpreis: 200, wohnflaeche: 100 },
      "2026-10-18"
    );
    await call(w, "records.propose", { table: "objekt", items: [newer, older] });
    expect(await w.target`select kaufpreis::float8,wohnflaeche::float8 from objekt`).toEqual([
      { kaufpreis: null, wohnflaeche: 100 }
    ]);
    // A prior human decision is fixture state; REC-1b/REC-2 own the decision writer.
    await w.target`update catalyst.record_fields set state='confirmed',decided_by='reviewer',decided_at=now() where document_id='bb' and field_name='kaufpreis'`;
    const latest = await w.item(
      "cc",
      "third-kind",
      { kaufpreis: 300, wohnflaeche: 110 },
      "2026-10-19"
    );
    await call(w, "records.propose", { table: "objekt", items: [newer, latest] });
    expect(await w.target`select kaufpreis::float8,wohnflaeche::float8 from objekt`).toEqual([
      { kaufpreis: 200, wohnflaeche: 110 }
    ]);
    expect(
      await w.target`select state,decided_by from catalyst.record_fields where document_id='bb' and field_name='kaufpreis'`
    ).toEqual([{ state: "confirmed", decided_by: "reviewer" }]);
  });
});
