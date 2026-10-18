import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError, createActorAccess, enqueueKnowledgeIndex } from "@work-shape/catalyst-core";
import { eventually, required } from "./support/assertions";
import { clientInstanceId } from "./support/data-store-instance";
import { useKnowledgeSync } from "./support/knowledge-sync";
const params = { kind: "knowledge_base", name: "sync-test" };

describe("confirmed, selective processing at publish (KB 80)", () => {
  const { setup } = useKnowledgeSync();
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
      await world.sql`select content_sha256,id,text from catalyst_kb.chunks order by id`;
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
      await world.sql`select content_sha256,id,text from catalyst_kb.chunks order by id`
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
      await world.sql`select ch.content_sha256,ch.id,ch.text from catalyst_kb.chunks ch join catalyst_kb.documents d on d.content_sha256=ch.content_sha256 where d.file_name='other.md' order by ch.id`;
    expect(untouched).toEqual(
      before.filter((row) => untouched.some((each) => each.content_sha256 === row.content_sha256))
    );
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
      await world.sql`select ch.content_sha256,ch.id,ch.text from catalyst_kb.chunks ch join catalyst_kb.documents d on d.content_sha256=ch.content_sha256 where d.file_name='other.md' order by ch.id`
    ).toEqual(untouched);
  });
});
