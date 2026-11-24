import { describe, expect, it, vi } from "vitest";
import {
  StoreBackedAuditRecorder,
  asUserId,
  conversationMarked,
  type AuthenticatedUser,
  type PermissionGrant
} from "@work-shape/catalyst-core";
import {
  createSkillChangePreview,
  type SkillChangeOperation,
  type SkillConfig
} from "@work-shape/catalyst-config-schema";
import {
  createProposeSkillChangeTool,
  createSkillSourceVersion
} from "@work-shape/catalyst-tool-execution";
import { ApprovalRequestWorkflow } from "@work-shape/catalyst-server";
import { accessOf } from "./support/access";
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

// `skill.approve` on the skill a `skill_change` request changes decides it: on that skill, on
// what its workspace owns, or on the instance. `operations.approve` is not asked for it. A new
// skill is decided where it will be owned. Holders of `agent_skills.approve` decide every
// request as before (skill-change-workflow.test.ts).

const editor: AuthenticatedUser = { ...requester, id: "editor", displayLabel: "Editor" };

/** Editor's access with one allow of `skill.approve` at the scope. */
function editorWith(scope: Pick<PermissionGrant, "scopeKind" | "scopeId">) {
  return accessOf(editor, {
    grants: [
      {
        id: "grant_editor",
        clientInstanceId,
        holderKind: "user",
        holderId: editor.id,
        action: "skill.approve",
        effect: "allow",
        ...scope,
        grantedBy: asUserId("admin"),
        createdAt: "2026-11-01T00:00:00.000Z"
      }
    ]
  });
}

async function skillAssetId(f: Awaited<ReturnType<typeof fixture>>, name = "review") {
  const stored = await f.store.configAssets.getConfigAsset({
    clientInstanceId,
    kind: "skill",
    name
  });
  if (!stored) throw new Error(`Skill ${name} missing`);
  return stored.id;
}

function workspaceOf(f: Awaited<ReturnType<typeof fixture>>): string {
  if (f.owner.kind !== "workspace") throw new Error("Expected a workspace owner");
  return f.owner.workspaceId;
}

describe("skill.approve on the skill a request changes", () => {
  it("files the request naming the skill, and lets its holder list and decide it", async () => {
    const f = await fixture();
    const assetId = await skillAssetId(f);
    const request = await f.propose();
    expect(request.payload.subject).toEqual({
      skillAssetId: assetId,
      workspaceId: workspaceOf(f)
    });
    const access = editorWith({ scopeKind: "asset", scopeId: assetId });
    expect(
      (await f.workflow.listRequests(editor, access, context)).map((item) => [
        item.id,
        item.canDecide
      ])
    ).toEqual([[request.id, true]]);
    const decided = await f.workflow.decideRequest(editor, access, context, {
      requestId: request.id,
      decision: "approve"
    });
    expect(decided).toMatchObject({ status: "approved", decision: { decidedBy: editor.id } });
  });

  it.each(["workspace", "instance"] as const)(
    "is decided by a holder of the right on the %s, without operations.approve",
    async (scopeKind) => {
      const f = await fixture();
      const request = await f.propose();
      const access = editorWith(
        scopeKind === "workspace" ? { scopeKind, scopeId: workspaceOf(f) } : { scopeKind }
      );
      expect(access.authorize("operations.approve").allowed).toBe(false);
      expect(
        await f.workflow.decideRequest(editor, access, context, {
          requestId: request.id,
          decision: "approve"
        })
      ).toMatchObject({ status: "approved" });
    }
  );

  it("is neither listed to nor decided by a holder on another skill", async () => {
    const f = await fixture();
    const request = await f.propose();
    await f.store.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { "skill:other": null },
      mutations: [
        {
          type: "upsert",
          kind: "skill",
          name: "other",
          scope: f.owner,
          config: { name: "other", title: "Other", description: "Other", content: "Other." }
        }
      ]
    });
    const access = editorWith({ scopeKind: "asset", scopeId: await skillAssetId(f, "other") });
    expect(await f.workflow.listRequests(editor, access, context)).toEqual([]);
    await expect(
      f.workflow.decideRequest(editor, access, context, {
        requestId: request.id,
        decision: "approve"
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("keeps the subject it read itself, whatever the filer said", async () => {
    const f = await fixture();
    const assetId = await skillAssetId(f);
    const request = await f.workflow.createRequest(requester, context, {
      kind: "skill_change",
      summary: "Verify facts carefully.",
      payload: {
        ...(await f.propose()).payload,
        subject: { skillAssetId: "forged", workspaceId: null }
      }
    });
    expect(request.payload.subject).toEqual({
      skillAssetId: assetId,
      workspaceId: workspaceOf(f)
    });
  });
});

describe("skill.approve on a request that creates a skill", () => {
  it("is decided where the new skill will be owned, never by a holder on another skill", async () => {
    const f = await fixture();
    const request = await f.propose(creation, "new_skill");
    expect(request.payload.subject).toEqual({ skillAssetId: null, workspaceId: workspaceOf(f) });
    const onSkill = editorWith({ scopeKind: "asset", scopeId: await skillAssetId(f) });
    expect(await f.workflow.listRequests(editor, onSkill, context)).toEqual([]);
    await expect(
      f.workflow.decideRequest(editor, onSkill, context, {
        requestId: request.id,
        decision: "approve"
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const inWorkspace = editorWith({ scopeKind: "workspace", scopeId: workspaceOf(f) });
    expect(
      (await f.workflow.listRequests(editor, inWorkspace, context)).map((item) => item.id)
    ).toEqual([request.id]);
    expect(
      await f.workflow.decideRequest(editor, inWorkspace, context, {
        requestId: request.id,
        decision: "approve"
      })
    ).toMatchObject({ status: "approved" });
  });
});

describe("a skill change its requester may approve", () => {
  it("is in To decide for the requester alone, and another approver finds and decides it", async () => {
    const f = await fixture();
    const editorAccess = editorWith({ scopeKind: "asset", scopeId: await skillAssetId(f) });
    // The workflow reads each requester's rights as they are when they file.
    const workflow = new ApprovalRequestWorkflow({
      clientInstanceId,
      store: f.store.approvals,
      handlers: new Map([[f.handler.kind, f.handler]]),
      auditRecorder: new StoreBackedAuditRecorder({ clientInstanceId, store: f.store.audit }),
      authorizer: {
        forActor: (actor) =>
          Promise.resolve(actor.id === editor.id ? editorAccess : accessOf(actor))
      }
    });
    const theirs = await workflow.createRequest(requester, context, {
      kind: "skill_change",
      summary: "Verify facts carefully.",
      payload: (await f.propose()).payload
    });
    const own = await workflow.createRequest(editor, context, {
      kind: "skill_change",
      summary: "Verify facts carefully.",
      payload: theirs.payload
    });
    expect(own.requesterDecides).toBe(true);
    expect(theirs.requesterDecides).toBeUndefined();

    const pending = async (user: AuthenticatedUser, access = accessOf(user)) =>
      (await workflow.listRequests(user, access, context, { status: "pending" })).map(
        (item) => item.id
      );
    expect(await pending(editor, editorAccess)).toContain(own.id);
    expect(await pending(reviewer)).not.toContain(own.id);
    expect(await pending(reviewer)).toContain(theirs.id);
    expect(await workflow.pendingCount(reviewer, accessOf(reviewer))).toMatchObject({
      othersOwn: 1
    });
    const others = await workflow.listRequests(reviewer, accessOf(reviewer), context, {
      scope: "others_own"
    });
    expect(others.map((item) => [item.id, item.canDecide])).toEqual([[own.id, true]]);
    expect(
      await workflow.decideRequest(reviewer, accessOf(reviewer), context, {
        requestId: own.id,
        decision: "reject"
      })
    ).toMatchObject({ status: "rejected" });
  });
});

// SKILL-ACCEPT-1 (2026-11-16): a person who may make a skill live (`skill.publish`)
// accepts the change their agent proposed for it themselves, and it is live at once. Nobody
// else decides a request through `skill.publish`: without `skill.approve` another person's
// request stays theirs to wait on.

const publisher: AuthenticatedUser = { ...requester, id: "publisher", displayLabel: "Publisher" };
const other: AuthenticatedUser = { ...requester, id: "other", displayLabel: "Other" };

function publishGrant(
  user: AuthenticatedUser,
  scope: Pick<PermissionGrant, "scopeKind" | "scopeId">
) {
  return accessOf(user, {
    grants: [
      {
        id: `grant_${user.id}`,
        clientInstanceId,
        holderKind: "user",
        holderId: user.id,
        action: "skill.publish",
        effect: "allow",
        ...scope,
        grantedBy: asUserId("admin"),
        createdAt: "2026-11-16T00:00:00.000Z"
      }
    ]
  });
}

describe("a skill change its requester may publish", () => {
  it("is accepted by the requester and is live at once, and nobody else decides it with skill.publish", async () => {
    const f = await fixture(undefined, "shared");
    const stored = await f.store.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "skill",
      name: "review"
    });
    if (!stored) throw new Error("Skill review missing");
    const scope =
      stored.scope.kind === "workspace"
        ? ({ scopeKind: "workspace", scopeId: stored.scope.workspaceId } as const)
        : ({ scopeKind: "instance" } as const);
    const publisherAccess = publishGrant(publisher, scope);
    const otherAccess = publishGrant(other, scope);
    expect(publisherAccess.authorize("skill.approve").allowed).toBe(false);
    const workflow = new ApprovalRequestWorkflow({
      clientInstanceId,
      store: f.store.approvals,
      handlers: new Map([[f.handler.kind, f.handler]]),
      auditRecorder: new StoreBackedAuditRecorder({ clientInstanceId, store: f.store.audit }),
      authorizer: {
        forActor: (actor) =>
          Promise.resolve(
            actor.id === publisher.id
              ? publisherAccess
              : actor.id === other.id
                ? otherAccess
                : accessOf(actor)
          )
      }
    });
    const own = await workflow.createRequest(publisher, context, {
      kind: "skill_change",
      summary: "Verify facts carefully.",
      payload: (await f.propose()).payload
    });
    expect(own.requesterDecides).toBe(true);

    // Another holder of skill.publish neither finds nor decides it.
    await expect(
      workflow.decideRequest(other, otherAccess, context, {
        requestId: own.id,
        decision: "approve"
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const view = await workflow.getRequest(publisher, publisherAccess, context, own.id);
    expect(view.canDecide).toBe(true);
    expect(
      await workflow.decideRequest(publisher, publisherAccess, context, {
        requestId: own.id,
        decision: "approve"
      })
    ).toMatchObject({ status: "approved", decision: { decidedBy: publisher.id } });
    const live = await f.store.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "skill",
      name: "review"
    });
    expect(JSON.stringify(live?.config)).toContain("Verify facts.");
  });

  it("waits for an approver where the requester holds no skill.publish", async () => {
    const f = await fixture(undefined, "shared");
    const workflow = new ApprovalRequestWorkflow({
      clientInstanceId,
      store: f.store.approvals,
      handlers: new Map([[f.handler.kind, f.handler]]),
      auditRecorder: new StoreBackedAuditRecorder({ clientInstanceId, store: f.store.audit }),
      authorizer: { forActor: (actor) => Promise.resolve(accessOf(actor)) }
    });
    const request = await workflow.createRequest(requester, context, {
      kind: "skill_change",
      summary: "Verify facts carefully.",
      payload: (await f.propose()).payload
    });
    expect(request.requesterDecides).toBeUndefined();
    const view = await workflow.getRequest(requester, accessOf(requester), context, request.id);
    expect(view.canDecide).toBe(false);
  });
});

// An approved change to a shared skill goes live on approval. A pending draft of the skill gets
// the same change and moves onto the new live revision: its own edits stay unpublished, and
// publishing it later keeps the change. A draft the change does not apply to stays behind.

async function sharedSkill() {
  const f = await fixture(undefined, "shared");
  const live = await f.store.configAssets.getConfigAsset({
    clientInstanceId,
    kind: "skill",
    name: skill.name
  });
  if (!live) throw new Error("Skill missing");
  const draft = () => f.store.agentProposals.get({ clientInstanceId, agentId: live.id });
  const saveDraft = (content: string) =>
    f.store.agentProposals.save({
      clientInstanceId,
      agentId: live.id,
      baseRevision: live.revision,
      expectedDraftRevision: null,
      config: json({ ...skill, content }),
      author: { userId: asUserId(requester.id), release: false },
      savedAt: new Date().toISOString()
    });
  const liveContent = async () => (await f.source.getSkill(skill.name))?.content;
  const undo = (requestId: string) =>
    f.workflow.revertRequest(reviewer, accessOf(reviewer), context, requestId);
  return { ...f, live, draft, saveDraft, liveContent, undo };
}

describe("approved changes to a shared skill", () => {
  it("go live on approval without a draft, and an undo writes the live skill back", async () => {
    const f = await sharedSkill();
    const request = await f.propose();
    expect(await f.approve(request.id)).toMatchObject({
      status: "approved",
      applyResult: { skillName: skill.name, revision: 2 }
    });
    expect(await f.liveContent()).toBe("Verify facts.\n\nKeep evidence.");
    expect(await f.draft()).toBeUndefined();
    await f.undo(request.id);
    expect(await f.liveContent()).toBe(skill.content);
    expect(await f.revisions()).toHaveLength(3);
  });

  it("go live without the pending draft's edits, which get the change and move onto it", async () => {
    const f = await sharedSkill();
    const saved = await f.saveDraft(`Private draft note.\n\n${skill.content}`);
    const request = await f.propose();
    const pending = await f.workflow.getRequest(
      requester,
      accessOf(requester),
      context,
      request.id
    );
    expect(JSON.stringify(pending.preview)).not.toContain("Private draft note");
    const approved = await f.approve(request.id);
    expect(approved).toMatchObject({ status: "approved", applyResult: { revision: 2 } });
    expect(JSON.stringify(approved.applyResult)).not.toContain("Private draft note");
    // Live has the change and nothing of the draft.
    expect(await f.liveContent()).toBe("Verify facts.\n\nKeep evidence.");
    // The draft keeps its edits and its author, gains the change and stands on revision 2.
    const draft = await f.draft();
    expect(draft).toMatchObject({
      revision: (saved?.revision ?? 0) + 1,
      baseRevision: 2,
      author: { userId: requester.id },
      config: { content: "Private draft note.\n\nVerify facts.\n\nKeep evidence." }
    });
    if (!draft) throw new Error("Draft missing");
    // Publishing the draft later keeps the approved change.
    await f.store.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { [`skill:${skill.name}`]: draft.baseRevision },
      mutations: [
        {
          type: "upsert",
          kind: "skill",
          name: skill.name,
          scope: f.owner,
          config: draft.config,
          agentPublish: draft.revision
        }
      ]
    });
    expect(await f.liveContent()).toBe("Private draft note.\n\nVerify facts.\n\nKeep evidence.");
    expect(await f.draft()).toBeUndefined();
  });

  it("leave a draft the change does not apply to behind, so its publish is refused as stale", async () => {
    const f = await sharedSkill();
    const saved = await f.saveDraft("Rewritten from scratch.");
    const request = await f.propose();
    expect(await f.approve(request.id)).toMatchObject({ status: "approved" });
    expect(await f.liveContent()).toBe("Verify facts.\n\nKeep evidence.");
    expect(await f.draft()).toMatchObject({
      revision: saved?.revision,
      baseRevision: f.live.revision,
      config: { content: "Rewritten from scratch." }
    });
    await expect(
      f.store.configAssets.applyConfigAssetMutations({
        clientInstanceId,
        baseRevisions: { [`skill:${skill.name}`]: 2 },
        mutations: [
          {
            type: "upsert",
            kind: "skill",
            name: skill.name,
            scope: f.owner,
            config: json({ ...skill, content: "Rewritten from scratch." }),
            agentPublish: saved?.revision ?? 0
          }
        ]
      })
    ).rejects.toMatchObject({ code: "CONFLICT", details: { reason: "stale_base" } });
  });

  it("recovers the live write when recording the approval decision fails", async () => {
    const f = await sharedSkill();
    const request = await f.propose();
    const transition = f.store.approvals.transitionPendingApprovalRequest.bind(f.store.approvals);
    const failing = vi
      .spyOn(f.store.approvals, "transitionPendingApprovalRequest")
      .mockImplementationOnce((input) =>
        transition({
          ...input,
          resolve: async (pending, stores) => {
            await input.resolve(pending, stores);
            throw new Error("Decision storage failed");
          }
        })
      );
    await expect(f.approve(request.id)).rejects.toThrow("Decision storage failed");
    failing.mockRestore();
    expect(
      await f.store.approvals.getApprovalRequest({ clientInstanceId, requestId: request.id })
    ).toMatchObject({ status: "pending" });
    expect(await f.approve(request.id)).toMatchObject({
      status: "approved",
      applyResult: { revision: 2 }
    });
    expect(await f.revisions()).toHaveLength(2);
  });
});

// A skill change an agent files after it read a functional mailbox (MBX-1b, acceptance check
// 74): the request carries one flag and nothing of the mail, and the skill stays at its live
// revision until approved. Fails
// where a request from a marked conversation reads like any other, or where it stored text
// beyond the agent's own edit and reason.

/** A request the tool files in a private chat of the requester, marked or not. */
async function filed(marked: boolean) {
  const f = await fixture();
  // The person who chatted with the agent, in a private chat of their own.
  const author = await f.store.users.createUser({ clientInstanceId, displayLabel: "Author" });
  const own = await f.store.workspaces.ensurePersonalWorkspace({
    clientInstanceId,
    userId: asUserId(author.id)
  });
  const chat = await f.store.conversations.createConversation({
    clientInstanceId,
    collaborationWorkspaceId: own.id,
    createdByUserId: author.id,
    createdByExternalUserId: author.id,
    visibility: "private",
    title: "Mailbox feedback",
    retainedUntil: "2027-01-01T00:00:00.000Z"
  });
  // What the first call of a mailbox's tool does to the conversation (MBX-1a).
  if (marked) {
    await f.store.conversations.markPersonalData({
      clientInstanceId,
      conversationId: chat.id,
      userId: author.id,
      at: new Date().toISOString()
    });
  }
  const tool = createProposeSkillChangeTool({
    assetSource: f.source,
    policy: f.config.administration.agentConfiguration.agentSkillChanges,
    creator: f.workflow,
    markedConversation: (id) => conversationMarked(f.store, clientInstanceId, id)
  });
  const result = await tool.execute(
    { skillName: skill.name, summary: "Verify facts, as a reader asked by mail.", operations },
    {
      ...f.toolContext,
      toolRequest: { ...f.toolContext.toolRequest, conversationId: chat.id }
    }
  );
  if (result.status !== "success") throw new Error(`Expected a request, got ${result.status}`);
  const output: unknown = result.output;
  const requestId =
    typeof output === "object" && output !== null && "requestId" in output
      ? String(output.requestId)
      : "";
  const request = await f.workflow.getRequest(requester, accessOf(requester), context, requestId);
  return { f, request };
}

describe("a skill change filed from a marked conversation", () => {
  it("carries the flag and no mail, and stays unapplied until approved", async () => {
    const { f, request } = await filed(true);
    expect(request.payload).toMatchObject({ markedConversation: true, operations });
    expect(request.preview).toMatchObject({ markedConversation: true });
    // The edit and its reason, and nothing the mailbox answered.
    expect(Object.keys(request.payload).sort()).toEqual(
      [
        "agentName",
        "baseSourceVersion",
        "markedConversation",
        "operations",
        "preview",
        "skillName",
        "subject"
      ].sort()
    );
    // SKILL-LIVE-1: the live skill keeps its revision until a holder of skill.approve approves.
    expect(await f.revisions()).toHaveLength(1);
    expect(request.status).toBe("pending");
  });

  it("reads like any other request where the conversation is not marked", async () => {
    const { request } = await filed(false);
    expect(request.payload).not.toHaveProperty("markedConversation");
    expect(request.preview).not.toHaveProperty("markedConversation");
  });
});

const withResource: SkillConfig = {
  ...skill,
  resources: [
    { path: "references/payment.md", mediaType: "text/markdown", content: "Pay by invoice." }
  ]
};

const noIban = {
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
} as const;

async function proposeOnResource(newText: string) {
  const f = await fixture(noIban);
  await applyAtCurrentRevisions(f.store.configAssets, {
    clientInstanceId,
    mutations: [
      {
        type: "upsert",
        scope: f.owner,
        kind: "skill",
        name: skill.name,
        config: json(withResource)
      }
    ]
  });
  const ops: SkillChangeOperation[] = [
    { type: "replace_text", target: "references/payment.md", oldText: "Pay by invoice.", newText }
  ];
  const request = await f.workflow.createRequest(requester, context, {
    kind: "skill_change",
    summary: "Change how to pay.",
    payload: json({
      agentName: f.agent.name,
      skillName: skill.name,
      operations: ops,
      baseSourceVersion: createSkillSourceVersion(withResource),
      preview: createSkillChangePreview(withResource, ops)
    })
  });
  return { f, decided: await f.approve(request.id) };
}

// The runtime snapshot leaves a skill's resources out. The guardrails on asset writes read the
// skill an approval writes, so it is read whole: a change to a resource reaches them.
describe("an approved change to a skill resource and the guardrails on asset writes", () => {
  it("writes a resource change the guardrails let through, with the other parts kept", async () => {
    const { f, decided } = await proposeOnResource("Pay within 14 days.");
    expect(decided).toMatchObject({ status: "approved" });
    expect((await f.revisions()).at(-1)?.config).toMatchObject({
      content: skill.content,
      resources: [{ path: "references/payment.md", content: "Pay within 14 days." }]
    });
  });

  it("refuses a resource change a guardrail blocks", async () => {
    const { f, decided } = await proposeOnResource("Pay to DE89 3704 0044 0532 0130 00.");
    expect(decided).toMatchObject({
      status: "superseded",
      applyResult: { execution: "refused", error: { code: "GUARDRAIL_BLOCKED" } }
    });
    expect(JSON.stringify((await f.revisions()).at(-1)?.config)).not.toContain("3704 0044");
  });
});
