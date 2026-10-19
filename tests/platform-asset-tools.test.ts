import {
  WORKFLOW_ASSET_KIND,
  asCollaborationWorkspaceId,
  asConversationId,
  asUserId,
  readToolResultMetadata,
  type OperationRun
} from "@work-shape/catalyst-core";
import { DeterministicModelProvider } from "@work-shape/catalyst-model-provider";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getTestJobs } from "./support/test-instance";
import { drainRunEvents, injectStartConversationRun } from "./support/chat-server-run-harness";
import { waitUntil } from "./support/assertions";
import { withTestSql } from "./support/test-sql";
import {
  createAssetToolsFixture,
  WORKFLOW,
  OTHER,
  subject,
  configOf,
  manifest,
  trigger,
  result,
  notRun,
  added,
  readSchema,
  issuesSchema,
  writeSchema,
  runSchema,
  subjectSchema
} from "./support/platform-asset-tools";

describe("a conversation about a Workflow", () => {
  it("ACCEPT-FIX-13 C2: the agent's skill read carries the same save-approval fact as the skill page", async () => {
    let holding = false;
    const t = await createAssetToolsFixture("in_process", [], {
      centralPolicySettings: () =>
        holding ? [{ operation: "assets.put", value: "approval", assetKind: "skill" }] : []
    });
    const named = { kind: "skill", name: "approval-fact" };
    await t.ok(
      t.app.call("assets.put", {
        params: named,
        payload: {
          config: {
            name: named.name,
            title: "Approval fact",
            description: "A synthetic skill",
            content: "# Skill"
          },
          expectedRevision: null
        }
      })
    );
    const { id } = z.object({ id: z.string() }).parse((await t.ok(t.converse(named))).json());
    holding = true;
    const page = z
      .object({ saveApproval: z.object({ approverNames: z.array(z.string()) }) })
      .parse((await t.ok(t.app.call("assets.get", { params: named }))).json());
    const read = await t.call(id, "platform.assets.get");
    expect(read).toMatchObject({ saveApproval: page.saveApproval });
    expect(page.saveApproval.approverNames).toEqual([]);
  });

  it("PR-382 M2: read_skill carries the save-approval fact of the skill page for the reading person", async () => {
    let holding = false;
    const t = await createAssetToolsFixture("in_process", ["skillNames"], {
      skillTool: true,
      centralPolicySettings: () =>
        holding ? [{ operation: "assets.put", value: "approval", assetKind: "skill" }] : []
    });
    const named = { kind: "skill", name: "read-fact" };
    await t.ok(
      t.app.call("assets.put", {
        params: named,
        payload: {
          config: {
            name: named.name,
            title: "Read fact",
            description: "A synthetic skill",
            content: "# Skill"
          },
          expectedRevision: null
        }
      })
    );
    // The agent of the conversation holds the skill, as its published definition lists it.
    const { id } = z.object({ id: z.string() }).parse((await t.ok(t.converse(undefined))).json());
    const agent = { kind: "agent", name: "test_agent" };
    const live = z
      .object({ revision: z.number(), config: z.record(z.string(), z.unknown()) })
      .parse((await t.ok(t.app.call("assets.get", { params: agent }))).json());
    const draft = z.object({ draftRevision: z.number() }).parse(
      (
        await t.ok(
          t.app.call("assets.put", {
            params: agent,
            payload: {
              config: { ...live.config, skillNames: [named.name] },
              expectedRevision: live.revision,
              expectedDraftRevision: null
            }
          })
        )
      ).json()
    );
    await t.ok(
      t.app.call("assets.publish", {
        params: agent,
        payload: { revision: live.revision, draftRevision: draft.draftRevision }
      })
    );
    const readSkill = async () =>
      z
        .object({ content: z.string(), saveApproval: z.unknown().optional() })
        .parse(await t.call(id, "read_skill", { name: named.name })).saveApproval;
    expect(await readSkill()).toBeUndefined();
    holding = true;
    const page = z
      .object({ saveApproval: z.object({ approverNames: z.array(z.string()) }) })
      .parse((await t.ok(t.app.call("assets.get", { params: named }))).json());
    expect(await readSkill()).toEqual(page.saveApproval);
  });

  it("PR-382 M1: platform.context says a skill's create waits for an approval before it is made", async () => {
    let holding = false;
    const t = await createAssetToolsFixture("in_process", [], {
      centralPolicySettings: () =>
        holding ? [{ operation: "assets.put", value: "approval", assetKind: "skill" }] : []
    });
    const { id } = z.object({ id: z.string() }).parse((await t.ok(t.converse(undefined))).json());
    const kinds = async () =>
      z
        .object({
          kinds: z.array(
            z.object({ kind: z.string(), createApproval: z.unknown().optional() }).loose()
          )
        })
        .parse(await t.call(id, "platform.context")).kinds;
    const skillKind = async () => (await kinds()).find((kind) => kind.kind === "skill");
    expect((await skillKind())?.createApproval).toBeUndefined();
    holding = true;
    expect((await skillKind())?.createApproval).toEqual({ approverNames: [] });
    // A kind the setting does not name is created as before.
    expect(
      (await kinds()).find((kind) => kind.kind === "workflow")?.createApproval
    ).toBeUndefined();
  });

  beforeAll(() => {
    // The demo provider paces every word of its tool-result echo by 20 ms. These tests
    // exercise asset tools, not token animation: keep its real completion, without pacing.
    vi.spyOn(DeterministicModelProvider.prototype, "stream").mockImplementation(async function* (
      this: DeterministicModelProvider,
      request
    ) {
      yield { type: "completed", completion: await this.complete(request) };
    });
  });
  afterAll(() => vi.restoreAllMocks());

  it("builds a new Workflow from chat and completes its first test using a discovered account and caller, without account-management rights or a manual principal", async () => {
    const t = await createAssetToolsFixture();
    const principals = await t.app.stores.apiAccess.listServicePrincipals({
      clientInstanceId: t.clientInstanceId
    });
    for (const principal of principals)
      await t.app.stores.apiAccess.deleteServicePrincipal({
        clientInstanceId: t.clientInstanceId,
        servicePrincipalId: principal.id
      });
    const account = await t.app.stores.apiAccess.createServicePrincipal({
      clientInstanceId: t.clientInstanceId,
      name: "weekly-documents",
      displayLabel: "Weekly documents"
    });
    const integration = await t.app.stores.apiAccess.createServicePrincipal({
      clientInstanceId: t.clientInstanceId,
      name: "local-config-cli",
      displayLabel: "Local config CLI"
    });
    await t.app.stores.apiAccess.createApiCredential({
      clientInstanceId: t.clientInstanceId,
      servicePrincipalId: integration.id,
      name: "Release key"
    });
    await t.app.stores.apiAccess.createServicePrincipal({
      clientInstanceId: t.clientInstanceId,
      name: "release-without-key",
      displayLabel: "Release account",
      permissions: ["config_assets.release"]
    });
    await t.app.stores.apiAccess.createServicePrincipal({
      clientInstanceId: t.clientInstanceId,
      name: "more-rights",
      displayLabel: "More rights",
      permissions: ["users.manage"]
    });
    const retired = await t.app.stores.apiAccess.createServicePrincipal({
      clientInstanceId: t.clientInstanceId,
      name: "retired-documents",
      displayLabel: "Retired documents"
    });
    await t.app.stores.apiAccess.updateServicePrincipal({
      clientInstanceId: t.clientInstanceId,
      servicePrincipalId: retired.id,
      status: "disabled"
    });
    const existingAsset = await t.app.stores.configAssets.getConfigAsset({
      clientInstanceId: t.clientInstanceId,
      ...subject
    });
    if (!existingAsset) throw new Error("The fixture Workflow is missing");
    await t.app.stores.apiAccess.createServicePrincipal({
      clientInstanceId: t.clientInstanceId,
      name: "owned-documents",
      displayLabel: "Owned documents",
      owner: { kind: "workflow", assetId: existingAsset.id }
    });
    const { id, createdByUserId } = z
      .object({ id: z.string(), createdByUserId: z.string() })
      .parse((await t.ok(t.converse(undefined, OTHER))).json());
    const call = async (tool: string, input: unknown = {}) => {
      const { answer } = await t.say(id, `/tool ${tool} ${JSON.stringify(input)}`, OTHER);
      const parsed: unknown = JSON.parse(answer ?? "null");
      return parsed;
    };
    expect(await call("platform.context")).toMatchObject({ workflowPrincipals: [] });
    for (const action of ["workflow.write", "workflow.read"])
      await t.ok(
        t.app.call("permissions.grant", {
          payload: {
            holderKind: "user",
            holderId: createdByUserId,
            action,
            effect: "allow",
            scopeKind: "instance"
          }
        })
      );
    const rights = z
      .object({ instanceActions: z.array(z.string()) })
      .parse((await t.ok(t.app.call("platform.context.get", {}, OTHER))).json());
    expect(rights.instanceActions).not.toContain("service_principals.manage");
    expect(rights.instanceActions).not.toContain("api_access.manage");
    const context = z
      .object({
        caller: z.object({ id: z.string() }),
        workflowPrincipals: z.array(z.object({ name: z.string(), displayLabel: z.string() }))
      })
      .parse(await call("platform.context"));
    expect(context.workflowPrincipals).toEqual([
      { name: account.name, displayLabel: account.displayLabel }
    ]);
    const selected = context.workflowPrincipals[0];
    expect(selected).toBeDefined();
    const name = "weekly-document-summary";
    expect(
      await call("platform.assets.put", {
        kind: "workflow",
        name,
        config: {
          name,
          manifest: {
            ...manifest(),
            id: name,
            name: "Weekly document summary",
            runAs: selected?.name,
            steps: [
              trigger,
              {
                id: "tell",
                name: "Send me the summary",
                type: "notify",
                to: { users: [context.caller.id] },
                channels: ["inbox", "mail"],
                title: { value: "Weekly summary" },
                text: { ref: { step: "start", path: "input.note" } }
              },
              result
            ]
          }
        }
      })
    ).toMatchObject({ saved: true });
    const run = runSchema.parse(
      await call("workflows.test", { workflow: name, input: { note: "No new documents" } })
    );
    const jobs = getTestJobs(t.app);
    for (let pass = 0; pass < 8; pass++) await jobs.runDue();
    expect(await call("workflows.get_run", { runId: run.id })).toMatchObject({
      status: "done",
      principal: { name: account.name },
      startedBy: { id: context.caller.id }
    });
    expect(await call("workflows.list_step_runs", { runId: run.id })).toMatchObject({
      items: [
        { stepId: "start", status: "done" },
        { stepId: "tell", status: "done", target: "dry_run" },
        { stepId: "result", status: "done" }
      ]
    });
    expect(
      await t.app.stores.approvals.countApprovalRequests({
        clientInstanceId: t.clientInstanceId,
        kinds: ["notice"],
        requestedById: context.caller.id
      })
    ).toBe(0);
  });

  it("offers a Workflow publish confirmation in chat and changes nothing before the person's click", async () => {
    const t = await createAssetToolsFixture("in_process", [], {
      publishTool: true,
      filesStore: true
    });
    const { id } = z.object({ id: z.string() }).parse((await t.ok(t.converse(subject))).json());
    const written = writeSchema.parse(
      await t.call(id, "platform.assets.put", {
        ...subject,
        expectedRevision: t.published,
        config: { name: WORKFLOW, manifest: { ...manifest(), description: "Reviewed from chat" } }
      })
    );
    const started = await injectStartConversationRun(
      t.app,
      id,
      `/tool assets.publish ${JSON.stringify({ ...subject, revision: written.revision })}`
    );
    const observing = drainRunEvents(t.app, id, started.run.id);
    let pending: OperationRun | undefined;
    await waitUntil(async () => {
      pending = (
        await t.app.stores.operationRuns.list({ clientInstanceId: t.clientInstanceId })
      ).find((run) => run.operation === "assets.publish" && run.origin.kind === "agent");
      if (pending && pending.status !== "running" && pending.status !== "pending_confirmation")
        expect(pending.status).toBe("pending_confirmation");
      return pending?.status === "pending_confirmation";
    }, "the Workflow publish asks its person to confirm");
    expect((await t.asset()).publishedRevision).toBe(t.published);
    if (!pending) throw new Error("The publish confirmation is missing");
    await t.ok(
      t.app.call("operations.decide", {
        params: { runId: pending.id },
        payload: { decision: "confirm" }
      })
    );
    const events = await observing;
    expect(events).toContain("tool_decision_requested");
    expect((await t.asset()).publishedRevision).toBe(written.revision);
  });

  it("lets the agent test its subject draft without a prompt and read the run and each step through the real operations", async () => {
    const t = await createAssetToolsFixture();
    const { id } = z.object({ id: z.string() }).parse((await t.ok(t.converse(subject))).json());
    await t.call(id, "platform.assets.put", {
      config: { ...configOf(), manifest: { ...manifest(), name: "Draft month end" } },
      expectedRevision: t.published
    });
    const started = runSchema
      .extend({
        mode: z.literal("test"),
        startedBy: z.object({ kind: z.literal("user"), id: z.string() }),
        operationRunId: z.string()
      })
      .parse(
        await t.call(id, "workflows.test", {
          workflow: WORKFLOW,
          input: { note: "Draft test" }
        })
      );
    const draft = await t.app.stores.configAssets.getConfigAsset({
      clientInstanceId: t.clientInstanceId,
      ...subject
    });
    expect(started.definitionRevisionId).toBe(draft?.activeRevisionId);
    expect(started.definitionRevisionId).not.toBe(draft?.publishedRevisionId);
    const jobs = getTestJobs(t.app);
    for (let pass = 0; pass < 6; pass++) await jobs.runDue();
    // The run page polls both reads. A person's successful refresh leaves no governance
    // record, while the same reads through the agent tools below each leave one.
    for (const operation of ["workflows.get_run", "workflows.list_step_runs"] as const) {
      const response = await t.ok(t.app.call(operation, { params: { runId: started.id } }));
      expect(response.headers["operation-run-id"]).toBeUndefined();
      const correlationId = z.string().parse(response.headers["x-correlation-id"]);
      expect(
        await withTestSql(
          (sql) => sql`
          select 'run' as record from operation_runs
          where client_instance_id = ${t.clientInstanceId} and correlation_id = ${correlationId}
          union all
          select 'audit' as record from audit_events
          where client_instance_id = ${t.clientInstanceId} and correlation_id = ${correlationId}`
        )
      ).toEqual([]);
    }
    expect(await t.call(id, "workflows.get_run", { runId: started.id })).toMatchObject({
      id: started.id,
      mode: "test",
      status: "done",
      outputPreview: { text: expect.stringContaining("Draft test") }
    });
    expect(await t.call(id, "workflows.list_step_runs", { runId: started.id })).toMatchObject({
      items: [
        { stepId: "start", status: "done" },
        {
          stepId: "result",
          status: "done",
          outputPreview: { text: expect.stringContaining("Draft test") }
        }
      ]
    });
    const runs = await t.app.stores.operationRuns.list({ clientInstanceId: t.clientInstanceId });
    const test = runs.find((run) => run.id === started.operationRunId);
    expect(test).toMatchObject({
      operation: "workflows.test",
      status: "done",
      actor: { kind: "user", id: started.startedBy.id },
      origin: { kind: "agent", conversationId: id, toolName: "workflows.test" }
    });
    expect(test?.decision).toBeUndefined();
    for (const operation of ["workflows.get_run", "workflows.list_step_runs"]) {
      const reads = runs.filter((run) => run.operation === operation);
      expect(reads).toHaveLength(1);
      const [read] = reads;
      expect(read).toMatchObject({
        status: "done",
        origin: { kind: "agent", conversationId: id, toolName: operation }
      });
      expect(
        (
          await withTestSql(
            (sql) => sql<{ type: string; status: string }[]>`
              select type, status from audit_events
              where client_instance_id = ${t.clientInstanceId}
                and metadata ->> 'operationRunId' = ${read?.id ?? ""}`
          )
        )
          .map((event) => `${event.type}:${event.status}`)
          .sort()
      ).toEqual([
        "operation.authorization_checked:success",
        "operation.completed:success",
        "operation.started:success"
      ]);
    }
    // The person can write this other draft too; the subject boundary still refuses it.
    await t.ok(
      t.app.call("assets.put", {
        params: { kind: WORKFLOW_ASSET_KIND, name: "another-workflow" },
        payload: {
          config: { name: "another-workflow", manifest: { ...manifest(), id: "another-workflow" } },
          expectedRevision: null
        }
      })
    );
    const refused = await t.say(
      id,
      '/tool workflows.test {"workflow":"another-workflow","input":{"note":"Other draft"}}'
    );
    expect(refused.answer).toContain("An agent may test only the conversation's subject Workflow");
    const malformed = await t.say(id, '/tool workflows.test {"workflow":42,"input":[]}');
    expect(malformed.answer).toContain("validation");
  }, 120_000);

  it("lets the agent read the definition, be refused its first try, correct it and save a draft that changes nothing that runs", async () => {
    const t = await createAssetToolsFixture();
    const created = await t.ok(t.converse(subject));
    const conversation = z
      .object({ id: z.string(), subject: z.object({ kind: z.string(), name: z.string() }) })
      .parse(created.json());
    expect(conversation.subject).toEqual(subject);
    const { id } = conversation;

    // The agent reads the skill the platform ships for a Workflow, and the definition.
    const skill = z
      .object({ name: z.string(), content: z.string() })
      .parse(await t.call(id, "read_skill", { name: "workflow-authoring" }));
    expect(skill.content).toContain("type: operation");
    const read = readSchema.parse(await t.call(id, "platform.assets.get"));
    expect(read).toMatchObject({
      config: { name: WORKFLOW },
      revision: t.published,
      publishedRevision: t.published,
      shows: "published"
    });
    expect(read.config.manifest.steps).toHaveLength(2);

    // Its first try holds a step the engine does not run: the check says so, and a save of
    // it stores nothing.
    const checked = z
      .object({ valid: z.boolean(), issues: issuesSchema })
      .parse(await t.call(id, "platform.assets.validate", { config: configOf([notRun]) }));
    expect(checked.valid).toBe(false);
    expect(checked.issues).toMatchObject([{ path: "steps[1].type", code: "not_supported_yet" }]);
    const refused = writeSchema.parse(
      await t.call(id, "platform.assets.put", {
        config: configOf([notRun]),
        expectedRevision: read.revision
      })
    );
    expect(refused).toMatchObject({ saved: false, issues: [{ code: "not_supported_yet" }] });
    expect(await t.asset()).toEqual({ revision: t.published, publishedRevision: t.published });

    // It corrects the step, checks again and saves.
    expect(await t.call(id, "platform.assets.validate", { config: configOf([added]) })).toEqual({
      valid: true,
      issues: []
    });
    const saved = writeSchema.parse(
      await t.call(id, "platform.assets.put", {
        config: configOf([added]),
        expectedRevision: read.revision
      })
    );
    expect(saved).toEqual({ saved: true, revision: t.published + 1 });

    // A draft now differs from what is published, and what is published is what it was.
    expect(await t.asset()).toEqual({
      revision: t.published + 1,
      publishedRevision: t.published
    });
    const again = readSchema.parse(await t.call(id, "platform.assets.get"));
    expect(again).toMatchObject({ revision: t.published + 1, shows: "draft" });
    expect(again.config.manifest.steps).toHaveLength(3);

    // A run still starts on the published revision and ends on its two steps.
    const started = runSchema.parse(
      (
        await t.ok(
          t.app.call("workflows.start", {
            params: { workflow: WORKFLOW },
            payload: { input: { note: "2026-10" } }
          })
        )
      ).json()
    );
    expect(started.definitionRevisionId).toBe(await t.publishedRevisionId());
    const jobs = getTestJobs(t.app);
    for (let pass = 0; pass < 6; pass++) await jobs.runDue();
    const ended = z
      .object({ status: z.string(), stepRunCount: z.number() })
      .parse((await t.app.call("workflows.get_run", { params: { runId: started.id } })).json());
    expect(ended).toEqual({ status: "done", stepRunCount: 2 });

    // A save against the revision the agent read first is a conflict, and saves nothing.
    const stale = writeSchema.parse(
      await t.call(id, "platform.assets.put", {
        config: configOf([added, { ...added, id: "books_again" }]),
        expectedRevision: read.revision
      })
    );
    expect(stale).toMatchObject({ saved: false, conflict: "REVISION_CONFLICT" });
    expect((await t.asset()).revision).toBe(t.published + 1);

    // Each call is the owner's: its Operation Run names the person, and the save left the
    // audit row a save through the API leaves, with that run.
    const runs = await t.app.stores.operationRuns.list({ clientInstanceId: t.clientInstanceId });
    const put = runs.filter((run) => run.operation === "platform.assets.put");
    expect(put.map((run) => [run.status, run.actor.kind, run.origin.kind])).toEqual([
      ["done", "user", "agent"],
      ["done", "user", "agent"],
      ["done", "user", "agent"]
    ]);
    const audited = await t.app.stores.audit.listAuditEvents({
      clientInstanceId: t.clientInstanceId
    });
    const updates = audited.filter(
      (event) =>
        event.type === "config_asset.updated" &&
        put.some((run) => run.id === event.metadata?.operationRunId)
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.actor?.userId).toBe(
      asUserId((await t.app.call("me.get", {})).json<{ id: string }>().id)
    );
  }, 120_000);

  it("leaves an asset of the instance the agent opens for the person to go to, and a read moves nothing", async () => {
    const t = await createAssetToolsFixture();
    const { id } = z.object({ id: z.string() }).parse((await t.ok(t.converse(undefined))).json());
    const subjectOf = async (as?: string) =>
      z
        .object({ conversation: z.object({ subject: subjectSchema.optional() }) })
        .parse(
          (
            await t.ok(
              t.app.call("conversations.thread.get", { params: { conversationId: id } }, as)
            )
          ).json()
        ).conversation.subject;

    // Nothing is checked or saved before an asset is opened: there is none yet.
    for (const [tool, input] of [
      ["platform.assets.get", {}],
      ["platform.assets.validate", { config: configOf() }],
      ["platform.assets.put", { config: configOf(), expectedRevision: t.published }]
    ] as const) {
      const { answer } = await t.say(id, `/tool ${tool} ${JSON.stringify(input)}`);
      expect(answer).toContain(
        "This conversation is about no asset yet. Open the one to work on with platform.assets.open"
      );
    }
    const halfNamed = await t.say(id, `/tool platform.assets.get {"kind":"workflow"}`);
    expect(halfNamed.answer).toContain("Name the asset with both 'kind' and 'name'");
    expect(await subjectOf()).toBeUndefined();

    // An asset that does not exist is refused, and the conversation stays about nothing.
    const missing = await t.say(
      id,
      `/tool platform.assets.open ${JSON.stringify({ kind: WORKFLOW_ASSET_KIND, name: "no-such-workflow" })}`
    );
    expect(missing.answer).toContain("The subject of the conversation is not available");
    expect(await subjectOf()).toBeUndefined();

    // A read of the Workflow reads it and moves nothing: the save still has no asset.
    const looked = readSchema.parse(await t.call(id, "platform.assets.get", subject));
    expect(looked.config.name).toBe(WORKFLOW);
    expect(await subjectOf()).toBeUndefined();
    const unopened = await t.say(
      id,
      `/tool platform.assets.put ${JSON.stringify({ config: configOf([added]), expectedRevision: looked.revision })}`
    );
    expect(unopened.answer).toContain("This conversation is about no asset yet");

    // The Workflow and the agent belong to the whole instance: the agent's own open of either
    // reads it and leaves it for the person, as a document the agent read could have asked
    // for it. Only the person's step makes one the subject, so the conversation stays about
    // nothing and a save reaches neither.
    const openSchema = z.object({
      name: z.string(),
      title: z.string(),
      awaitsPerson: z.literal(true)
    });
    for (const asset of [subject, { kind: "agent", name: "test_agent" }]) {
      const opened = openSchema.parse(await t.call(id, "platform.assets.open", asset));
      expect(opened.name).toBe(asset.name);
      expect(await subjectOf()).toBeUndefined();
    }
    const unsaved = await t.say(
      id,
      `/tool platform.assets.put ${JSON.stringify({ config: configOf([added]), expectedRevision: looked.revision })}`
    );
    expect(unsaved.answer).toContain("This conversation is about no asset yet");
    expect((await t.asset()).revision).toBe(t.published);

    // Another person may not take that step in the person's conversation, and the person may
    // not take it onto an asset they cannot read: both are told as missing.
    const step = (about: { kind: string; name: string }, as?: string, toolCallId?: string) =>
      t.app.call(
        "conversations.subject.open",
        {
          params: { conversationId: id },
          payload: { ...about, ...(toolCallId ? { toolCallId } : {}) }
        },
        as
      );
    expect((await step(subject, OTHER)).statusCode).toBe(404);
    expect((await step({ kind: WORKFLOW_ASSET_KIND, name: "no-such-workflow" })).statusCode).toBe(
      404
    );
    expect(await subjectOf()).toBeUndefined();

    // The confirmation names the agent's open it answers: one of this asset, in this
    // conversation, that waits for the person. Another call, or the open of another asset, is
    // refused and makes nothing the subject.
    const openOf = async (name: string) => {
      const stored = await t.app.stores.conversations.listMessages({
        clientInstanceId: t.clientInstanceId,
        conversationId: asConversationId(id)
      });
      const found = stored
        .map((message) => readToolResultMetadata(message.metadata))
        .find(
          (result) =>
            result?.toolName === "platform.assets.open" &&
            JSON.stringify(result.result).includes(`"name":"${name}"`)
        );
      return String(found?.toolCallId ?? "");
    };
    const workflowOpen = await openOf(WORKFLOW);
    const agentOpen = await openOf("test_agent");
    expect(workflowOpen).not.toBe("");
    for (const unconfirmed of [
      await step(subject, undefined, "call_made_up"),
      await step(subject, undefined, agentOpen)
    ]) {
      expect(unconfirmed.statusCode).toBe(422);
      expect(
        unconfirmed.json<{ error: { details?: { reason?: string } } }>().error.details
      ).toEqual({ reason: "open_not_pending" });
    }
    expect(await subjectOf()).toBeUndefined();

    // The person goes to the Workflow: that step makes it the subject, audited once as the
    // person's answer to the agent's open, and the agent's save reaches it.
    const confirmed = await t.ok(step(subject, undefined, workflowOpen));
    expect(
      subjectSchema.parse(z.object({ subject: subjectSchema }).parse(confirmed.json()).subject)
    ).toEqual(subject);
    expect(await subjectOf()).toEqual(subject);
    // The same confirmation sent again changes nothing and writes no second row.
    await t.ok(step(subject, undefined, workflowOpen));
    const audited = await t.app.stores.audit.listAuditEvents({
      clientInstanceId: t.clientInstanceId,
      limit: 500
    });
    expect(
      audited
        .filter((event) => event.type === "conversation.subject_opened" && event.subject === id)
        .map((event) => event.metadata)
    ).toEqual([
      {
        subjectKind: WORKFLOW_ASSET_KIND,
        subjectName: WORKFLOW,
        confirmsToolCallId: workflowOpen,
        operationRunId: expect.stringMatching(/^oprun_/)
      }
    ]);
    const saved = writeSchema.parse(
      await t.call(id, "platform.assets.put", {
        config: configOf([added]),
        expectedRevision: looked.revision
      })
    );
    expect(saved).toEqual({ saved: true, revision: t.published + 1 });
  }, 120_000);

  it("opens and saves the asset of the instance a conversation started from its page is about, and moves to no other one", async () => {
    const t = await createAssetToolsFixture();
    const { id } = z.object({ id: z.string() }).parse((await t.ok(t.converse(subject))).json());
    const subjectOf = async () =>
      z
        .object({ conversation: z.object({ subject: subjectSchema.optional() }) })
        .parse(
          (
            await t.ok(t.app.call("conversations.thread.get", { params: { conversationId: id } }))
          ).json()
        ).conversation.subject;

    // The person started the conversation from the Workflow's page: the agent opens it, and
    // answers its read and its title, and a save reaches it.
    const read = readSchema
      .extend({ title: z.string() })
      .parse(await t.call(id, "platform.assets.open", subject));
    expect(read.config.name).toBe(WORKFLOW);
    expect(read.title).toBe("Month end");
    expect(await subjectOf()).toEqual(subject);
    const saved = writeSchema.parse(
      await t.call(id, "platform.assets.put", {
        config: configOf([added]),
        expectedRevision: read.revision
      })
    );
    expect(saved).toEqual({ saved: true, revision: t.published + 1 });

    // Another asset of the instance waits for the person: the conversation stays about the
    // Workflow, and a save still reaches the Workflow and nothing else.
    const agent = { kind: "agent", name: "test_agent" };
    expect(
      z
        .object({ awaitsPerson: z.literal(true) })
        .parse(await t.call(id, "platform.assets.open", agent))
    ).toEqual({ awaitsPerson: true });
    expect(await subjectOf()).toEqual(subject);

    // A conversation started from the agent's page is about the agent. Its agent opens it, and
    // a save there is a change proposal for the agent (agent-change-proposals.test.ts): the
    // Workflow's definition is no agent, so it saves nothing, and the Workflow stays as it is.
    const { id: aboutAgent } = z
      .object({ id: z.string() })
      .parse((await t.ok(t.converse(agent))).json());
    expect(
      z
        .object({ kind: z.string(), name: z.string() })
        .parse(await t.call(aboutAgent, "platform.assets.open", agent))
    ).toEqual(agent);
    const live = await t.say(
      aboutAgent,
      `/tool platform.assets.put ${JSON.stringify({ config: configOf(), expectedRevision: 1 })}`
    );
    expect(
      z
        .object({ saved: z.boolean() })
        .loose()
        .parse(JSON.parse(live.answer ?? "null"))
    ).toMatchObject({
      saved: false
    });
    expect((await t.asset()).revision).toBe(t.published + 1);
  }, 120_000);

  describe("with one instance for reads and refused changes", () => {
    let t: Awaited<ReturnType<typeof createAssetToolsFixture>>;
    beforeAll(async () => {
      t = await createAssetToolsFixture();
    });

    it("checks and saves only the asset of its conversation, whatever the model names", async () => {
      const { id } = z.object({ id: z.string() }).parse((await t.ok(t.converse(subject))).json());
      const read = readSchema.parse(await t.call(id, "platform.assets.get"));
      expect(read.config.name).toBe(WORKFLOW);
      // The published Workflow is discoverable through the agent's operation tool.
      expect(await t.call(id, "platform.assets.operations")).toMatchObject({
        operations: [{ name: `workflow.${WORKFLOW}.start`, effect: "changing" }],
        truncated: false
      });
      // A config that names another asset is no save of this one, and none of the other.
      const other = { name: "year-end", manifest: { ...manifest(), id: "year-end" } };
      const refused = writeSchema.parse(
        await t.call(id, "platform.assets.put", { config: other, expectedRevision: read.revision })
      );
      expect(refused).toMatchObject({ saved: false, issues: [{ code: "subject_mismatch" }] });
      expect(
        await t.app.stores.configAssets.getConfigAsset({
          clientInstanceId: t.clientInstanceId,
          kind: WORKFLOW_ASSET_KIND,
          name: "year-end"
        })
      ).toBeUndefined();
    }, 120_000);

    it("opens an asset of the conversation's workspace in a conversation about nothing, the last one opened winning", async () => {
      const created = z
        .object({ id: z.string(), collaborationWorkspaceId: z.string() })
        .parse((await t.ok(t.converse(undefined))).json());
      const { id } = created;
      const subjectOf = async () =>
        z
          .object({ conversation: z.object({ subject: subjectSchema.optional() }) })
          .parse(
            (
              await t.ok(t.app.call("conversations.thread.get", { params: { conversationId: id } }))
            ).json()
          ).conversation.subject;
      // Two assets the conversation's workspace owns, as an App is owned. What the open asks is
      // the owner of the asset, not its kind, so a Workflow stored for the workspace stands in.
      const owned = (name: string) => ({ kind: WORKFLOW_ASSET_KIND, name });
      for (const name of ["team-close", "team-open"]) {
        await t.app.stores.configAssets.applyConfigAssetMutations({
          clientInstanceId: t.clientInstanceId,
          baseRevisions: { [`${WORKFLOW_ASSET_KIND}:${name}`]: null },
          mutations: [
            {
              type: "upsert",
              kind: WORKFLOW_ASSET_KIND,
              name,
              draft: true,
              scope: {
                kind: "workspace",
                workspaceId: asCollaborationWorkspaceId(created.collaborationWorkspaceId)
              },
              config: {
                name,
                manifest: {
                  id: name,
                  name,
                  runAs: "workflow-runner",
                  inputs: { type: "object" },
                  outputs: { type: "object" },
                  steps: [trigger, result]
                }
              }
            }
          ]
        });
      }

      const first = readSchema.parse(await t.call(id, "platform.assets.open", owned("team-close")));
      expect(first.config.name).toBe("team-close");
      expect(await subjectOf()).toEqual(owned("team-close"));
      const second = readSchema.parse(await t.call(id, "platform.assets.open", owned("team-open")));
      expect(second.config.name).toBe("team-open");
      expect(await subjectOf()).toEqual(owned("team-open"));
    }, 120_000);

    it("opens a hidden asset as a missing one, and none into a conversation its workspace shares", async () => {
      // The member may not read the Workflow: the open is refused as for one that does not
      // exist, and the conversation stays about nothing.
      const { id: own } = z
        .object({ id: z.string() })
        .parse((await t.ok(t.converse(undefined, OTHER))).json());
      const hidden = await t.say(
        own,
        `/tool platform.assets.open ${JSON.stringify(subject)}`,
        OTHER
      );
      const missing = await t.say(
        own,
        `/tool platform.assets.open ${JSON.stringify({ kind: WORKFLOW_ASSET_KIND, name: "no-such-workflow" })}`,
        OTHER
      );
      expect(hidden.answer).toContain("The subject of the conversation is not available");
      expect(hidden.answer).toBe(missing.answer);
      const conversation = z
        .object({ conversation: z.object({ subject: subjectSchema.optional() }) })
        .parse(
          (
            await t.ok(
              t.app.call("conversations.thread.get", { params: { conversationId: own } }, OTHER)
            )
          ).json()
        );
      expect(conversation.conversation.subject).toBeUndefined();

      // A conversation of a Shared Workspace that its members read opens no asset and gets no
      // definition into it, also not by a read.
      const { id: workspaceId } = z
        .object({ id: z.string() })
        .parse(
          (await t.ok(t.app.call("workspaces.create", { payload: { name: "Shared" } }))).json()
        );
      const { id: shared } = z.object({ id: z.string(), visibility: z.literal("workspace") }).parse(
        (
          await t.ok(
            t.app.call("conversations.create", {
              payload: { title: "Team", collaborationWorkspaceId: workspaceId }
            })
          )
        ).json()
      );
      for (const tool of ["platform.assets.open", "platform.assets.get"]) {
        const refused = await t.say(shared, `/tool ${tool} ${JSON.stringify(subject)}`);
        expect(refused.answer).toContain("This conversation is shared with its workspace");
        expect(refused.answer).not.toContain("manifest");
      }
      // Nor does the person's own step make an asset what a shared conversation is about.
      const stepped = await t.app.call("conversations.subject.open", {
        params: { conversationId: shared },
        payload: subject
      });
      expect(stepped.statusCode).toBe(409);
      const sharedThread = z
        .object({ conversation: z.object({ subject: subjectSchema.optional() }) })
        .parse(
          (
            await t.ok(
              t.app.call("conversations.thread.get", { params: { conversationId: shared } })
            )
          ).json()
        );
      expect(sharedThread.conversation.subject).toBeUndefined();
    }, 120_000);

    it("refuses a conversation about a Workflow its creator may not read as it refuses one about nothing", async () => {
      const unreadable = await t.converse(subject, OTHER);
      const missing = await t.converse({ kind: WORKFLOW_ASSET_KIND, name: "no-such-workflow" });
      const unknownKind = await t.converse({ kind: "no-such-kind", name: WORKFLOW });
      // An agent has no draft and may be a subject all the same: its agent reads it.
      expect((await t.converse({ kind: "agent", name: "test_agent" })).statusCode).toBe(200);
      const refusal = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
      const told = [unreadable, missing, unknownKind].map((response) => ({
        status: response.statusCode,
        ...refusal.parse(response.json()).error
      }));
      expect(told[0]).toEqual({
        status: 404,
        code: "NOT_FOUND",
        message: "The subject of the conversation is not available"
      });
      expect(told[1]).toEqual(told[0]);
      expect(told[2]).toEqual(told[0]);
      // The same person creates a conversation about nothing.
      expect((await t.converse(undefined, OTHER)).statusCode).toBe(200);
    }, 120_000);
  });
});
