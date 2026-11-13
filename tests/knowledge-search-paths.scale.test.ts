import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { KNOWLEDGE_BASE_ASSET_KIND, type DataStoreRecord } from "@work-shape/catalyst-core";
import { eventually, required } from "./support/assertions";
import { clientInstanceId, useDataStoreInstance } from "./support/data-store-instance";
import { fileTestDatabaseUrl } from "./support/test-database";
import { getTestJobs } from "./support/test-instance";

// KB-PATH at volume: every path holds the same folder words, as a source of projects does
// ("Projekte", "Objekt"), and a question holds stop words. The words of the paths must not make
// a search read every passage: it takes about as long as the same search of a store that does
// not read paths, and still finds the passages of a folder the query names.

const KB = "akten";
const DOCUMENTS = 5000;
const CHUNKS_PER_DOCUMENT = 40;
const QUESTION = "Wann wurde die Heizung im Objekt 17 erneuert";

const passages = z.object({
  passages: z.array(z.object({ documentId: z.string(), text: z.string(), path: z.string() }))
});

describe("keyword search over the paths of a large store", () => {
  const { start } = useDataStoreInstance();

  async function inDatabase<T>(database: string | undefined, work: (sql: postgres.Sql) => Promise<T>) {
    const url = new URL(await fileTestDatabaseUrl());
    if (database) url.pathname = `/${database}`;
    const sql = postgres(url.toString(), { max: 1, onnotice: () => undefined });
    try {
      return await work(sql);
    } finally {
      await sql.end();
    }
  }

  async function seed(record: DataStoreRecord) {
    const content = "encode(sha256(('c' || i)::bytea), 'hex')";
    await inDatabase(record.location.database, (sql) =>
      sql.unsafe(`
        insert into catalyst_kb.contents (sha256, format, chunking_revision, state)
          select ${content}, 'pdf', 1, 'extracted' from generate_series(1, ${DOCUMENTS}) i;
        insert into catalyst_kb.source_items
            (id, source_id, item_id, version, path, name, mime, size, modified_at, state)
          select 'item-' || i, 'workflow:feed', 'it' || i, '1',
            '/Projekte/' || (array['Nord', 'Süd', 'Ost', 'West', 'Mitte'])[1 + i % 5] || '/Objekt '
              || (i % 500) || '/' || (array['Technik', 'Verträge', 'Pläne', 'Protokolle'])[1 + i % 4]
              || '/Datei_' || i || '.pdf',
            'Datei_' || i || '.pdf', 'application/pdf', 1000, now(), 'fetched'
          from generate_series(1, ${DOCUMENTS}) i;
        insert into catalyst_kb.documents
            (id, managed_file_id, content_sha256, title, file_name, source_item_id)
          select 'doc-' || i, 'file-' || i, ${content}, 'Dokument ' || i, 'Datei_' || i || '.pdf',
            'item-' || i
          from generate_series(1, ${DOCUMENTS}) i;
        -- About one passage in a hundred names the heating.
        insert into catalyst_kb.chunks
            (id, content_sha256, chunking_revision, position, page, text, token_count)
          select 'chunk-' || i || '-' || p, ${content}, 1, p, 1,
            (select string_agg('wort' || floor(random() * 50000)::int, ' ')
              from generate_series(1, 150) g where p >= 0 and i >= 0)
              || case when (i * 7 + p) % 97 = 0 then ' Heizung' else '' end, 200
          from generate_series(1, ${DOCUMENTS}) i, generate_series(0, ${CHUNKS_PER_DOCUMENT - 1}) p;
        analyze;
      `)
    );
  }

  it(
    "reads no more than a store without paths for a question whose words every path holds",
    { timeout: 900_000 },
    async () => {
      const world = await start(true, undefined, undefined, undefined, true);
      const put = await world.api.call("assets.put", {
        params: { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB },
        payload: {
          config: { name: KB, title: "Akten", description: "Project files.", methods: ["keyword"] },
          expectedRevision: null
        }
      });
      expect(put.statusCode, put.body).toBe(200);
      const published = await world.api.call("assets.publish", {
        params: { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB },
        payload: { revision: 1 }
      });
      expect(published.statusCode, published.body).toBe(200);
      const record = await eventually(async () => {
        await getTestJobs(world.api).runDue();
        const found = await world.stores.dataStores.findDataStoreByName({
          clientInstanceId,
          name: `knowledge-base:${KB}`
        });
        expect(found).toMatchObject({ status: "ready", level: 21 });
        return required(found);
      });
      await seed(record);

      const search = async (query: string) => {
        const began = performance.now();
        const answered = await world.api.call("knowledge_bases.search", {
          params: { knowledgeBase: KB },
          payload: { query }
        });
        expect(answered.statusCode, answered.body).toBe(200);
        return { ms: performance.now() - began, hits: passages.parse(answered.json()).passages };
      };
      /** The second of two runs, once the store's pages are read into memory. */
      const timed = async (query: string) => {
        await search(query);
        return search(query);
      };
      const atLevel = (level: number) =>
        inDatabase(undefined, (sql) => sql`update data_stores set level = ${level} where id = ${record.id}`);

      // The same store searched as one that does not read paths.
      await atLevel(20);
      const passagesOnly = await timed(QUESTION);
      await atLevel(21);
      const withPaths = await timed(QUESTION);
      expect(withPaths.hits.length).toBeGreaterThan(0);
      expect(withPaths.hits[0]?.text).toContain("Heizung");
      expect(withPaths.ms).toBeLessThan(passagesOnly.ms * 1.5 + 500);

      // A folder's name still finds its files.
      const technik = await timed("Heizung Technik");
      expect(technik.hits.length).toBeGreaterThan(0);
      for (const hit of technik.hits) expect(hit.path).toContain("/Technik/");
      expect(technik.ms).toBeLessThan(passagesOnly.ms * 1.5 + 500);
    }
  );
});
