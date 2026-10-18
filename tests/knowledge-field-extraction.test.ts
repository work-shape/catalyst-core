import { describe, expect, it, vi } from "vitest";
import { type KnowledgeFieldExtractor } from "@work-shape/catalyst-core";
import { required } from "./support/assertions";
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
  it("check 83: drops and counts ungrounded evidence, pauses only fields at the KB budget, and resumes after a raise without retaining payloads", async () => {
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
      droppedFields: 2,
      fields: {
        price: { value: 12500, page: 1, quote: "Kaufpreis 12.500 EUR" },
        area: { value: 120.5, page: 1, quote: "Wohnfläche 120,5 m²" }
      }
    });
    expect(result.json().fields).not.toHaveProperty("invented");
    expect(result.json().fields).not.toHaveProperty("wrongPage");
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
    for (const secret of [marker, "12.500 EUR", "120,5 m²", "12500"])
      expect(retained).not.toContain(secret);
    const [budget] = await world.sql`select spent::float8 as spent from catalyst_kb.field_budgets`;
    expect(required(budget).spent).toBe(2.25);
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
});
