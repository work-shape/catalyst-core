import { describe, expect, it, vi } from "vitest";
import {
  createActorAccess,
  createPlatformId,
  StoreBackedAuditRecorder,
  type AuthenticatedUser,
  type OperationOrigin
} from "@work-shape/catalyst-core";
import { clientInstanceId } from "./support/data-store-instance";
import { useKnowledgeSync } from "./support/knowledge-sync";
import { deferred, required } from "./support/assertions";

const KB = "sync-test";
const SOURCE = "source";

describe("held withdrawal confirmations", () => {
  const { setup } = useKnowledgeSync();
  async function held() {
    const world = await setup();
    const item = world.world.put({
      folderId: "folder",
      name: "held.txt",
      mime: "text/plain",
      bytes: new TextEncoder().encode("held")
    });
    await world.drain(await world.sync());
    world.world.remove(item);
    const start = await world.instance.api.call("knowledge_bases.sync", {
      params: { knowledgeBase: KB },
      payload: { source: SOURCE, mode: "full" }
    });
    expect(start.statusCode, start.body).toBe(202);
    await world.worker.runDue();
    const [run] =
      await world.sql`select id,operation_run_id,approval_request_id from catalyst_kb.sync_runs where state='running'`;
    return { ...world, held: required(run) };
  }
  async function call(
    world: Awaited<ReturnType<typeof held>>,
    mode: "full" | "changes",
    origin: OperationOrigin
  ) {
    const operation = required(
      await world.knowledge.operationSource(world.files).resolve(`knowledge.${KB}.sync`)
    );
    const actor: AuthenticatedUser = {
      id: "publisher",
      externalUserId: "publisher",
      displayLabel: "Publisher",
      roles: ["superadmin"],
      permissionRefs: [],
      clientInstanceId,
      authSource: "test"
    };
    const joinAsyncRun = vi.fn();
    await operation.execute(
      { source: SOURCE, mode },
      {
        actor,
        origin,
        runId: createPlatformId<"OperationRunId">("oprun"),
        correlationId: "probe",
        runtime: {},
        joinAsyncRun,
        access: createActorAccess(
          {
            clientInstanceId,
            kind: "user",
            id: actor.id,
            roles: ["superadmin"],
            permissionRefs: []
          },
          { holderActive: true, grants: [] }
        ),
        audit: new StoreBackedAuditRecorder({
          clientInstanceId,
          store: world.instance.stores.audit
        })
      }
    );
    expect(joinAsyncRun).toHaveBeenCalledWith(world.held.operation_run_id);
    expect(await world.sql`select id from catalyst_kb.sync_runs where state='running'`).toEqual([
      { id: world.held.id }
    ]);
  }

  it("an approved confirmation is never replaced and its held pass is joined", async () => {
    const world = await held();
    const decision = await world.instance.api.call("approval_requests.decide", {
      params: { requestId: String(world.held.approval_request_id) },
      payload: { decision: "approve" }
    });
    expect(decision.statusCode, decision.body).toBe(200);
    await call(world, "full", { kind: "user" });
    expect(
      await world.instance.stores.approvals.getApprovalRequest({
        clientInstanceId,
        requestId: String(world.held.approval_request_id)
      })
    ).toMatchObject({ status: "approved" });
    await world.drain(String(world.held.id));
    expect(await world.sql`select state from catalyst_kb.source_items`).toEqual([
      { state: "withdrawn" }
    ]);
  });

  it.each([
    { mode: "changes" as const, origin: { kind: "user" } as const },
    {
      mode: "full" as const,
      origin: { kind: "workflow", workflowRunId: "workflow", stepRunId: "step" } as const
    }
  ])(
    "$mode from $origin.kind joins the pending held pass on repeated starts",
    async ({ mode, origin }) => {
      const world = await held();
      await call(world, mode, origin);
      await call(world, mode, origin);
      expect(
        await world.instance.stores.approvals.getApprovalRequest({
          clientInstanceId,
          requestId: String(world.held.approval_request_id)
        })
      ).toMatchObject({ status: "pending" });
    }
  );

  it("answers 409 when a person is deciding the confirmation during a full sync", async () => {
    const world = await held();
    const ready = deferred<void>();
    const release = deferred<void>();
    const deciding = world.instance.stores.approvals.transitionPendingApprovalRequest({
      clientInstanceId,
      requestId: String(world.held.approval_request_id),
      resolve: async () => {
        ready.resolve();
        await release.promise;
        return { status: "approved" };
      }
    });
    try {
      await ready.promise;
      const sync = await world.instance.api.call("knowledge_bases.sync", {
        params: { knowledgeBase: KB },
        payload: { source: SOURCE, mode: "full" }
      });
      expect(sync.statusCode, sync.body).toBe(409);
      expect(sync.json()).toMatchObject({ error: { code: "CONFLICT" } });
    } finally {
      release.resolve();
      await deciding;
    }
    expect(await world.sql`select id from catalyst_kb.sync_runs where state='running'`).toEqual([
      { id: world.held.id }
    ]);
  });
});
