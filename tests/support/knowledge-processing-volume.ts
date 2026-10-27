import type { AsyncLocalStorage } from "node:async_hooks";
import { expect, it } from "vitest";
import { clientInstanceId } from "./data-store-instance";
import { required } from "./assertions";
import { useKnowledgeSync } from "./knowledge-sync";
const params = { kind: "knowledge_base", name: "sync-test" };

/** Query count and confirmation invalidation stay identical at both volumes. */
export function registerKnowledgeProcessingVolumeTest(
  counted: AsyncLocalStorage<string[]>,
  volume: number
) {
  const { setup } = useKnowledgeSync();
  it(`keeps asset GET independent of ${volume} added contents and aggregates a changed draft in one statement`, async () => {
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
      from generate_series(1,${volume}) n cross join (select * from catalyst_kb.contents limit 1) c`;
    await world.sql`insert into catalyst_kb.documents (id,managed_file_id,content_sha256,title,file_name)
      select 'scale-'||n,'scale-file-'||n,lpad(to_hex(n),64,'0'),'Scale','report-'||n||'.md' from generate_series(1,${volume}) n`;
    await world.sql`insert into catalyst_kb.chunks (id,content_sha256,chunking_revision,position,text,token_count)
      select 'scale-chunk-'||n,lpad(to_hex(n),64,'0'),1,0,'Text',1 from generate_series(1,${volume}) n`;
    const large = await read();
    console.info(
      "PROC-1b asset GET timings",
      JSON.stringify({
        small: { contents: 1, ms: small.ms, queries: small.statements.length },
        large: { contents: volume + 1, ms: large.ms, queries: large.statements.length }
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
      JSON.stringify({ contents: volume + 1, ms: changed.ms, queries: changed.statements.length })
    );
    // Exactly one classification/count query, no metadata pages or original-file lookups.
    expect(changed.statements.filter((s) => s.includes("catalyst_kb.contents"))).toHaveLength(1);
    const lines = await world.knowledge.publishQuestion({
      assetId: asset.id,
      scope: asset.scope,
      config
    });
    expect(lines.join("\n")).toContain(
      `${(volume + 1).toLocaleString("en-US")} documents are read again`
    );
    // Counts and identities are checked again at publish; a changed set invalidates confirmation.
    const confirmation = required(lines.join("\n").match(/confirmProcessing: '([a-f0-9]+)'/u)?.[1]);
    await world.sql`update catalyst_kb.documents set withdrawn_at=now() where id='scale-1'`;
    const fresh = await world.knowledge.publishQuestion({
      assetId: asset.id,
      scope: asset.scope,
      config
    });
    expect(fresh.join("\n")).toContain(
      `${volume.toLocaleString("en-US")} documents are read again`
    );
    expect(fresh.join("\n")).not.toContain(confirmation);
  });
}
