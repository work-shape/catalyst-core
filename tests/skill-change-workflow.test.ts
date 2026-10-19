import { asUserId } from "@work-shape/catalyst-core";
import { builtInModelCapabilities } from "./support/model-gateway";
import { accessOf } from "./support/access";
import { createTestInstance, getTestExecution } from "./support/test-instance";
import { describe, expect, it, vi } from "vitest";
import { findConfigAssetAgentValidationIssues } from "../packages/client-assembly/src/assembly-validation";
import { createSystemInstructions } from "../packages/agent-runtime/src/system-instructions";
import { createTestConfig } from "./support/fixtures";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import {
  clientInstanceId,
  context,
  creation,
  fixture,
  json,
  operations,
  requester,
  reviewer,
  skill
} from "./support/skill-change-fixture";

describe("skill change approval workflow", () => {
  it("carries an approved skill creation and its undo into a pending draft, moving its base (AD-1 67)", async () => {
    const f = await fixture();
    const live = await f.store.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "agent",
      name: f.agent.name
    });
    if (!live) throw new Error("Seeded agent missing");
    const draft = await f.store.agentProposals.save({
      clientInstanceId,
      agentId: live.id,
      baseRevision: live.revision,
      expectedDraftRevision: null,
      config: json({ ...f.agent, instructions: "Keep this draft." }),
      author: { userId: asUserId(reviewer.id), release: false },
      savedAt: new Date().toISOString()
    });
    const request = await f.propose(creation, "new_skill");
    await f.approve(request.id);
    const updated = await f.store.agentProposals.get({ clientInstanceId, agentId: live.id });
    expect(updated).toMatchObject({
      revision: (draft?.revision ?? 0) + 1,
      baseRevision: live.revision + 1,
      config: {
        instructions: "Keep this draft.",
        skillNames: expect.arrayContaining(["new_skill"])
      }
    });
    // The draft can be consumed on the new base, without stale_base.
    const after = await f.store.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "agent",
      name: f.agent.name
    });
    expect(updated?.baseRevision).toBe(after?.revision);
    await f.workflow.revertRequest(reviewer, accessOf(reviewer), context, request.id);
    const reverted = await f.store.agentProposals.get({ clientInstanceId, agentId: live.id });
    expect(reverted?.config.skillNames).not.toContain("new_skill");
    expect(reverted?.baseRevision).toBe(live.revision + 2);
    expect(reverted?.revision).toBe((updated?.revision ?? 0) + 1);
    if (!reverted) throw new Error("Pending draft missing after skill undo");
    await f.store.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { [`agent:${f.agent.name}`]: reverted.baseRevision },
      mutations: [
        {
          type: "upsert",
          kind: "agent",
          name: f.agent.name,
          config: reverted.config,
          agentPublish: reverted.revision
        }
      ]
    });
    expect(
      await f.store.agentProposals.get({ clientInstanceId, agentId: live.id })
    ).toBeUndefined();
    expect(
      await f.store.configAssets.getConfigAsset({
        clientInstanceId,
        kind: "agent",
        name: f.agent.name
      })
    ).toMatchObject({
      revision: reverted.baseRevision + 1,
      config: { instructions: "Keep this draft." }
    });
  });

  it("applies as the approver with provenance despite disabled interactive administration, then reverts", async () => {
    const f = await fixture();
    expect(f.config.administration.agentConfiguration.allowSkillEditing).toBe(false);
    const request = await f.propose();
    const approved = await f.approve(request.id);
    expect(approved).toMatchObject({
      status: "approved",
      applyResult: { skillName: skill.name, revision: 2, version: 2 }
    });
    expect((await f.revisions()).at(-1)).toMatchObject({
      actor: { userId: reviewer.id },
      origin: { kind: "approval_request", requestId: request.id, summary: request.summary },
      config: { content: "Verify facts.\n\nKeep evidence." }
    });
    expect(
      await f.workflow.getRequest(reviewer, accessOf(reviewer), context, request.id)
    ).toMatchObject({
      canRevert: true,
      preview: request.payload.preview
    });
    expect(
      await f.workflow.getRequest(requester, accessOf(requester), context, request.id)
    ).toMatchObject({
      canRevert: false
    });
    await expect(
      f.workflow.revertRequest(requester, accessOf(requester), context, request.id)
    ).rejects.toMatchObject({
      code: "FORBIDDEN"
    });
    const reverted = await f.workflow.revertRequest(
      reviewer,
      accessOf(reviewer),
      context,
      request.id
    );
    expect(reverted).toMatchObject({
      status: "reverted",
      reversion: { revertedBy: reviewer.id, revertedByLabel: reviewer.displayLabel },
      applyResult: approved.applyResult
    });
    expect((await f.revisions()).at(-1)).toMatchObject({
      operation: "revert",
      config: { content: skill.content },
      actor: { userId: reviewer.id },
      origin: { requestId: request.id }
    });
    expect(f.onDecided).toHaveBeenLastCalledWith(
      await f.store.approvals.getApprovalRequest({ clientInstanceId, requestId: request.id })
    );
    expect(
      (await f.store.audit.listAuditEvents({ clientInstanceId })).find(
        (event) => event.type === "approval_request.reverted"
      )
    ).toMatchObject({
      type: "approval_request.reverted",
      metadata: { requestId: request.id, kind: "skill_change", status: "reverted" }
    });
    await expect(
      f.workflow.revertRequest(reviewer, accessOf(reviewer), context, request.id)
    ).rejects.toMatchObject({
      code: "CONFLICT"
    });
  });
  // Fails without the change: the approval applied the skill unread, so a guardrail added after
  // the agent proposed the change never saw it.
  it("refuses to apply an approved change a guardrail on asset writes blocks, and says why", async () => {
    const f = await fixture({
      no_iban: {
        displayName: "No IBAN in skills",
        on: "asset.before_write",
        filter: { kind: "skill" },
        check: {
          kind: "pattern",
          pattern: "(?i)\\bDE\\d{2}(?:\\s?\\d{4}){4}\\s?\\d{2}\\b",
          reason: "Skills hold no bank account."
        },
        outcome: "block"
      }
    });
    const request = await f.propose([
      {
        type: "replace_text",
        target: "root",
        oldText: "Check facts.",
        newText: "Pay to DE89 3704 0044 0532 0130 00."
      }
    ]);
    const decided = await f.approve(request.id);
    expect(decided).toMatchObject({
      status: "superseded",
      decision: { approved: true, decidedBy: reviewer.id },
      applyResult: {
        execution: "refused",
        error: {
          code: "GUARDRAIL_BLOCKED",
          message:
            "Guardrail 'No IBAN in skills' blocked skill 'Review': Skills hold no bank account."
        }
      }
    });
    expect(await f.revisions()).toHaveLength(1);
    expect(f.onDecided).toHaveBeenLastCalledWith(
      await f.store.approvals.getApprovalRequest({ clientInstanceId, requestId: request.id })
    );
    const [hit, ...more] = await f.store.guardrails.listHits({
      clientInstanceId,
      guardrailName: "no_iban",
      limit: 5
    });
    expect(more).toEqual([]);
    expect(hit).toMatchObject({
      event: "asset.before_write",
      outcome: "block",
      subjectKind: "skill",
      subjectName: "review"
    });
    expect(JSON.stringify(hit)).not.toContain("3704 0044");

    // A change the guardrail lets through is applied.
    expect(await f.approve((await f.propose()).id)).toMatchObject({ status: "approved" });
  });
  it("approves independent pending changes to different paragraphs in sequence", async () => {
    const f = await fixture();
    const first = await f.propose();
    const second = await f.propose([
      { type: "replace_text", target: "root", oldText: "Keep", newText: "Retain" }
    ]);
    expect(await f.approve(first.id)).toMatchObject({ status: "approved" });
    expect(await f.approve(second.id)).toMatchObject({ status: "approved" });
    expect((await f.revisions()).at(-1)?.config?.content).toBe("Verify facts.\n\nRetain evidence.");
    expect(await f.revisions()).toHaveLength(3);
  });

  it("refreshes a pending preview with the current paragraph while the operation still applies", async () => {
    const f = await fixture();
    const first = await f.propose([
      { type: "replace_text", target: "root", oldText: "facts", newText: "sources" }
    ]);
    const second = await f.propose();
    await f.approve(first.id);
    expect(
      await f.workflow.getRequest(reviewer, accessOf(reviewer), context, second.id)
    ).toMatchObject({
      preview: { changes: [{ before: "Check sources.", after: "Verify sources." }] }
    });
    expect(await f.approve(second.id)).toMatchObject({ status: "approved" });
    expect((await f.revisions()).at(-1)?.config?.content).toBe("Verify sources.\n\nKeep evidence.");
  });

  it("supersedes a pending replacement when another approved request changed its oldText", async () => {
    const f = await fixture();
    const first = await f.propose();
    const second = await f.propose([
      { type: "replace_text", target: "root", oldText: "Check", newText: "Examine" }
    ]);
    await f.approve(first.id);
    expect(
      await f.workflow.getRequest(reviewer, accessOf(reviewer), context, second.id)
    ).toMatchObject({
      preview: second.payload.preview
    });
    expect(await f.approve(second.id)).toMatchObject({ status: "superseded" });
    expect(await f.revisions()).toHaveLength(2);
  });

  it("supersedes a pending skill creation when another request created the same name", async () => {
    const f = await fixture();
    const first = await f.propose(creation, "new_skill");
    const second = await f.propose(creation, "new_skill");
    await f.approve(first.id);
    expect(await f.approve(second.id)).toMatchObject({ status: "superseded" });
    expect(await f.revisions("new_skill")).toHaveLength(1);
  });

  it("supersedes a stale proposal and keeps its original preview readable", async () => {
    const f = await fixture();
    const request = await f.propose();
    await applyAtCurrentRevisions(f.store.configAssets, {
      clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "skill",
          name: skill.name,
          config: json({ ...skill, content: "Other content" })
        }
      ]
    });
    expect(
      await f.workflow.getRequest(reviewer, accessOf(reviewer), context, request.id)
    ).toMatchObject({
      preview: request.payload.preview
    });
    expect(await f.approve(request.id)).toMatchObject({ status: "superseded" });
    expect(await f.revisions()).toHaveLength(2);
  });
  it("refuses approval while the policy or skill creation is disabled", async () => {
    const f = await fixture();
    const request = await f.propose();
    f.config.administration.agentConfiguration.agentSkillChanges.enabled = false;
    await expect(f.approve(request.id)).rejects.toThrow("disabled");
    f.config.administration.agentConfiguration.agentSkillChanges.enabled = true;
    const newRequest = await f.propose(creation, "new_skill");
    f.config.administration.agentConfiguration.agentSkillChanges.allowSkillCreation = false;
    await expect(f.approve(newRequest.id)).rejects.toThrow("creation is disabled");
    expect(await f.revisions()).toHaveLength(1);
  });
  it("supersedes a request whose skill was detached or whose agent was deleted", async () => {
    const f = await fixture();
    const detached = await f.propose();
    const orphaned = await f.propose();
    const orphanedCreation = await f.propose(creation, "new_skill");
    await applyAtCurrentRevisions(f.store.configAssets, {
      clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "agent",
          name: f.agent.name,
          config: json({ ...f.agent, skillNames: [] })
        }
      ]
    });
    expect(await f.approve(detached.id)).toMatchObject({ status: "superseded" });
    await applyAtCurrentRevisions(f.store.configAssets, {
      clientInstanceId,
      mutations: [
        { type: "delete", kind: "agent", name: f.agent.name },
        { type: "setDefaultAgent", agentName: undefined }
      ]
    });
    expect(await f.approve(orphaned.id)).toMatchObject({ status: "superseded" });
    expect(await f.approve(orphanedCreation.id)).toMatchObject({ status: "superseded" });
    expect(await f.revisions()).toHaveLength(1);
  });
  it("recovers an interrupted approval after the skill was detached and refuses to reject or withdraw it", async () => {
    const f = await fixture();
    const request = await f.propose();
    const handlerContext = {
      ...context,
      clientInstanceId,
      requestId: request.id,
      summary: request.summary
    };
    const applied = await f.handler.apply(request.payload, reviewer, handlerContext);
    await applyAtCurrentRevisions(f.store.configAssets, {
      clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "agent",
          name: f.agent.name,
          config: json({ ...f.agent, skillNames: [] })
        }
      ]
    });
    await expect(
      f.workflow.decideRequest(reviewer, accessOf(reviewer), context, {
        requestId: request.id,
        decision: "reject"
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      f.workflow.decideRequest(reviewer, accessOf(reviewer), context, {
        requestId: request.id,
        decision: "request_changes",
        comment: "Please shorten"
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      f.workflow.withdrawRequest(requester, accessOf(requester), context, request.id)
    ).rejects.toMatchObject({
      code: "CONFLICT"
    });
    expect(await f.approve(request.id)).toMatchObject({
      status: "approved",
      applyResult: applied
    });
    expect(await f.revisions()).toHaveLength(2);
  });
  it("creates and removes a skill and agent reference in one versioned batch each", async () => {
    const f = await fixture();
    const request = await f.propose(creation, "new_skill");
    await f.approve(request.id);
    const snapshot = await f.source.getSnapshot();
    expect(snapshot.agents[0]?.skillNames).toEqual([skill.name, "new_skill"]);
    const newRevision = (await f.revisions("new_skill"))[0];
    expect((await f.revisions(f.agent.name, "agent")).at(-1)).toMatchObject({
      globalVersion: newRevision?.globalVersion,
      actor: { userId: reviewer.id },
      origin: { requestId: request.id }
    });
    await f.workflow.revertRequest(reviewer, accessOf(reviewer), context, request.id);
    expect((await f.source.getSnapshot()).agents[0]?.skillNames).toEqual([skill.name]);
    expect((await f.source.getSnapshot()).skills.map((candidate) => candidate.name)).toEqual([
      skill.name
    ]);
    expect((await f.revisions("new_skill")).at(-1)).toMatchObject({
      operation: "delete",
      globalVersion: 3,
      origin: { requestId: request.id },
      actor: { userId: reviewer.id }
    });
    expect((await f.revisions(f.agent.name, "agent")).at(-1)?.globalVersion).toBe(3);
  });
  it.each(["approve", "revert"] as const)(
    "keeps unavailable stored tools and skills when a creation %s is refused by strict writes",
    async (action) => {
      const f = await fixture();
      const request = await f.propose(creation, "new_skill");
      if (action === "revert") await f.approve(request.id);
      const stored = {
        ...f.agent,
        toolNames: [...f.agent.toolNames, "documents.search"],
        skillNames: [
          ...f.agent.skillNames,
          "later_skill",
          ...(action === "revert" ? ["new_skill"] : [])
        ]
      };
      await applyAtCurrentRevisions(f.store.configAssets, {
        clientInstanceId,
        mutations: [{ type: "upsert", kind: "agent", name: stored.name, config: json(stored) }]
      });
      expect((await f.source.getSnapshot()).agents[0]).toMatchObject({
        toolNames: f.agent.toolNames,
        skillNames: [skill.name, ...(action === "revert" ? ["new_skill"] : [])]
      });
      await expect(
        action === "approve"
          ? f.approve(request.id)
          : f.workflow.revertRequest(reviewer, accessOf(reviewer), context, request.id)
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      expect((await f.revisions(stored.name, "agent")).at(-1)?.config).toEqual(json(stored));
      expect((await f.revisions("new_skill")).length).toBe(action === "revert" ? 1 : 0);
    }
  );

  it("keeps a pending request applicable when its agent's primary model is unavailable", async () => {
    const f = await fixture();
    const request = await f.propose();
    await applyAtCurrentRevisions(f.store.configAssets, {
      clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "agent",
          name: f.agent.name,
          config: json({ ...f.agent, modelProviderId: "removed_model" })
        }
      ]
    });
    expect((await f.source.getSnapshot()).agents).toEqual([]);
    expect(
      await f.workflow.getRequest(reviewer, accessOf(reviewer), context, request.id)
    ).toMatchObject({ status: "pending" });
    expect(await f.approve(request.id)).toMatchObject({ status: "approved" });
    expect((await f.revisions(f.agent.name, "agent")).at(-1)?.config?.modelProviderId).toBe(
      "removed_model"
    );
  });

  it("returns the original result when reapplied and recovers a pending request after an interrupted transition", async () => {
    const f = await fixture();
    const request = await f.propose();
    const handlerContext = {
      ...context,
      clientInstanceId,
      requestId: request.id,
      summary: request.summary
    };
    const first = await f.handler.apply(request.payload, reviewer, handlerContext);
    expect(await f.handler.apply(request.payload, reviewer, handlerContext)).toEqual(first);
    expect(await f.approve(request.id)).toMatchObject({ status: "approved", applyResult: first });
    expect(await f.revisions()).toHaveLength(2);
    const approved = await f.store.approvals.getApprovalRequest({
      clientInstanceId,
      requestId: request.id
    });
    if (!approved || !f.handler.revert) {
      throw new Error("Expected an approved request and revert handler");
    }
    await f.handler.revert(approved, reviewer, handlerContext);
    expect(
      await f.workflow.revertRequest(reviewer, accessOf(reviewer), context, request.id)
    ).toMatchObject({
      status: "reverted"
    });
    expect(await f.revisions()).toHaveLength(3);
  });
  it("does not overwrite a concurrent revision while reading the mutation snapshot", async () => {
    const f = await fixture();
    const request = await f.propose();
    const getAsset = f.store.configAssets.getConfigAsset.bind(f.store.configAssets);
    let raced = false;
    vi.spyOn(f.store.configAssets, "getConfigAsset").mockImplementation(async (input) => {
      const stored = await getAsset(input);
      if (input.kind === "skill" && !raced) {
        raced = true;
        await applyAtCurrentRevisions(f.store.configAssets, {
          clientInstanceId,
          mutations: [
            {
              type: "upsert",
              kind: "skill",
              name: skill.name,
              config: json({ ...skill, content: "Concurrent work" })
            }
          ]
        });
      }
      return stored;
    });
    await expect(
      f.handler.apply(request.payload, reviewer, {
        ...context,
        clientInstanceId,
        requestId: request.id,
        summary: request.summary
      })
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect((await f.revisions()).at(-1)?.config?.content).toBe("Concurrent work");
    expect(await f.revisions()).toHaveLength(2);
  });

  it("blocks revert when newer skill revisions exist", async () => {
    const f = await fixture();
    const request = await f.propose();
    await f.approve(request.id);
    await applyAtCurrentRevisions(f.store.configAssets, {
      clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "skill",
          name: skill.name,
          config: json({ ...skill, content: "Newer work" })
        }
      ]
    });
    await expect(
      f.workflow.revertRequest(reviewer, accessOf(reviewer), context, request.id)
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("newer changes")
    });
    expect(
      (await f.workflow.getRequest(reviewer, accessOf(reviewer), context, request.id)).status
    ).toBe("approved");
  });
  it("does not partially remove a created skill referenced by another agent", async () => {
    const f = await fixture();
    const request = await f.propose(creation, "new_skill");
    await f.approve(request.id);
    await applyAtCurrentRevisions(f.store.configAssets, {
      clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "agent",
          name: "other",
          config: json({ ...f.agent, name: "other", skillNames: ["new_skill"] })
        }
      ]
    });
    await expect(
      f.workflow.revertRequest(reviewer, accessOf(reviewer), context, request.id)
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED"
    });
    expect(
      (await f.source.getSnapshot()).agents.find((candidate) => candidate.name === f.agent.name)
        ?.skillNames
    ).toContain("new_skill");
    expect(await f.revisions("new_skill")).toHaveLength(1);
  });
  // Fails without the change: the set was validated before the lock alone, so a revert that
  // removed a created skill and a write that gave the skill to another agent both passed, and
  // that agent was left with a skill that is gone.
  it("refuses a revert when another agent took the created skill between its check and its lock", async () => {
    const f = await fixture();
    const request = await f.propose(creation, "new_skill");
    await f.approve(request.id);
    const store = f.store.configAssets;
    const apply = store.applyConfigAssetMutations.bind(store);
    store.applyConfigAssetMutations = async (input) => {
      store.applyConfigAssetMutations = apply;
      await applyAtCurrentRevisions(store, {
        clientInstanceId,
        mutations: [
          {
            type: "upsert",
            kind: "agent",
            name: "other",
            config: json({ ...f.agent, name: "other", skillNames: ["new_skill"] })
          }
        ]
      });
      return apply(input);
    };
    await expect(
      f.workflow.revertRequest(reviewer, accessOf(reviewer), context, request.id)
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const snapshot = await f.source.getSnapshot();
    expect(snapshot.skills.map((candidate) => candidate.name)).toContain("new_skill");
    expect(snapshot.agents.find((candidate) => candidate.name === "other")?.skillNames).toEqual([
      "new_skill"
    ]);
    expect(await f.revisions("new_skill")).toHaveLength(1);
  });
  it("allows only one concurrent revert", async () => {
    const f = await fixture();
    const request = await f.propose();
    await f.approve(request.id);
    const outcomes = await Promise.allSettled([
      f.workflow.revertRequest(reviewer, accessOf(reviewer), context, request.id),
      f.workflow.revertRequest(reviewer, accessOf(reviewer), context, request.id)
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(await f.revisions()).toHaveLength(3);
  });
});

describe("skill change tool and wiring policy", () => {
  it("creates a pending request with an inline display and minimized audit summary", async () => {
    const f = await fixture();
    const result = await f.tool.execute(
      { skillName: skill.name, summary: "Verify facts.", operations },
      f.toolContext
    );
    expect(result).toMatchObject({
      status: "success",
      output: { status: "pending", message: expect.stringContaining("NOT active") },
      display: {
        kind: "catalyst.approval_request",
        version: 1,
        mode: "inline",
        data: { kind: "skill_change" }
      }
    });
    if (result.status !== "success") throw new Error("Expected success");
    const requestId = (result.output as { requestId: string }).requestId;
    expect(result.auditSummary?.metadata).toEqual({ skillName: skill.name, requestId });
    expect(
      await f.workflow.getRequest(requester, accessOf(requester), context, requestId)
    ).toMatchObject({
      status: "pending",
      origin: {
        agentName: f.agent.name,
        toolCallId: "call",
        agentRunId: "run",
        conversationId: "conversation"
      },
      requestedBy: { id: requester.id },
      preview: { changes: [{ before: "Check facts.", after: "Verify facts." }] }
    });
    expect(await f.revisions()).toHaveLength(1);
  });
  it("returns precise nonunique-match errors and rejects disabled policy before creating requests", async () => {
    const f = await fixture();
    expect(
      await f.tool.execute(
        {
          skillName: skill.name,
          summary: "Update.",
          operations: [{ type: "replace_text", target: "root", oldText: "e", newText: "E" }]
        },
        f.toolContext
      )
    ).toMatchObject({
      status: "failed",
      error: { code: "validation_failed", message: expect.stringContaining("exactly once") }
    });
    f.config.administration.agentConfiguration.agentSkillChanges.enabled = false;
    expect(
      await f.tool.execute({ skillName: skill.name, summary: "Update.", operations }, f.toolContext)
    ).toMatchObject({
      status: "failed",
      error: { code: "not_allowed", message: expect.stringContaining("disabled") }
    });
    expect((await f.workflow.pendingCount(reviewer, accessOf(reviewer))).count).toBe(0);
  });
  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false]
  ])("includes instructions only with policy %s and tool %s", (enabled, toolPresent) => {
    const content = createSystemInstructions("Help", "en", {
      agentSkillChangesEnabled: enabled,
      agentToolNames: toolPresent ? ["propose_skill_change"] : []
    });
    expect(content.includes("Skill change proposals:")).toBe(enabled && toolPresent);
  });
  it("registers the built-in handler and tool in the execution assembly", async () => {
    const config = createTestConfig({
      tools: [{ name: "read_skill" }, { name: "propose_skill_change" }]
    });
    config.administration.agentConfiguration.agentSkillChanges.enabled = true;
    const assembly = await createTestInstance({
      execution: {
        config,
        tools: [],
        env: {}
      }
    }).then(getTestExecution);
    try {
      expect(assembly.approvalRequestHandlers.get("skill_change")?.requiredPermission).toBe(
        "agent_skills.approve"
      );
      expect(
        assembly.localAgentRuntimeOptions.toolRegistry.listDescriptorsForAgent([
          "propose_skill_change"
        ])
      ).toMatchObject([{ name: "propose_skill_change", permission: { mode: "allow" } }]);
      expect(assembly.localAgentRuntimeOptions.agentSkillChangesEnabled).toBe(true);
    } finally {
      await assembly.close();
    }
  });

  it("rejects an agent tool reference with disabled policy", async () => {
    const f = await fixture();
    const capabilities = builtInModelCapabilities(f.config);
    expect(findConfigAssetAgentValidationIssues(f.config, [f.agent], capabilities)).toEqual([]);
    f.config.administration.agentConfiguration.agentSkillChanges.enabled = false;
    expect(findConfigAssetAgentValidationIssues(f.config, [f.agent], capabilities)).toEqual([
      expect.stringContaining("skill changes are disabled")
    ]);
  });
});
