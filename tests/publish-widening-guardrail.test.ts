import { beforeAllWithPostgres as beforeAll } from "./support/postgres-hooks";
import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  PUBLISH_APPROVAL_GUARDRAIL,
  PUBLISH_WIDENS_FIELD,
  asAgentRunId,
  asClientInstanceId,
  createPlatformId,
  type GuardrailStore,
  type JsonObject,
  type OperationOrigin
} from "@work-shape/catalyst-core";
import {
  GuardrailRunner,
  agentPublishWidens,
  appPublishReview,
  type PublishReach,
  type WorkflowAssetKind
} from "@work-shape/catalyst-server";
import { runOperation } from "@work-shape/catalyst-tool-execution";
import { clientInstanceId, errorSchema } from "./support/access-instance";
import { appFiles, expectStatus, setupAppInstance, type AppInstance } from "./support/app-instance";
import { agentOrigin } from "./support/connection-operations";
import { guardedEvents } from "./support/guardrails";
import { getTestOperationCalls } from "./support/test-instance";

// GR-PUB-2, Workflows acceptance check 76: the default publish guardrail asks only when a publish
// widens reach (a first publish, a new changing action, a new host, Connection or Data Store, a
// wider audience). A publish that widens nothing goes live on its publisher's own click. An
// instance admin can set it to ask on every publish, and that setting is audited. What cannot
// say whether it widens asks, and an agent's publish never goes live without its person's click.

const heldSchema = z.object({
  id: z.string(),
  status: z.literal("pending_approval"),
  approvalRequestId: z.string()
});
const shippedSchema = z.object({
  items: z.array(z.looseObject({ name: z.string(), enabled: z.boolean() }))
});

describe("GR-PUB-2: the default publish guardrail asks only when a publish widens reach", () => {
  let t: AppInstance;
  beforeAll(async () => {
    t = await setupAppInstance({
      server: (stores) => ({
        operations: { events: guardedEvents(stores, {}, { shipped: true }).events }
      })
    });
    // Kai may write and publish the workspace's Apps, and may not approve a publish.
    for (const action of ["app.read", "app.write", "app.publish"]) {
      await t.stores.access.createGrant({
        clientInstanceId,
        holderKind: "user",
        holderId: t.kai.id,
        action,
        effect: "allow",
        scopeKind: "workspace",
        scopeId: t.workspaceId,
        grantedBy: t.admin.id
      });
    }
  });
  afterAll(async () => {
    await t.close();
  });

  const stored = (name: string) =>
    t.stores.configAssets.getConfigAsset({ clientInstanceId, kind: "app", name });
  /** An App the admin made and published for the workspace: revision 1 is live. */
  const liveApp = async (name: string, manifest: Record<string, unknown> = {}) => {
    expectStatus(
      await t.putApp(t.admin.id, name, appFiles(`${name} 1`, { id: name, ...manifest })),
      200
    );
    expectStatus(
      await t.call(t.admin.id, "assets.publish", {
        params: { kind: "app", name },
        payload: { workspaceId: t.workspaceId, revision: 1, audience: "workspace" }
      }),
      200
    );
  };
  /** Kai's next revision of the App: a text fix, or one that names more. */
  const kaiWrites = async (name: string, marker: string, manifest: Record<string, unknown> = {}) =>
    expectStatus(await t.putApp(t.kai.id, name, appFiles(marker, { id: name, ...manifest })), 200);
  const setAlwaysAsk = (userId: string, alwaysAsk: boolean) =>
    t.call(userId, "guardrails.switch_shipped", {
      params: { name: PUBLISH_APPROVAL_GUARDRAIL.name },
      payload: { alwaysAsk }
    });
  const requests = () =>
    t.stores.approvals.countApprovalRequests({ clientInstanceId, kinds: ["app_publish"] });

  it("check 76: a member's text fix goes live on the member's own click, with no request", async () => {
    await liveApp("text-fix");
    await kaiWrites("text-fix", "text-fix 2, typo fixed");
    const before = await requests();

    const response = await t.publish(t.kai.id, "text-fix", 2);

    expectStatus(response, 200);
    expect((await stored("text-fix"))?.publishedRevision).toBe(2);
    expect(await requests()).toBe(before);
    const run = await t.stores.operationRuns.get({
      clientInstanceId,
      id: String(response.headers["operation-run-id"])
    });
    expect(run).toMatchObject({ status: "done", actor: { id: t.kai.id } });
    const published = await t.stores.audit.listAuditEvents({
      clientInstanceId,
      type: "app.published",
      limit: 200
    });
    expect(published.map((event) => event.metadata)).toContainEqual(
      expect.objectContaining({ name: "text-fix", revision: 2, publish_widens: false })
    );
  });

  it("check 76: a first publish waits for an approver", async () => {
    expectStatus(await t.putApp(t.kai.id, "first", appFiles("first", { id: "first" })), 200);
    const response = await t.publish(t.kai.id, "first", 1);
    expectStatus(response, 202);
    heldSchema.parse(response.json());
    expect((await stored("first"))?.publishedRevision).toBeUndefined();
  });

  it("check 76: an outside host the live revision does not call files an app_publish item", async () => {
    await liveApp("host");
    await kaiWrites("host", "host 2", { externalHosts: ["api.example.com"] });

    const response = await t.publish(t.kai.id, "host", 2);

    expectStatus(response, 202);
    const held = heldSchema.parse(response.json());
    expect((await stored("host"))?.publishedRevision).toBe(1);
    const request = await t.stores.approvals.getApprovalRequest({
      clientInstanceId,
      requestId: held.approvalRequestId
    });
    expect(request).toMatchObject({ kind: "app_publish", status: "pending" });
    expect(request?.payload).toMatchObject({ subject: { publish_widens: true } });
  });

  it("check 76: a wider audience files an app_publish item, though the content is the same", async () => {
    expectStatus(await t.putApp(t.admin.id, "wider", appFiles("wider", { id: "wider" })), 200);
    expectStatus(
      await t.call(t.admin.id, "assets.publish", {
        params: { kind: "app", name: "wider" },
        payload: { workspaceId: t.workspaceId, revision: 1, audience: "self" }
      }),
      200
    );
    const response = await t.call(t.kai.id, "assets.publish", {
      params: { kind: "app", name: "wider" },
      payload: { workspaceId: t.workspaceId, revision: 1, audience: "workspace" }
    });
    expectStatus(response, 202);
    expect((await stored("wider"))?.appAvailability?.audience).toBe("self");
  });

  it("check 76: an admin sets it to ask on every publish, audited, and then the text fix waits too", async () => {
    await liveApp("always");
    await kaiWrites("always", "always 2, typo fixed");
    // Only a holder of guardrail.publish at instance scope sets it.
    const refused = await setAlwaysAsk(t.kai.id, true);
    expectStatus(refused, 403);
    expect(errorSchema.parse(refused.json()).error.details).toMatchObject({
      action: "guardrail.publish"
    });

    expectStatus(await setAlwaysAsk(t.admin.id, true), 200);
    try {
      const audit = await t.stores.audit.listAuditEvents({ clientInstanceId, limit: 500 });
      expect(audit).toContainEqual(
        expect.objectContaining({
          type: "guardrail.shipped_switched",
          actor: expect.objectContaining({ userId: t.admin.id }),
          metadata: expect.objectContaining({
            name: PUBLISH_APPROVAL_GUARDRAIL.name,
            alwaysAsk: true
          })
        })
      );
      const listed = shippedSchema.parse(
        (await t.expectOk(t.admin.id, "guardrails.list_shipped")).json()
      );
      expect(listed.items).toEqual([
        expect.objectContaining({
          name: PUBLISH_APPROVAL_GUARDRAIL.name,
          enabled: true,
          alwaysAsk: true
        })
      ]);
      // Each switch writes only its own field: switching the guardrail off and on again keeps
      // the setting, and the setting leaves the guardrail as it was.
      const switchTo = (payload: Record<string, boolean>) =>
        t.call(t.admin.id, "guardrails.switch_shipped", {
          params: { name: PUBLISH_APPROVAL_GUARDRAIL.name },
          payload
        });
      const switched = z.looseObject({ enabled: z.boolean(), alwaysAsk: z.boolean() });
      expect(switched.parse((await switchTo({ enabled: false })).json())).toMatchObject({
        enabled: false,
        alwaysAsk: true
      });
      expect(switched.parse((await switchTo({ alwaysAsk: true })).json())).toMatchObject({
        enabled: false,
        alwaysAsk: true
      });
      expectStatus(await switchTo({ enabled: true }), 200);
      const nothing = await switchTo({});
      expectStatus(nothing, 422);
      expect(errorSchema.parse(nothing.json()).error.details).toMatchObject({
        reason: "nothing_to_switch"
      });

      const response = await t.publish(t.kai.id, "always", 2);

      expectStatus(response, 202);
      heldSchema.parse(response.json());
      expect((await stored("always"))?.publishedRevision).toBe(1);
    } finally {
      // The setting is the instance's: every test of this file reads it.
      expectStatus(await setAlwaysAsk(t.admin.id, false), 200);
    }
    const audit = await t.stores.audit.listAuditEvents({ clientInstanceId, limit: 500 });
    expect(audit).toContainEqual(
      expect.objectContaining({
        type: "guardrail.shipped_switched",
        metadata: expect.objectContaining({ alwaysAsk: false })
      })
    );
    // Back to asking only when it widens: the same text fix goes live on Kai's click.
    expectStatus(await t.publish(t.kai.id, "always", 2), 200);
  });

  it("an agent's publish that widens nothing still waits for its person's click", async () => {
    await liveApp("agent-fix");
    await kaiWrites("agent-fix", "agent-fix 2, typo fixed");
    const calls = await getTestOperationCalls(t.instance);
    const origin: OperationOrigin = agentOrigin("assets.publish");

    const result = await runOperation(
      {
        operation: "assets.publish",
        effect: "changing",
        input: { kind: "app", name: "agent-fix", revision: 2, workspaceId: t.workspaceId },
        actor: { ...t.kai, externalUserId: t.kai.id, authSource: "test", scopes: ["*"] },
        // The agent's conversation is in no workspace; the App's is in the input.
        origin,
        correlationId: "corr_agent_fix"
      },
      // The agent lists the publish tool.
      { ...calls.deps, agentToolNames: () => Promise.resolve(["assets.publish"]) },
      // Made by the agent run's worker, which pauses the run for its person.
      {
        runFence: {
          runId: asAgentRunId("agentrun_test"),
          lease: { jobId: createPlatformId<"JobId">("job"), leaseToken: "lease" }
        }
      }
    );

    expect(result.result.status).toBe("pending_confirmation");
    expect((await stored("agent-fix"))?.publishedRevision).toBe(1);
  });
});

describe("GR-PUB-2: what cannot say whether it widens asks", () => {
  /** The runner with the shipped guardrails alone, switched as `switches` says. */
  const runner = (alwaysAsk = false) => {
    const recordHits = vi.fn<GuardrailStore["recordHits"]>().mockResolvedValue(undefined);
    return new GuardrailRunner({
      clientInstanceId: asClientInstanceId("ci_widening"),
      guardrails: {},
      models: { complete: () => Promise.reject(new Error("no judge runs here")) },
      hits: { recordHits },
      shipped: {
        listShippedGuardrailSwitches: () =>
          Promise.resolve(
            alwaysAsk
              ? [
                  {
                    name: PUBLISH_APPROVAL_GUARDRAIL.name,
                    enabled: true,
                    alwaysAsk: true,
                    switchedBy: { id: "usr_admin", label: "Admin" },
                    switchedAt: new Date(0).toISOString()
                  }
                ]
              : []
          )
      }
    });
  };
  const ask = (
    event: "app.before_publish" | "workflow.before_publish" | "agent.before_publish",
    widens: string | undefined,
    alwaysAsk = false
  ) =>
    runner(alwaysAsk).answer(
      {
        event,
        subject: { kind: event.split(".")[0] ?? "app", name: "offers", workspaceId: "cws_team" },
        match: { kind: event.split(".")[0] ?? "app" },
        fields: () => ({
          name: "offers",
          content: "text",
          ...(widens === undefined ? {} : { [PUBLISH_WIDENS_FIELD]: widens })
        })
      },
      { correlationId: "corr_widening" }
    );
  const outcomes = async (answers: Promise<{ outcome: string }[]>) =>
    (await answers).map((answer) => answer.outcome);

  it("lets through only a publish whose fields say it widens nothing", async () => {
    expect(await outcomes(ask("app.before_publish", "false"))).toEqual([]);
    expect(await outcomes(ask("agent.before_publish", "false"))).toEqual([]);
    expect(await outcomes(ask("app.before_publish", "true"))).toEqual(["require_approval"]);
    // A publish event that names no widening, or names it otherwise, asks.
    expect(await outcomes(ask("app.before_publish", undefined))).toEqual(["require_approval"]);
    expect(await outcomes(ask("workflow.before_publish", undefined))).toEqual(["require_approval"]);
    expect(await outcomes(ask("app.before_publish", "no"))).toEqual(["require_approval"]);
  });

  it("asks at every publish once an admin set it to", async () => {
    expect(await outcomes(ask("app.before_publish", "false", true))).toEqual(["require_approval"]);
    expect(await outcomes(ask("agent.before_publish", "false", true))).toEqual([
      "require_approval"
    ]);
  });

  /** An App record whose live revision reaches `live`, compared with a revision reaching `next`. */
  const review = (live: Partial<PublishReach> | undefined, next: Partial<PublishReach>) => {
    const reach = (part: Partial<PublishReach> | undefined): PublishReach => ({
      calls: [],
      hostsAdded: [],
      connections: [],
      dataStores: [],
      ...part
    });
    const kind: Pick<WorkflowAssetKind, "publishReach"> = {
      publishReach: (config: JsonObject) => reach(config.next === true ? next : live)
    };
    const asset: Parameters<typeof appPublishReview>[0] = {
      ...(live ? { publishedRevisionId: "rev_live", publishedConfig: { next: false } } : {}),
      appAvailability: { audience: "workspace" }
    };
    return appPublishReview(asset, kind, { next: true });
  };

  it("counts each widening of an App's reach, and an action that does not say it only reads", () => {
    expect(review({}, {}).publishWidens).toBe(false);
    expect(review(undefined, {}).publishWidens).toBe(true);
    expect(
      review({}, { calls: [{ label: "send", effect: "changing", change: "new" }] }).publishWidens
    ).toBe(true);
    expect(review({}, { calls: [{ label: "load", change: "changed" }] }).publishWidens).toBe(true);
    expect(
      review({}, { calls: [{ label: "load", effect: "reading", change: "new" }] }).publishWidens
    ).toBe(false);
    expect(review({}, { hostsAdded: ["api.example.com"] }).publishWidens).toBe(true);
    expect(review({ connections: ["crm"] }, { connections: ["crm"] }).publishWidens).toBe(false);
    expect(review({}, { connections: ["crm"] }).publishWidens).toBe(true);
    expect(review({}, { dataStores: [{ name: "findings" }] }).publishWidens).toBe(true);
    expect(
      review({ dataStores: [{ name: "findings" }] }, { dataStores: [{ name: "findings" }] })
        .publishWidens
    ).toBe(false);
  });

  it("counts an agent's added tool, model, skill, Knowledge Base or subagent, and nothing it only says", () => {
    const live: JsonObject = {
      name: "helper",
      displayName: "Helper",
      instructions: "Help.",
      modelBindingId: "fast",
      toolNames: ["web.search"],
      skillNames: [],
      knowledgeBases: ["handbook"]
    };
    expect(agentPublishWidens(live, { ...live, instructions: "Help kindly." })).toBe(false);
    expect(agentPublishWidens(live, { ...live, description: "Says hello." })).toBe(false);
    expect(agentPublishWidens(live, { ...live, toolNames: [] })).toBe(false);
    expect(agentPublishWidens(live, { ...live, toolNames: ["web.search", "mail.send"] })).toBe(
      true
    );
    expect(agentPublishWidens(live, { ...live, modelBindingId: "deep" })).toBe(true);
    expect(agentPublishWidens(live, { ...live, userSelectableModelBindingIds: ["deep"] })).toBe(
      true
    );
    expect(agentPublishWidens(live, { ...live, skillNames: ["offers"] })).toBe(true);
    expect(agentPublishWidens(live, { ...live, knowledgeBases: ["handbook", "hr"] })).toBe(true);
    expect(agentPublishWidens(live, { ...live, subagentNames: ["writer"] })).toBe(true);
    // A field not known to keep the reach counts as widening.
    expect(agentPublishWidens(live, { ...live, useModelFallback: true })).toBe(true);
  });
});
