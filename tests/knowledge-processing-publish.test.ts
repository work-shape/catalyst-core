import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError, createActorAccess, enqueueKnowledgeIndex } from "@work-shape/catalyst-core";
import { eventually, required } from "./support/assertions";
import { clientInstanceId } from "./support/data-store-instance";
import { useKnowledgeSync } from "./support/knowledge-sync";
const params = { kind: "knowledge_base", name: "sync-test" };

function publisherAccess() {
  return createActorAccess(
    {
      clientInstanceId,
      kind: "user",
      id: "publisher",
      roles: ["superadmin"],
      permissionRefs: []
    },
    { holderActive: true, grants: [] }
  );
}

describe("confirmed, selective processing at publish (KB 80)", () => {
  const { setup } = useKnowledgeSync();
  it.each(["legacy missing key", "matching key"])(
    "reviews a released processor revision on GET and refuses unrelated publish: %s",
    async (storedKey) => {
      const world = await setup();
      world.world.put({
        folderId: "folder",
        name: "report.md",
        mime: "text/markdown",
        bytes: new TextEncoder().encode("Revision-only change")
      });
      await world.drain(await world.sync());
      if (storedKey === "legacy missing key")
        await world.sql`update catalyst_kb.contents set processing_key=null,processor_revision='text@0'`;
      else await world.sql`update catalyst_kb.contents set processor_revision='text@0'`;
      const asset = required(
        await world.instance.stores.configAssets.getConfigAsset({ clientInstanceId, ...params })
      );
      const put = await world.instance.api.call("assets.put", {
        params,
        payload: {
          config: { ...asset.publishedConfig, title: "Unrelated title" },
          expectedRevision: asset.revision
        }
      });
      expect(put.statusCode, put.body).toBe(200);
      const revision = z.object({ revision: z.number() }).parse(put.json()).revision;
      const publish = await world.instance.api.call("assets.publish", {
        params,
        payload: { revision }
      });
      expect(publish.statusCode, publish.body).toBe(422);
      expect(publish.body).toContain("knowledge_processing_confirmation_required");
      const get = await world.instance.api.call("assets.get", { params });
      expect(get.statusCode, get.body).toBe(200);
      expect(get.body).toContain("Reprocess 1 affected contents");
    }
  );
  it("reads a Knowledge Base whose store is ready before its tables are made (KB-PAGE-1)", async () => {
    const world = await setup();
    // Right after the first publish: the store's record is ready, its tables are not made yet.
    await world.sql`drop schema catalyst_kb cascade`;
    await world.platform`update data_stores set migrations='[]'::jsonb where id=${world.record.id}`;
    const get = await world.instance.api.call("assets.get", { params });
    expect(get.statusCode, get.body).toBe(200);
  });
  it("estimates only active passages of affected contents", async () => {
    const world = await setup();
    for (const name of ["target.md", "other.md"])
      world.world.put({
        folderId: "folder",
        name,
        mime: "text/markdown",
        bytes: new TextEncoder().encode(name)
      });
    await world.drain(await world.sync());
    await world.sql`update catalyst_kb.chunks ch set token_count=1000000
      from catalyst_kb.documents d where d.content_sha256=ch.content_sha256 and d.file_name='target.md'`;
    await world.sql`insert into catalyst_kb.chunks (id,content_sha256,chunking_revision,position,text,token_count)
      select 'retired-chunk',content_sha256,999,0,'Retired',50000000
      from catalyst_kb.documents where file_name='target.md'`;
    await world.sql`update catalyst_kb.contents c set processor_revision='text@0'
      from catalyst_kb.documents d where d.content_sha256=c.sha256 and d.file_name='target.md'`;
    const asset = required(
      await world.instance.stores.configAssets.getConfigAsset({ clientInstanceId, ...params })
    );
    const lines = await world.knowledge.publishQuestion({
      assetId: asset.id,
      scope: asset.scope,
      config: asset.publishedConfig
    });
    expect(lines.join("\n")).toContain("Reprocess 1 affected contents");
    expect(lines.join("\n")).toContain("0.500000–2.000000 USD");
  });
  it("can confirm a failed upload with no passage or source-size estimate", async () => {
    const world = await setup();
    world.world.put({
      folderId: "folder",
      name: "report.md",
      mime: "text/markdown",
      bytes: new TextEncoder().encode("Report")
    });
    await world.drain(await world.sync());
    // Uploads have no source size. A prior failed index may have removed its chunks, so
    // waiting for indexing before confirmation would deadlock a processor-version change.
    await world.sql`update catalyst_kb.documents set source_item_id=null`;
    await world.sql`delete from catalyst_kb.chunks`;
    await world.sql`update catalyst_kb.contents set state='failed',processing_key='old-release',processor_revision='text@0'`;
    const asset = required(
      await world.instance.stores.configAssets.getConfigAsset({ clientInstanceId, ...params })
    );
    const config = {
      ...asset.publishedConfig,
      documentTypes: [{ id: "reports", match: { name: ["report*"] }, chunking: "whole" }]
    };
    const put = await world.instance.api.call("assets.put", {
      params,
      payload: { config, expectedRevision: asset.revision }
    });
    expect(put.statusCode, put.body).toBe(200);
    const revision = z.object({ revision: z.number() }).parse(put.json()).revision;
    const lines = await world.knowledge.publishQuestion({
      assetId: asset.id,
      scope: asset.scope,
      config
    });
    expect(lines.join("\n")).toContain("1 contents without size estimates");
    expect(lines.join("\n")).toContain("file limit conservatively");
    expect(lines.join("\n")).toMatch(/0\.000000–[1-9]\d*\.\d{6} USD/u);
    const confirmation = required(lines.join("\n").match(/confirmProcessing: '([a-f0-9]+)'/u)?.[1]);
    const publish = () =>
      world.instance.stores.transaction((stores) =>
        world.knowledge.publish(stores, {
          access: publisherAccess(),
          assetId: asset.id,
          revision,
          config,
          replaced: asset.publishedConfig,
          confirmProcessing: confirmation
        })
      );
    await publish();
    // A newly building generation changes the embedding cost without changing content.
    // A confirmation must cover the current rate/binding selection too.
    await world.sql`insert into catalyst_kb.index_generations (generation,binding_id,model,dimensions,state) values (2,'embedding','local',8,'building')`;
    await expect(publish()).rejects.toMatchObject({
      details: { reason: "knowledge_processing_confirmation_required" }
    });
  });
  it("states count and cost, refuses an absent/stale confirmation, and re-chunks only the changed type", async () => {
    const world = await setup();
    for (const name of ["report-a.md", "report-b.md", "other.md"])
      world.world.put({
        folderId: "folder",
        name,
        mime: "text/markdown",
        bytes: new TextEncoder().encode(`# First\n${name}\n# Second\nMore text`)
      });
    await world.drain(await world.sync());
    const asset = required(
      await world.instance.stores.configAssets.getConfigAsset({ clientInstanceId, ...params })
    );
    const config = {
      ...asset.publishedConfig,
      methods: ["keyword"],
      documentTypes: [
        { id: "reports", match: { name: ["report*"] }, processor: "tables", chunking: "whole" }
      ]
    };
    const put = await world.instance.api.call("assets.put", {
      params,
      payload: { config, expectedRevision: asset.revision }
    });
    expect(put.statusCode, put.body).toBe(200);
    const revision = z.object({ revision: z.number() }).parse(put.json()).revision;
    // The fixture connector uses the domain publish hook, as support/knowledge-sync does.
    // It is deliberately not registered as a release connector in the HTTP instance.
    const publish = async (confirmProcessing?: string) => {
      const current = required(
        await world.instance.stores.configAssets.getConfigAsset({ clientInstanceId, ...params })
      );
      const stored = required(
        await world.instance.stores.configAssets.getConfigAssetRevision({
          clientInstanceId,
          ...params,
          revision
        })
      );
      const access = publisherAccess();
      return world.instance.stores.transaction(async (stores) => {
        await world.knowledge.publish(stores, {
          access,
          assetId: current.id,
          revision,
          config,
          replaced: current.publishedConfig,
          ...(confirmProcessing ? { confirmProcessing } : {})
        });
        await stores.configAssets.publishConfigAssetRevision({
          clientInstanceId,
          ...params,
          assetId: current.id,
          revision,
          revisionId: stored.id
        });
      });
    };
    const before =
      await world.sql`select ch.content_sha256,ch.id,ch.text,ch.xmin::text as xmin,c.xmin::text as content_xmin from catalyst_kb.chunks ch join catalyst_kb.contents c on c.sha256=ch.content_sha256 order by ch.id`;
    const missing: unknown = await publish().catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(AppError);
    const refusal = z
      .object({
        message: z.string(),
        details: z.object({ count: z.number(), confirmation: z.string() })
      })
      .parse(missing);
    expect(refusal.details.count).toBe(2);
    expect(refusal.message).toContain("0 (keyword only)");
    expect(
      await world.sql`select ch.content_sha256,ch.id,ch.text,ch.xmin::text as xmin,c.xmin::text as content_xmin from catalyst_kb.chunks ch join catalyst_kb.contents c on c.sha256=ch.content_sha256 order by ch.id`
    ).toEqual(before);
    await expect(publish("0".repeat(64))).rejects.toMatchObject({
      details: { reason: "knowledge_processing_confirmation_required" }
    });
    await publish(refusal.details.confirmation);
    await eventually(async () => {
      await world.worker.runDue();
      const counts =
        await world.sql`select d.file_name,count(ch.id)::int as chunks,c.document_type,c.processor_revision from catalyst_kb.documents d join catalyst_kb.contents c on c.sha256=d.content_sha256 join catalyst_kb.chunks ch on ch.content_sha256=c.sha256 group by d.file_name,c.document_type,c.processor_revision order by d.file_name`;
      expect(counts).toEqual([
        {
          file_name: "other.md",
          chunks: 2,
          document_type: "default",
          processor_revision: "text@1"
        },
        {
          file_name: "report-a.md",
          chunks: 1,
          document_type: "reports",
          processor_revision: "tables@1"
        },
        {
          file_name: "report-b.md",
          chunks: 1,
          document_type: "reports",
          processor_revision: "tables@1"
        }
      ]);
    });
    const untouched =
      await world.sql`select ch.content_sha256,ch.id,ch.text,ch.xmin::text as xmin,c.xmin::text as content_xmin from catalyst_kb.chunks ch join catalyst_kb.contents c on c.sha256=ch.content_sha256 join catalyst_kb.documents d on d.content_sha256=ch.content_sha256 where d.file_name='other.md' order by ch.id`;
    expect(untouched).toEqual(
      before.filter((row) => untouched.some((each) => each.content_sha256 === row.content_sha256))
    );
    // Exercise the index skip independently of reconciliation: deterministic text is not row identity.
    const [other] =
      await world.sql`select c.sha256,d.managed_file_id from catalyst_kb.contents c join catalyst_kb.documents d on d.content_sha256=c.sha256 where d.file_name='other.md'`;
    await enqueueKnowledgeIndex(
      world.instance.stores.jobs,
      {
        knowledgeBaseId: world.record.id,
        contentSha256: String(required(other).sha256),
        fileId: String(required(other).managed_file_id),
        operationRunId: "redundant-index"
      },
      { clientInstanceId }
    );
    await world.worker.runDue();
    expect(
      await world.sql`select ch.content_sha256,ch.id,ch.text,ch.xmin::text as xmin,c.xmin::text as content_xmin from catalyst_kb.chunks ch join catalyst_kb.contents c on c.sha256=ch.content_sha256 join catalyst_kb.documents d on d.content_sha256=ch.content_sha256 where d.file_name='other.md' order by ch.id`
    ).toEqual(untouched);
    // A processor revision changed in a release; identical config still selects only its types.
    await world.sql`update catalyst_kb.contents set processing_key='previous-release',processor_revision='tables@0' where document_type='reports'`;
    const reports =
      await world.sql`select c.sha256,d.managed_file_id from catalyst_kb.contents c join catalyst_kb.documents d on d.content_sha256=c.sha256 where c.document_type='reports'`;
    for (const report of reports)
      await enqueueKnowledgeIndex(
        world.instance.stores.jobs,
        {
          knowledgeBaseId: world.record.id,
          contentSha256: String(report.sha256),
          fileId: String(report.managed_file_id),
          operationRunId: "queued-before-confirmation"
        },
        { clientInstanceId }
      );
    await world.worker.runDue();
    expect(
      await world.sql`select count(*)::int as n from catalyst_kb.contents where document_type='reports' and processing_key='previous-release' and requested_processing_key is null`
    ).toEqual([{ n: 2 }]);
    const versionChange: unknown = await publish().catch((error: unknown) => error);
    expect(versionChange).toBeInstanceOf(AppError);
    const versionReview = z
      .object({ details: z.object({ count: z.number(), confirmation: z.string() }) })
      .parse(versionChange);
    expect(versionReview.details.count).toBe(2);
    await publish(versionReview.details.confirmation);
    await eventually(async () => {
      await world.worker.runDue();
      expect(
        await world.sql`select count(*)::int as n from catalyst_kb.contents where document_type='reports' and processor_revision='tables@1' and processing_key<>'previous-release'`
      ).toEqual([{ n: 2 }]);
    });
    expect(
      await world.sql`select ch.content_sha256,ch.id,ch.text,ch.xmin::text as xmin,c.xmin::text as content_xmin from catalyst_kb.chunks ch join catalyst_kb.contents c on c.sha256=ch.content_sha256 join catalyst_kb.documents d on d.content_sha256=ch.content_sha256 where d.file_name='other.md' order by ch.id`
    ).toEqual(untouched);
  });
});
