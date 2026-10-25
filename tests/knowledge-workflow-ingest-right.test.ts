import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  asConversationId,
  asUserId,
  KNOWLEDGE_BASE_ACTIONS,
  LEGACY_LIST_GRANTOR
} from "@work-shape/catalyst-core";
import { clientInstanceId } from "./support/data-store-instance";
import { eventually, required } from "./support/assertions";
import { asMember, developmentAuth } from "./support/knowledge-files";
import { item, KB, useKnowledgeWorkflow } from "./support/knowledge-workflow";
import { getTestJobs } from "./support/test-instance";

// KBW-3, check 113: a person who holds `knowledge_base.ingest` on a Knowledge Base, and no
// `knowledge_base.write`, adds an `ingest` step to a data Workflow and publishes it. LIVE-1
// gives the Workflow's own account exactly that right, through the product and no grant row
// written by hand, and the Workflow feeds the Knowledge Base.

const FEED = "feed-documents";
const FEED_SOURCE = `workflow:${FEED}@1`;
const address = { kind: "workflow", name: FEED };

const runSchema = z.object({ id: z.string(), status: z.string() });

/** A data Workflow that puts `items` into the Knowledge Base, or runs `operation` instead. */
function feed(items: unknown[], operation = `knowledge.${KB}.ingest`) {
  return {
    id: FEED,
    name: "Feed documents",
    kind: "data",
    inputs: { type: "object" },
    outputs: { type: "object" },
    steps: [
      { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
      ...(operation === ""
        ? []
        : [
            {
              id: "ingest",
              name: "Ingest",
              type: "operation",
              operation,
              input: operation.endsWith(".remove_documents")
                ? { documentIds: { value: ["doc"] } }
                : { items: { value: items } }
            }
          ]),
      { id: "result", name: "Result", type: "output", input: {} }
    ]
  };
}

describe(
  "the right a Workflow's account needs to feed a Knowledge Base (KBW-3)",
  { timeout: 600_000 },
  () => {
    const { world } = useKnowledgeWorkflow();

    async function setup() {
      const w = await world(developmentAuth, true);
      // The member's id, as the first request of the signed-in member creates it.
      const conversation = await w.instance.api.call("conversations.create", {
        payload: { title: "Member" },
        headers: asMember
      });
      expect(conversation.statusCode, conversation.body).toBe(200);
      const member = required(
        await w.instance.stores.conversations.getConversation(
          clientInstanceId,
          asConversationId(z.object({ id: z.string() }).parse(conversation.json()).id)
        )
      ).createdByUserId;
      const grant = (
        action: string,
        scope: { scopeKind: "instance" } | { scopeKind: "asset"; scopeId: string },
        effect: "allow" | "deny" = "allow"
      ) =>
        w.instance.stores.access.createGrant({
          clientInstanceId,
          holderKind: "user",
          holderId: member,
          action,
          effect,
          ...scope,
          grantedBy: asUserId(LEGACY_LIST_GRANTOR)
        });
      // A builder of Workflows who may see the Knowledge Base.
      for (const action of ["workflow.read", "workflow.write", "workflow.publish", "workflow.use"])
        await grant(action, { scopeKind: "instance" });
      await grant(KNOWLEDGE_BASE_ACTIONS.read, { scopeKind: "asset", scopeId: w.kb.id });
      const onKb = { scopeKind: "asset" as const, scopeId: w.kb.id };

      async function save(
        manifest: ReturnType<typeof feed>,
        expectedRevision: number | null = null
      ) {
        const saved = await w.instance.api.call("assets.put", {
          params: address,
          payload: { config: { name: FEED, manifest }, expectedRevision },
          headers: asMember
        });
        expect(saved.statusCode, saved.body).toBe(200);
      }
      const publish = (revision: number) =>
        w.instance.api.call("assets.publish", {
          params: address,
          payload: { revision },
          headers: asMember
        });
      /** Publishes as the member; the live publish waits for an approver, who approves it. */
      async function publishLive(revision: number) {
        const asked = await publish(revision);
        expect(asked.statusCode, asked.body).toBe(202);
        const { approvalRequestId } = z
          .object({ approvalRequestId: z.string() })
          .parse(asked.json());
        const decided = await w.instance.api.call("approval_requests.decide", {
          params: { requestId: approvalRequestId },
          payload: { decision: "approve" }
        });
        expect(decided.statusCode, decided.body).toBe(200);
        await eventually(async () => {
          await getTestJobs(w.instance.api).runDue();
          const asset = await w.instance.stores.configAssets.getConfigAsset({
            clientInstanceId,
            ...address
          });
          expect(asset?.publishedRevision).toBe(revision);
        }, 60_000);
      }
      async function account() {
        const asset = required(
          await w.instance.stores.configAssets.getConfigAsset({ clientInstanceId, ...address })
        );
        return w.instance.stores.apiAccess.findServicePrincipalByOwner({
          clientInstanceId,
          owner: { kind: "workflow", assetId: asset.id }
        });
      }
      async function accountGrants() {
        const principal = required(await account());
        return w.instance.stores.access.listGrants({
          clientInstanceId,
          holderKind: "service_principal",
          holderId: principal.id
        });
      }
      /** Starts the Workflow as the member and runs every job until the run has ended. */
      async function run() {
        const started = await w.instance.api.call("workflows.start", {
          params: { workflow: FEED },
          payload: { input: {} },
          headers: asMember
        });
        expect(started.statusCode, started.body).toBe(200);
        const { id } = runSchema.parse(started.json());
        return eventually(async () => {
          await w.platform`update platform_jobs set run_after = now() where status = 'queued' and kind like 'knowledge_base.%'`;
          await w.worker.runDue();
          await getTestJobs(w.instance.api).runDue();
          const read = await w.instance.api.call("workflows.get_run", { params: { runId: id } });
          const ended = runSchema.parse(read.json());
          expect(["queued", "running", "waiting"]).not.toContain(ended.status);
          return ended;
        }, 180_000);
      }
      const states = async () =>
        Object.fromEntries(
          (
            await w.sql`select state, count(*)::int as n from catalyst_kb.source_items where source_id=${FEED_SOURCE} group by state order by state`
          ).map((row) => [String(row.state), Number(row.n)])
        );
      return { w, grant, onKb, save, publish, publishLive, account, accountGrants, run, states };
    }

    it("lets a holder of ingest publish a Workflow that feeds the Knowledge Base, and nothing more (check 113)", async () => {
      const s = await setup();
      const { w } = s;
      await s.grant(KNOWLEDGE_BASE_ACTIONS.ingest, s.onKb);
      await s.save(feed([item(0), item(1), item(2)]));

      // The publish question names the account and what it may do, by the Knowledge Base's title.
      const draft = await w.instance.api.call("assets.get", {
        params: address,
        headers: asMember
      });
      expect(draft.statusCode, draft.body).toBe(200);
      expect(draft.json()).toMatchObject({
        publishQuestion: [
          "Läuft unter einem eigenen Konto „Feed documents“ und darf Dokumente in Source einspielen."
        ]
      });

      await s.publishLive(1);
      // Exactly `knowledge_base.ingest` on this Knowledge Base, from the step alone.
      expect(await s.accountGrants()).toEqual([
        expect.objectContaining({
          action: "knowledge_base.ingest",
          effect: "allow",
          scopeKind: "asset",
          scopeId: w.kb.id
        })
      ]);

      // The Knowledge Base names the Workflow among what fills it.
      const kb = await w.instance.api.call("knowledge_bases.get", {
        params: { knowledgeBase: KB },
        headers: asMember
      });
      expect(kb.statusCode, kb.body).toBe(200);
      expect(kb.json()).toMatchObject({
        dataFlows: { fills: [expect.objectContaining({ name: FEED, title: "Feed documents" })] }
      });

      // The Workflow feeds it.
      expect((await s.run()).status).toBe("done");
      expect(await s.states()).toEqual({ fetched: 3 });

      // `ingest` is not `write`: the member removes no document by hand.
      const [row] =
        await w.sql`select d.id from catalyst_kb.documents d join catalyst_kb.source_items i on i.id=d.source_item_id where i.source_id=${FEED_SOURCE} and i.item_id=${item(1).itemId}`;
      const documentId = String(required(row).id);
      const byMember = await w.instance.api.call("knowledge_bases.remove_documents", {
        params: { knowledgeBase: KB },
        payload: { documentIds: [documentId] },
        headers: asMember
      });
      expect(byMember.statusCode, byMember.body).toBe(403);

      // A person who may write removes it, and the Workflow's next run does not bring it back.
      const byAdmin = await w.instance.api.call("knowledge_bases.remove_documents", {
        params: { knowledgeBase: KB },
        payload: { documentIds: [documentId] }
      });
      expect(byAdmin.statusCode, byAdmin.body).toBe(200);
      expect((await s.run()).status).toBe("done");
      expect(await s.states()).toEqual({ fetched: 2, withdrawn: 1 });
      const [held] =
        await w.sql`select state from catalyst_kb.source_items where source_id=${FEED_SOURCE} and item_id=${item(1).itemId}`;
      expect(held?.state).toBe("withdrawn");

      // A revision without the step takes the grant away at its publish.
      await s.save(feed([], ""), 1);
      await s.publishLive(2);
      expect(await s.accountGrants()).toEqual([]);
    });

    it("refuses a publisher who may write the Knowledge Base but not feed it, naming the right", async () => {
      const s = await setup();
      await s.grant(KNOWLEDGE_BASE_ACTIONS.write, s.onKb);
      await s.save(feed([item(0)]));
      const refused = await s.publish(1);
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json()).toMatchObject({
        error: { details: { action: "knowledge_base.ingest" } }
      });
      expect(await s.account()).toBeUndefined();
    });

    it("lets a denial on the Knowledge Base win over ingest on all of them", async () => {
      const s = await setup();
      await s.grant(KNOWLEDGE_BASE_ACTIONS.ingest, { scopeKind: "instance" });
      await s.grant(KNOWLEDGE_BASE_ACTIONS.ingest, s.onKb, "deny");
      await s.save(feed([item(0)]));
      const refused = await s.publish(1);
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json()).toMatchObject({
        error: { details: { action: "knowledge_base.ingest" } }
      });
      expect(await s.account()).toBeUndefined();
    });

    it("refuses a Workflow whose step would need write, whatever the publisher holds", async () => {
      const s = await setup();
      await s.grant(KNOWLEDGE_BASE_ACTIONS.ingest, s.onKb);
      await s.grant(KNOWLEDGE_BASE_ACTIONS.write, s.onKb);
      await s.save(feed([], `knowledge.${KB}.remove_documents`));
      const refused = await s.publish(1);
      expect(refused.statusCode, refused.body).toBe(422);
      expect(refused.json()).toMatchObject({
        error: { details: { reason: "action_not_grantable_to_principal" } }
      });
      expect(await s.account()).toBeUndefined();
    });
  }
);
