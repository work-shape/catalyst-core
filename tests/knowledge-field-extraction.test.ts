import { describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { z } from "zod";
import {
  createActorAccess,
  createPlatformId,
  NoopAuditRecorder,
  type AuthenticatedUser,
  type OperationExecutionContext,
  type KnowledgeFieldExtractor
} from "@work-shape/catalyst-core";
import { eventually, required } from "./support/assertions";
import { clientInstanceId } from "./support/data-store-instance";
import { fileTestDatabaseUrl } from "./support/test-database";
import { useKnowledgeSync } from "./support/knowledge-sync";

const marker = "private-evidence-83";
const sources = [{ id: "source", connection: "fixture", folders: ["folder"] }];
const schema = {
  type: "object",
  description: marker,
  properties: {
    price: { type: "number" },
    invented: { type: "number" },
    wrongPage: { type: "number" },
    area: { type: "number" }
  }
};

describe("PROC-2 extraction through the public Knowledge Base operation", () => {
  const { setup } = useKnowledgeSync();
  const { setup: setupWithDataStoreJobs } = useKnowledgeSync({ withDataStoreJobs: true });
  it("check 83: retains and counts ungrounded evidence for review, pauses only fields at the KB budget, and resumes after a raise without retaining payloads", async () => {
    const extract = vi.fn<KnowledgeFieldExtractor["extract"]>(async () => ({
      text: JSON.stringify({
        values: { price: 12500, invented: 42, wrongPage: 12500, area: 120.5 },
        evidence: [
          { name: "price", page: 1, quote: "Kaufpreis 12.500 EUR" },
          { name: "invented", page: 1, quote: "Kaufpreis 12.500 EUR" },
          { name: "wrongPage", page: 7, quote: "Kaufpreis 12.500 EUR" },
          { name: "area", page: 1, quote: "Wohnfläche 120,5 m²" }
        ]
      }),
      cost: 0.25
    }));
    const world = await setup(undefined, undefined, false, undefined, {
      currency: "EUR",
      reserveCost: () => 1,
      extract
    });
    world.world.put({
      folderId: "folder",
      name: "contract.txt",
      mime: "text/plain",
      bytes: new TextEncoder().encode(`${marker} Kaufpreis 12.500 EUR. Wohnfläche 120,5 m²`)
    });
    await world.drain(await world.sync());
    const [document] =
      await world.sql`select id from catalyst_kb.documents where withdrawn_at is null`;
    const documentId = String(required(document).id);
    const call = () =>
      world.instance.api.call("knowledge_bases.extract_fields", {
        params: { knowledgeBase: "sync-test" },
        payload: { documentId, schema }
      });
    await world.publishSources(sources, {
      extraction: { budget: { perMonth: 0, maxTokensPerDocument: 8000 } }
    });
    const paused = await call();
    expect(paused.statusCode, paused.body).toBe(409);
    expect(extract).not.toHaveBeenCalled();
    const listing = await world.instance.api.call("knowledge_bases.list_documents", {
      params: { knowledgeBase: "sync-test" }
    });
    expect(listing.json()).toMatchObject({
      documents: [{ id: documentId, state: "indexed", fieldsPending: true }]
    });
    const search = await world.instance.api.call("knowledge_bases.search", {
      params: { knowledgeBase: "sync-test" },
      payload: { query: "Kaufpreis" }
    });
    expect(search.statusCode, search.body).toBe(200);
    expect(search.json()).toMatchObject({ passages: [expect.objectContaining({ documentId })] });
    await world.publishSources(sources, {
      extraction: { budget: { perMonth: 1, maxTokensPerDocument: 8000 } }
    });
    const result = await call();
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toMatchObject({
      droppedFields: 0,
      failedFields: 2,
      fields: {
        price: { value: 12500, page: 1, quote: "Kaufpreis 12.500 EUR" },
        area: { value: 120.5, page: 1, quote: "Wohnfläche 120,5 m²" }
      }
    });
    expect(result.json().fields).toHaveProperty("invented");
    expect(result.json().fields).toHaveProperty("wrongPage");
    expect(
      await world.sql`select fields_pending from catalyst_kb.documents where id=${documentId}`
    ).toEqual([{ fields_pending: false }]);
    // Unparseable output is also a sanitized failure, never a partial result.
    await world.publishSources(sources, {
      extraction: { budget: { perMonth: 5, maxTokensPerDocument: 8000 } }
    });
    extract.mockResolvedValueOnce({ text: "invalid JSON " + marker, cost: 0.25 });
    const invalid = await call();
    expect(invalid.statusCode, invalid.body).toBe(409);
    expect(invalid.body).not.toContain(marker);
    // Returned provider text never escapes through the failure channel.
    extract.mockRejectedValueOnce(new Error(`${marker} Kaufpreis 12.500 EUR`));
    await world.publishSources(sources, {
      extraction: { budget: { perMonth: 5, maxTokensPerDocument: 8000 } }
    });
    const failed = await call();
    expect(failed.statusCode, failed.body).toBe(409);
    const runs =
      await world.platform`select row_to_json(r) as data from operation_runs r where operation='knowledge.sync-test.extract_fields'`;
    const audit = await world.platform`select row_to_json(a) as data from audit_events a`;
    const retained = JSON.stringify({ logs: world.logs, runs, audit, error: failed.json() });
    for (const secret of [marker, "12.500 EUR", "120,5 m²"]) expect(retained).not.toContain(secret);
    // The bare amount, but not as part of a random hex id such as an Operation Run's.
    expect(retained).not.toMatch(/(?<![0-9a-f])12500(?![0-9a-f])/u);
    const [budget] = await world.sql`select spent::float8 as spent from catalyst_kb.field_budgets`;
    expect(required(budget).spent).toBe(1.5);
  });

  it("atomically admits concurrent callers against one budget and rejects invalid schemas before invoking the binding", async () => {
    const extract = vi.fn<KnowledgeFieldExtractor["extract"]>(async () => ({
      text: '{"values":{},"evidence":[]}',
      cost: 1
    }));
    const world = await setup(undefined, undefined, false, undefined, {
      currency: "EUR",
      reserveCost: () => 1,
      extract
    });
    world.world.put({
      folderId: "folder",
      name: "contract.txt",
      mime: "text/plain",
      bytes: new TextEncoder().encode("Contract 83")
    });
    await world.drain(await world.sync());
    await world.publishSources(sources, {
      extraction: { budget: { perMonth: 1, maxTokensPerDocument: 8000 } }
    });
    const [document] =
      await world.sql`select id from catalyst_kb.documents where withdrawn_at is null`;
    const documentId = String(required(document).id);
    const call = (schema: object) =>
      world.instance.api.call("knowledge_bases.extract_fields", {
        params: { knowledgeBase: "sync-test" },
        payload: { documentId, schema }
      });
    expect((await call({ $ref: "https://example.invalid/never-fetch" })).statusCode).toBe(409);
    expect(extract).not.toHaveBeenCalled();
    const results = await Promise.all([call({ type: "object" }), call({ type: "object" })]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    expect(extract).toHaveBeenCalledTimes(1);
  });
  it.each(["de", "en"] as const)(
    "uses the %s instance content locale through extraction and records regardless of caller language",
    async (defaultLocale) => {
      const localeSensitive = (quote: string) => quote === "350.000 EUR" || quote === "350,000 USD";
      const cases = [
        { value: 1205, quote: "Wohnfläche 120,5 m²", passes: false },
        { value: 15, quote: "1,5 Zimmer", passes: false },
        { value: 350, quote: "350.000 EUR", passes: defaultLocale === "en" },
        { value: 35, quote: "35O.OOO", passes: false },
        { value: "5", quote: "15 Einheiten", passes: false },
        { value: 120.5, quote: "Wohnfläche 120,5 m²", passes: true },
        { value: 350000, quote: "350.000 EUR", passes: defaultLocale === "de" },
        { value: 350000, quote: "350,000 USD", passes: defaultLocale === "en" },
        { value: 120.5, quote: "Invented Wohnfläche 120,5 m²", passes: false }
      ].filter((test) => defaultLocale === "de" || localeSensitive(test.quote));
      const extract = vi.fn<KnowledgeFieldExtractor["extract"]>();
      const world = await setupWithDataStoreJobs(
        undefined,
        undefined,
        false,
        undefined,
        {
          currency: "EUR",
          reserveCost: () => 1,
          extract
        },
        defaultLocale
      );
      // Every case reads the same evidence text. Keep one real synced document; the
      // distinct record keys below isolate each proposal and its evidence verdict.
      world.world.put({
        folderId: "folder",
        name: "contract.txt",
        mime: "text/plain",
        bytes: new TextEncoder().encode(
          "Wohnfläche 120,5 m². 1,5 Zimmer. 350.000 EUR. 350,000 USD. 35O.OOO. 15 Einheiten."
        )
      });
      await world.drain(await world.sync());
      const [document] =
        await world.sql`select id from catalyst_kb.documents where withdrawn_at is null`;
      const documentId = String(required(document).id);
      const config = world.dataStores.readFiles([
        {
          path: "store.yaml",
          bytes: new TextEncoder().encode(
            'id: review\nname: Review\ndescription: Evidence regression\nrecords:\n  - table: readings\n    key: {column: id, fromPath: "/cases/{id}/"}\n    precedence: [default]\n    review: {always: []}\n'
          )
        },
        {
          path: "migrations/0001_readings.sql",
          bytes: new TextEncoder().encode(
            "create table readings (id integer primary key, amount numeric, label text);"
          )
        }
      ]);
      const stores = world.instance.stores;
      const written = await stores.configAssets.applyConfigAssetMutations({
        clientInstanceId,
        baseRevisions: { "data_store:review": null },
        mutations: [{ type: "upsert", kind: "data_store", name: "review", config, draft: true }]
      });
      const assetId = required(written.assetIds["data_store:review"]);
      const revision = required(written.revisions["data_store:review"]);
      const saved = required(
        await stores.configAssets.getConfigAssetRevision({
          clientInstanceId,
          kind: "data_store",
          name: "review",
          revision
        })
      );
      await stores.configAssets.publishConfigAssetRevision({
        clientInstanceId,
        kind: "data_store",
        name: "review",
        assetId,
        revision,
        revisionId: saved.id
      });
      await world.dataStores.publish(stores, { assetId, revision, config });
      const record = await eventually(async () => {
        await world.worker.runDue();
        const record = required(
          await stores.dataStores.getDataStore({ clientInstanceId, id: assetId })
        );
        expect(record.status).toBe("ready");
        expect(record.level).toBe(1);
        return record;
      });
      const url = new URL(await fileTestDatabaseUrl());
      url.pathname = `/${record.location.database}`;
      const target = postgres(url.toString(), { max: 1, onnotice() {} });
      const actor: AuthenticatedUser = {
        clientInstanceId,
        id: "publisher",
        externalUserId: "publisher",
        displayLabel: "Publisher",
        authSource: "test",
        roles: ["superadmin"],
        permissionRefs: []
      };
      const access = createActorAccess(
        { ...actor, kind: "user" },
        { holderActive: true, grants: [] }
      );
      const propose = required(
        await world.dataStores.operationSource.resolve("data_store.review.records.propose")
      );
      try {
        for (const callerLocale of [undefined, "de", "en"] as const) {
          for (const [index, test] of cases.entries()) {
            if (!localeSensitive(test.quote) && callerLocale !== "de") continue;
            const name = typeof test.value === "string" ? "label" : "amount";
            extract.mockResolvedValueOnce({
              text: JSON.stringify({
                values: { [name]: test.value, unsupported: 1 },
                evidence: [{ name, page: 1, quote: test.quote }]
              }),
              cost: 0.1
            });
            const response = await world.instance.api.call("knowledge_bases.extract_fields", {
              headers: callerLocale ? { "accept-language": callerLocale } : {},
              params: { knowledgeBase: "sync-test" },
              payload: {
                documentId,
                schema: {
                  type: "object",
                  properties: { [name]: { type: typeof test.value } },
                  additionalProperties: false
                }
              }
            });
            expect(response.statusCode, response.body).toBe(200);
            const result = response.json();
            expect(result.droppedFields).toBe(1);
            expect(result.failedFields, test.quote).toBe(test.passes ? 0 : 1);
            expect(result.fields[name]).toEqual({ value: test.value, page: 1, quote: test.quote });
            const context: OperationExecutionContext = {
              runId: createPlatformId("opr"),
              actor,
              access,
              audit: new NoopAuditRecorder(),
              correlationId: "adversarial",
              origin: {
                kind: "workflow",
                workflowRunId: "run",
                stepRunId: createPlatformId("step")
              },
              runtime: callerLocale ? { locale: callerLocale } : {}
            };
            const proposed = await propose.execute(
              {
                table: "readings",
                items: [
                  {
                    knowledgeBaseId: world.record.id,
                    documentId,
                    kind: result.type,
                    documentDate: result.date,
                    path: `/cases/${index}/contract.txt`,
                    fields: Object.entries(result.fields).map(([name, field]) => ({
                      name,
                      ...z
                        .object({
                          value: z.union([z.string(), z.number()]),
                          page: z.number(),
                          quote: z.string()
                        })
                        .parse(field)
                    }))
                  }
                ]
              },
              context
            );
            expect(proposed).toMatchObject({ failures: { rowCount: 0 } });
            const [candidate] =
              await target`select evidence, record_key from catalyst.record_fields where document_id=${documentId} and field_name=${name} and record_key=${index}::jsonb`;
            expect(required(candidate).record_key).toBe(index);
            expect(required(candidate).evidence, test.quote).toMatchObject({
              status: test.passes ? "passed" : "failed"
            });
            const [projected] =
              await target`select amount::float8, label from readings where id=${index}`;
            expect(required(projected)[name], test.quote).toBe(test.passes ? test.value : null);
          }
        }
      } finally {
        await target.end();
      }
    }
  );
  it("admits a varied 25 KB German contract by default, refuses 40 KB with estimate and limit, and resumes after a raise", async () => {
    const extract = vi.fn<KnowledgeFieldExtractor["extract"]>(async () => ({
      text: '{"values":{},"evidence":[]}',
      cost: 0
    }));
    const world = await setup(undefined, undefined, false, undefined, {
      currency: "EUR",
      reserveCost: () => 1,
      extract
    });
    const contract = (minimumBytes: number) => {
      const clauses: string[] = [];
      for (
        let section = 1;
        new TextEncoder().encode(clauses.join("\n")).byteLength < minimumBytes;
        section += 1
      ) {
        const terms = [
          `Der Vermieter übergibt im Abschnitt ${section} die Räume im geprüften Zustand. Die Schlüssel werden am ${(section % 28) + 1}. März 2024 gegen Empfangsbestätigung ausgehändigt.`,
          `Für die Einheit ${section} beträgt die monatliche Grundmiete ${800 + section},50 EUR. Betriebskosten werden jährlich nach den tatsächlich angefallenen Ausgaben abgerechnet.`,
          `Die Parteien dokumentieren unter Ziffer ${section} die vorhandenen Zählerstände. Änderungen an elektrischen Anlagen bedürfen einer schriftlichen Zustimmung und fachgerechten Ausführung.`,
          `Anlage ${section} beschreibt die Nutzung von Garten, Keller und gemeinschaftlichen Flächen. Der Mieter hält die Zugänge frei und meldet erkennbare Schäden unverzüglich.`,
          `Die Sicherheitsleistung für Vertragsteil ${section} darf in drei gleichen Monatsraten erbracht werden. Sie wird getrennt vom übrigen Vermögen verzinst angelegt.`,
          `Nach Maßgabe von Nummer ${section} stimmen die Beteiligten Besichtigungstermine rechtzeitig ab. Bei dringender Gefahr ist der Zugang zur Schadensbegrenzung zu ermöglichen.`,
          `Das Übergabeprotokoll ${section} enthält die vereinbarten Instandsetzungen mit Fristen. Der Auftragnehmer weist die verwendeten Materialien durch geeignete Belege nach.`,
          `Ergänzungen zu Paragraph ${section} werden von beiden Vertragsparteien unterzeichnet. Sollte eine Bestimmung unwirksam sein, bleiben die übrigen Vereinbarungen bestehen.`
        ];
        clauses.push(required(terms[section % terms.length]));
      }
      return clauses.join("\n");
    };
    const text = contract(25_000);
    expect(new TextEncoder().encode(text).byteLength).toBeLessThan(25_500);
    const sourceId = world.world.put({
      folderId: "folder",
      name: "reference.txt",
      mime: "text/plain",
      bytes: new TextEncoder().encode(text)
    });
    await world.drain(await world.sync());
    const documentId = String(
      required(
        (await world.sql`select id from catalyst_kb.documents where withdrawn_at is null`)[0]
      ).id
    );
    const call = () =>
      world.instance.api.call("knowledge_bases.extract_fields", {
        params: { knowledgeBase: "sync-test" },
        payload: { documentId, schema: { type: "object" } }
      });
    const result = await call();
    expect(result.statusCode, result.body).toBe(200);
    const input = required(extract.mock.calls[0]?.[0]);
    expect(input.maxTokens).toBeGreaterThan(0);
    expect(input.deadline.getTime() - Date.now()).toBeGreaterThan(120000);
    expect((await world.sql`select spent::float8 from catalyst_kb.field_budgets`)[0]?.spent).toBe(
      0
    );
    world.world.write(sourceId, new TextEncoder().encode(contract(40_000)));
    await world.drain(await world.sync("changes"));
    const refused = await call();
    expect(refused.statusCode, refused.body).toBe(409);
    const documents = await world.instance.api.call("knowledge_bases.list_documents", {
      params: { knowledgeBase: "sync-test" }
    });
    expect(documents.json()).toMatchObject({
      documents: [
        {
          fieldsPending: true,
          fieldsPendingReason: {
            reason: "token_budget",
            estimatedTokens: expect.any(Number),
            reservedOutputTokens: 512,
            maxTokensPerDocument: 8000
          }
        }
      ]
    });
    expect(refused.json()).toMatchObject({
      error: {
        details: {
          estimatedTokens: expect.any(Number),
          reservedOutputTokens: 512,
          maxTokensPerDocument: 8000
        }
      }
    });
    expect(refused.json().error.details.estimatedTokens).toBeGreaterThan(10_000);
    expect(extract).toHaveBeenCalledTimes(1);
    await world.publishSources(sources, {
      extraction: { budget: { maxTokensPerDocument: 16000 } }
    });
    expect((await call()).statusCode).toBe(200);
    expect(extract).toHaveBeenCalledTimes(2);
  });

  it.each([
    { fields: 1, reserve: 512 },
    { fields: 9, reserve: 576 }
  ])(
    "reserves $reserve output tokens for $fields fields before admission at the default limit",
    async ({ fields, reserve }) => {
      let estimatedTokens = 8000 - reserve - 1;
      const extract = vi.fn<KnowledgeFieldExtractor["extract"]>(async () => ({
        text: '{"values":{},"evidence":[]}',
        cost: 0
      }));
      const world = await setup(undefined, undefined, false, undefined, {
        currency: "EUR",
        countInputTokens: () => estimatedTokens,
        reserveCost: () => 1,
        extract
      });
      world.world.put({
        folderId: "folder",
        name: "edge.txt",
        mime: "text/plain",
        bytes: new TextEncoder().encode("A document at the admission edge")
      });
      await world.drain(await world.sync());
      const documentId = String(
        required(
          (await world.sql`select id from catalyst_kb.documents where withdrawn_at is null`)[0]
        ).id
      );
      const call = () =>
        world.instance.api.call("knowledge_bases.extract_fields", {
          params: { knowledgeBase: "sync-test" },
          payload: {
            documentId,
            schema: {
              type: "object",
              properties: Object.fromEntries(
                Array.from({ length: fields }, (_, index) => [`field${index}`, { type: "string" }])
              )
            }
          }
        });
      const below = await call();
      expect(below.statusCode, below.body).toBe(200);
      expect(extract.mock.calls[0]?.[0].maxTokens).toBe(reserve + 1);
      estimatedTokens += 1;
      const exact = await call();
      expect(exact.statusCode, exact.body).toBe(200);
      expect(extract.mock.calls[1]?.[0].maxTokens).toBe(reserve);
      estimatedTokens += 1;
      const above = await call();
      expect(above.statusCode, above.body).toBe(409);
      expect(above.json()).toMatchObject({
        error: {
          details: {
            reason: "knowledge_field_token_budget_reached",
            estimatedTokens,
            reservedOutputTokens: reserve,
            maxTokensPerDocument: 8000
          }
        }
      });
      expect(extract).toHaveBeenCalledTimes(2);
      const listing = await world.instance.api.call("knowledge_bases.list_documents", {
        params: { knowledgeBase: "sync-test" }
      });
      expect(listing.json()).toMatchObject({
        documents: [
          {
            fieldsPending: true,
            fieldsPendingReason: {
              reason: "token_budget",
              estimatedTokens,
              reservedOutputTokens: reserve,
              maxTokensPerDocument: 8000
            }
          }
        ]
      });
    }
  );

  it("releases admission when the document is withdrawn while loading evidence before a provider call", async () => {
    const extract = vi.fn<KnowledgeFieldExtractor["extract"]>();
    const world = await setup(undefined, undefined, false, undefined, {
      currency: "EUR",
      reserveCost: () => 1,
      extract
    });
    world.world.put({
      folderId: "folder",
      name: "changed.txt",
      mime: "text/plain",
      bytes: new TextEncoder().encode("Kaufpreis 350.000 EUR")
    });
    await world.drain(await world.sync());
    const documentId = String(
      required(
        (await world.sql`select id from catalyst_kb.documents where withdrawn_at is null`)[0]
      ).id
    );
    // The runtime uses its own object-store instance, so intercept the owned-store admission SQL.
    // A trigger on this fixture's counter withdraws the document after admission and before the recheck.
    await world.sql.unsafe(
      `create function catalyst_kb.withdraw_before_field_call() returns trigger language plpgsql as $$ begin update catalyst_kb.documents set withdrawn_at=now(); return new; end $$; create trigger withdraw_before_field_call after update on catalyst_kb.field_budgets for each row execute function catalyst_kb.withdraw_before_field_call()`
    );
    const result = await world.instance.api.call("knowledge_bases.extract_fields", {
      params: { knowledgeBase: "sync-test" },
      payload: { documentId, schema: { type: "object" } }
    });
    expect(result.statusCode, result.body).toBe(409);
    expect(extract).not.toHaveBeenCalled();
    expect((await world.sql`select spent::float8 from catalyst_kb.field_budgets`)[0]?.spent).toBe(
      0
    );
  });
  it("refuses an unpriced monthly field budget at publish while allowing startup and unbudgeted definitions", async () => {
    const assertBudgetPriced = vi.fn(() => {
      throw new Error(
        "Model binding 'approved-extraction' has no usage.costs.customer.models rate-card row"
      );
    });
    const world = await setup(undefined, undefined, false, undefined, {
      currency: "EUR",
      reserveCost: () => 0,
      extract: vi.fn<KnowledgeFieldExtractor["extract"]>(),
      assertBudgetPriced
    });
    expect(assertBudgetPriced).not.toHaveBeenCalled();
    await expect(
      world.publishSources(sources, {
        extraction: { budget: { perMonth: 1, maxTokensPerDocument: 8000 } }
      })
    ).rejects.toThrow(
      "Model binding 'approved-extraction' has no usage.costs.customer.models rate-card row"
    );
    expect(assertBudgetPriced).toHaveBeenCalledOnce();
  });
});
