import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import { clientInstanceId } from "./support/data-store-instance";
import {
  knowledgeDocumentTypesSchema,
  knowledgeProcessingOf
} from "@work-shape/catalyst-data-stores";
import { required } from "./support/assertions";
import { useKnowledgeSync } from "./support/knowledge-sync";

const counted = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return new AsyncLocalStorage<string[]>();
});
vi.mock("postgres", async (importOriginal) => {
  type Options = postgres.Options<Record<string, never>>;
  type Connect = (url: string | Options, options?: Options) => postgres.Sql;
  const actual = await importOriginal<{ default: Connect }>();
  const connect: Connect = (url, options) => {
    const debug = (_connection: number, statement: string) => {
      counted.getStore()?.push(statement);
    };
    return typeof url === "string"
      ? actual.default(url, { ...options, debug })
      : actual.default({ ...url, debug });
  };
  return { ...actual, default: Object.assign(connect, actual.default) };
});

const params = { kind: "knowledge_base", name: "sync-test" };
describe("Knowledge Base processing review at scale", () => {
  const { setup } = useKnowledgeSync();
  it("uses the same first-match glob rules in SQL and ingestion, including Unicode and hostile names", async () => {
    const world = await setup();
    world.world.put({
      folderId: "folder",
      name: "base.md",
      mime: "text/markdown",
      bytes: new TextEncoder().encode("Base")
    });
    await world.drain(await world.sync());
    const names = [
      "report-a.md",
      "report-b.pdf",
      ".hidden.md",
      "a\nb.md",
      "a.md\n",
      "a.md\r",
      "a.md\u2028",
      "a.md\u2029",
      "contracts/a\nb.md",
      "contracts/a.md\n",
      "a,b.md",
      "a-b.md",
      "a#b.md",
      String.raw`\x41.md`,
      String.raw`\p{L}.md`,
      "ä.md",
      "😀.md",
      "file' or true --.md",
      "contracts/a.md",
      "/contracts/a.md"
    ];
    for (const [index, name] of names.entries()) {
      const sha = (index + 1).toString(16).padStart(64, "0");
      await world.sql`insert into catalyst_kb.contents (sha256,format,state) values (${sha},'markdown','pending')`;
      await world.sql`insert into catalyst_kb.documents (id,managed_file_id,content_sha256,title,file_name) values (${sha},${sha},${sha},'Example',${name})`;
    }
    const asset = required(
      await world.instance.stores.configAssets.getConfigAsset({ clientInstanceId, ...params })
    );
    for (const pattern of [
      String.raw`\\x41.md`,
      String.raw`\\p{L}.md`,
      "report*",
      "**/*.md",
      "*.{md,pdf}",
      "!(report-a).md",
      "[[:alpha:]].md",
      "[[:ascii:]]*.md",
      "?.md",
      "??.md",
      "a-b.md",
      "a,b.md",
      "a#b.md",
      "**/contracts/**",
      "file' or true --.md"
    ]) {
      const documentTypes = knowledgeDocumentTypesSchema.parse([
        { id: "selected", match: { name: [pattern] }, chunking: "whole" }
      ]);
      const expected = ["base.md", ...names].filter(
        (name) =>
          knowledgeProcessingOf(documentTypes, {
            path: name,
            name,
            mime: "text/markdown",
            format: "markdown"
          }).type === "selected"
      ).length;
      const lines = await world.knowledge.publishQuestion({
        assetId: asset.id,
        scope: asset.scope,
        config: { ...asset.publishedConfig, methods: ["keyword"], documentTypes }
      });
      const count = Number(lines.join("\n").match(/Reprocess (\d+) affected/u)?.[1] ?? 0);
      expect(count, pattern).toBe(expected);
    }
    const documentTypes = knowledgeDocumentTypesSchema.parse([
      { id: "first", match: { name: ["report*"], mime: ["application/pdf"] }, chunking: "whole" },
      {
        id: "second",
        match: { path: ["**/contracts/**"], mime: ["text/markdown"] },
        chunking: "whole"
      }
    ]);
    const lines = await world.knowledge.publishQuestion({
      assetId: asset.id,
      scope: asset.scope,
      config: { ...asset.publishedConfig, methods: ["keyword"], documentTypes }
    });
    expect(lines.join("\n")).toContain("Reprocess 2 affected contents");
  });
  it("keeps asset GET independent of content count and aggregates a changed draft in one statement", async () => {
    const world = await setup();
    world.world.put({
      folderId: "folder",
      name: "report.md",
      mime: "text/markdown",
      bytes: new TextEncoder().encode("# One\nText")
    });
    await world.drain(await world.sync());
    const read = async () => {
      const statements: string[] = [];
      const start = performance.now();
      const response = await counted.run(statements, () =>
        world.instance.api.call("assets.get", { params })
      );
      expect(response.statusCode, response.body).toBe(200);
      return {
        ms: performance.now() - start,
        statements: statements.filter((s) => !s.includes("pg_catalog.pg_type"))
      };
    };
    // Warm connections; the assertion counts queries rather than relying on wall-clock noise.
    await read();
    const small = await read();
    await world.sql`insert into catalyst_kb.contents (sha256,format,state,chunking_revision,processing_key,processor_revision)
      select lpad(to_hex(n),64,'0'),'markdown','extracted',c.chunking_revision,c.processing_key,c.processor_revision
      from generate_series(1,50000) n cross join (select * from catalyst_kb.contents limit 1) c`;
    await world.sql`insert into catalyst_kb.documents (id,managed_file_id,content_sha256,title,file_name)
      select 'scale-'||n,'scale-file-'||n,lpad(to_hex(n),64,'0'),'Scale','report-'||n||'.md' from generate_series(1,50000) n`;
    await world.sql`insert into catalyst_kb.chunks (id,content_sha256,chunking_revision,position,text,token_count)
      select 'scale-chunk-'||n,lpad(to_hex(n),64,'0'),1,0,'Text',1 from generate_series(1,50000) n`;
    const large = await read();
    console.info(
      "PROC-1b asset GET timings",
      JSON.stringify({
        small: { contents: 1, ms: small.ms, queries: small.statements.length },
        large: { contents: 50001, ms: large.ms, queries: large.statements.length }
      })
    );
    expect(large.statements.length).toBe(small.statements.length);
    const owned = large.statements.filter((s) => s.includes("catalyst_kb."));
    expect(owned).toHaveLength(1);
    expect(owned[0]).toContain("as outdated");
    expect(owned[0]).not.toContain("catalyst_kb.chunks");
    const asset = required(
      await world.instance.stores.configAssets.getConfigAsset({ clientInstanceId, ...params })
    );
    const config = {
      ...asset.publishedConfig,
      documentTypes: [{ id: "reports", match: { name: ["report*"] }, chunking: "whole" }]
    };
    expect(
      (
        await world.instance.api.call("assets.put", {
          params,
          payload: { config, expectedRevision: asset.revision }
        })
      ).statusCode
    ).toBe(200);
    const changed = await read();
    console.info(
      "PROC-1b changed draft timings",
      JSON.stringify({ contents: 50001, ms: changed.ms, queries: changed.statements.length })
    );
    // Exactly one classification/count query, no metadata pages or original-file lookups.
    expect(changed.statements.filter((s) => s.includes("catalyst_kb.contents"))).toHaveLength(1);
    const lines = await world.knowledge.publishQuestion({
      assetId: asset.id,
      scope: asset.scope,
      config
    });
    expect(lines.join("\n")).toContain("Reprocess 50001 affected contents");
    // Counts and identities are checked again at publish; a changed set invalidates confirmation.
    const confirmation = required(lines.join("\n").match(/confirmProcessing: '([a-f0-9]+)'/u)?.[1]);
    await world.sql`update catalyst_kb.documents set withdrawn_at=now() where id='scale-1'`;
    const fresh = await world.knowledge.publishQuestion({
      assetId: asset.id,
      scope: asset.scope,
      config
    });
    expect(fresh.join("\n")).toContain("Reprocess 50000 affected contents");
    expect(fresh.join("\n")).not.toContain(confirmation);
  });
});
