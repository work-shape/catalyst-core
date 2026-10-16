import { asConversationId } from "@work-shape/catalyst-core";
import { DeterministicModelProvider } from "@work-shape/catalyst-model-provider";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAssetToolsFixture, OTHER } from "./support/platform-asset-tools";

// The agent's save of an agent that exists is a change proposal, not a live revision (TRY-1a,
// Platform Access check 45): the live agent stays as it is, the save creates or advances the
// Build conversation's proposal, and a read there answers it. A person applies it as their own
// save of the agent, through the rights and the write guardrails, or discards it; a proposal
// whose base is no longer the live revision is refused with `stale_base`. Each case fails
// without the change: the save was refused with `no_draft`.

const AGENT = { kind: "agent", name: "test_agent" };
const liveSchema = z.object({
  revision: z.number(),
  config: z.object({ instructions: z.string() }).loose()
});
const readSchema = z.object({
  revision: z.number(),
  publishedRevision: z.number().optional(),
  shows: z.string(),
  config: z.object({ instructions: z.string() }).loose()
});
const writeSchema = z.object({
  saved: z.boolean(),
  revision: z.number().optional(),
  publishedRevision: z.number().optional(),
  issues: z.array(z.object({ path: z.string(), message: z.string() }).loose()).optional(),
  conflict: z.string().optional()
});
const proposalSchema = z.object({
  proposal: z
    .object({
      agent: z.string(),
      conversationId: z.string(),
      revision: z.number(),
      baseRevision: z.number(),
      liveRevision: z.number(),
      stale: z.boolean(),
      config: z.object({ instructions: z.string() }).loose()
    })
    .nullable()
});
const errorSchema = z.object({
  error: z.object({
    code: z.string(),
    details: z.object({ reason: z.string().optional() }).loose().optional()
  })
});

const idSchema = z.object({ id: z.string() });

describe("an agent's save of an agent that exists", () => {
  beforeAll(() => {
    // Keep the scripted provider's answer, without pacing its words.
    vi.spyOn(DeterministicModelProvider.prototype, "stream").mockImplementation(async function* (
      this: DeterministicModelProvider,
      request
    ) {
      yield { type: "completed", completion: await this.complete(request) };
    });
  });
  afterAll(() => vi.restoreAllMocks());

  async function fixture() {
    // A person may change an agent's instructions outside a release, and nothing else.
    const t = await createAssetToolsFixture("in_process", ["instructions"]);
    const live = async () => {
      const stored = await t.app.stores.configAssets.getConfigAsset({
        clientInstanceId: t.clientInstanceId,
        ...AGENT
      });
      return liveSchema.parse({ revision: stored?.revision, config: stored?.config });
    };
    const proposalCall = (conversationId: string) => ({
      params: { name: AGENT.name, conversationId }
    });
    const proposal = async (conversationId: string, as?: string) =>
      proposalSchema.parse(
        (await t.ok(t.app.call("agents.proposal.get", proposalCall(conversationId), as))).json()
      ).proposal;
    const apply = (conversationId: string, revision: number, as?: string) =>
      t.app.call(
        "agents.proposal.apply",
        { ...proposalCall(conversationId), payload: { revision } },
        as
      );
    const put = async (conversationId: string, instructions: string, expectedRevision: number) => {
      const config = (await live()).config;
      return writeSchema.parse(
        await t.call(conversationId, "platform.assets.put", {
          config: { ...config, instructions },
          expectedRevision
        })
      );
    };
    const converse = async (as?: string) =>
      idSchema.parse((await t.ok(t.converse(AGENT, as))).json()).id;
    return { ...t, live, proposal, proposalCall, apply, put, converse };
  }

  it("writes the conversation's proposal, leaves the agent live as it was, and applies it as the person's save", async () => {
    const t = await fixture();
    const before = await t.live();
    const id = await t.converse();

    // The first save creates the proposal on the live revision; the agent stays as it is.
    const first = await t.put(id, "Proposed once.", before.revision);
    expect(first).toEqual({ saved: true, revision: 1, publishedRevision: before.revision });
    expect(await t.live()).toEqual(before);

    // A read in the conversation answers the proposal as the draft; the save advances it.
    const read = readSchema.parse(await t.call(id, "platform.assets.get"));
    expect(read).toMatchObject({
      revision: 1,
      publishedRevision: before.revision,
      shows: "draft",
      config: { instructions: "Proposed once." }
    });
    expect(await t.put(id, "Proposed twice.", read.revision)).toEqual({
      saved: true,
      revision: 2,
      publishedRevision: before.revision
    });
    // A save on a revision of the proposal that is no longer its newest writes nothing.
    expect(await t.put(id, "Proposed late.", read.revision)).toMatchObject({
      saved: false,
      conflict: "REVISION_CONFLICT"
    });
    // A definition the agent kind refuses is no proposal either.
    const refused = writeSchema.parse(
      await t.call(id, "platform.assets.put", {
        config: { ...before.config, toolNames: "not a list" },
        expectedRevision: 2
      })
    );
    expect(refused.saved).toBe(false);
    expect(refused.issues?.length).toBeGreaterThan(0);
    expect(await t.live()).toEqual(before);

    // The person reads the proposal of their own conversation; another conversation has none,
    // and anybody else is told the conversation is missing.
    expect(await t.proposal(id)).toMatchObject({
      revision: 2,
      baseRevision: before.revision,
      liveRevision: before.revision,
      stale: false,
      config: { instructions: "Proposed twice." }
    });
    expect(await t.proposal(await t.converse())).toBeNull();
    const theirs = await t.app.call("agents.proposal.get", t.proposalCall(id), OTHER);
    expect(theirs.statusCode).toBe(404);
    expect((await t.apply(id, 2, OTHER)).statusCode).toBe(404);

    // Apply names the revision the person read: a newer one is not applied unseen.
    const unseen = await t.apply(id, 1);
    expect(unseen.statusCode).toBe(412);
    expect(errorSchema.parse(unseen.json()).error).toMatchObject({
      code: "REVISION_CONFLICT",
      details: { reason: "proposal_changed" }
    });
    expect(await t.live()).toEqual(before);

    // Apply writes one live revision with the proposal's definition, and the proposal is gone.
    const applied = z.object({ revision: z.number() }).parse((await t.ok(t.apply(id, 2))).json());
    expect(applied.revision).toBe(before.revision + 1);
    expect(await t.live()).toMatchObject({
      revision: before.revision + 1,
      config: { ...before.config, instructions: "Proposed twice." }
    });
    expect(await t.proposal(id)).toBeNull();
    const runs = await t.app.stores.operationRuns.list({ clientInstanceId: t.clientInstanceId });
    // Each Apply is an Operation Run; the one that wrote is done, the refused ones failed.
    expect(
      runs
        .filter((run) => run.operation === "agents.proposal.apply")
        .map((run) => run.status)
        .sort()
    ).toEqual(["done", "failed", "failed"]);
  }, 120_000);

  it("refuses to apply a proposal on a stale base, and the agent's next save bases it anew", async () => {
    const t = await fixture();
    const before = await t.live();
    const id = await t.converse();
    expect(await t.put(id, "Proposed.", before.revision)).toMatchObject({ saved: true });

    // The person saves the agent meanwhile: the proposal's base is no longer the live revision.
    await t.ok(
      t.app.call("assets.put", {
        params: AGENT,
        payload: {
          config: { ...before.config, instructions: "Saved by a person." },
          expectedRevision: before.revision
        }
      })
    );
    expect(await t.proposal(id)).toMatchObject({ stale: true, liveRevision: before.revision + 1 });
    const stale = await t.apply(id, 1);
    expect(stale.statusCode).toBe(409);
    expect(errorSchema.parse(stale.json()).error).toMatchObject({
      code: "CONFLICT",
      details: { reason: "stale_base" }
    });
    expect((await t.live()).config.instructions).toBe("Saved by a person.");

    // The agent reads the agent as it runs now, and its save makes the proposal on that.
    const read = readSchema.parse(await t.call(id, "platform.assets.get"));
    expect(read).toMatchObject({
      revision: before.revision + 1,
      config: { instructions: "Saved by a person." }
    });
    expect(await t.put(id, "Proposed again.", read.revision)).toEqual({
      saved: true,
      revision: 2,
      publishedRevision: before.revision + 1
    });
    expect(await t.proposal(id)).toMatchObject({ stale: false, baseRevision: before.revision + 1 });
    await t.ok(t.apply(id, 2));
    expect((await t.live()).config.instructions).toBe("Proposed again.");
  }, 120_000);

  it("applies through the write guardrails and the write right, and discards on the person's click", async () => {
    const t = await fixture();
    const before = await t.live();
    const id = await t.converse();
    const iban = "Pay to DE12345678901234567890.";
    expect(await t.put(id, iban, before.revision)).toMatchObject({ saved: true, revision: 1 });

    // A guardrail on agent writes published since then holds the Apply: nothing goes live.
    const guardrail = { kind: "guardrail", name: "no-iban-in-agents" };
    const written = z.object({ revision: z.number() }).parse(
      (
        await t.ok(
          t.app.call("assets.put", {
            params: guardrail,
            payload: {
              config: {
                name: guardrail.name,
                displayName: "No IBAN in agents",
                on: "asset.before_write",
                filter: { kind: "agent" },
                check: { kind: "pattern", pattern: "DE\\d{20}", reason: "Agents hold no IBAN." },
                outcome: "block"
              },
              expectedRevision: null
            }
          })
        )
      ).json()
    );
    await t.ok(
      t.app.call("assets.publish", { params: guardrail, payload: { revision: written.revision } })
    );
    const blocked = await t.apply(id, 1);
    expect(blocked.statusCode).toBe(403);
    expect(errorSchema.parse(blocked.json()).error.code).toBe("GUARDRAIL_BLOCKED");
    expect(await t.live()).toEqual(before);
    expect(await t.proposal(id)).toMatchObject({ revision: 1 });

    // Discard drops the proposal; the agent stays as it is.
    expect((await t.ok(t.app.call("agents.proposal.discard", t.proposalCall(id)))).json()).toEqual({
      discarded: true
    });
    expect(await t.proposal(id)).toBeNull();
    expect((await t.app.call("agents.proposal.discard", t.proposalCall(id))).statusCode).toBe(404);
    expect(await t.live()).toEqual(before);

    // A person who wrote a proposal under a grant of the write right applies it only while they
    // hold it.
    const agent = await t.app.stores.configAssets.getConfigAsset({
      clientInstanceId: t.clientInstanceId,
      ...AGENT
    });
    const grant = async (action: string) =>
      idSchema.parse(
        (
          await t.ok(
            t.app.call("permissions.grant", {
              payload: {
                holderKind: "user",
                holderId: other?.id,
                action,
                scopeKind: "asset",
                scopeId: agent?.id
              }
            })
          )
        ).json()
      ).id;
    // Their first call makes them a known user, to whom a grant is made.
    await t.ok(t.app.call("me.get", {}, OTHER));
    const users = await t.app.stores.users.listUsers({ clientInstanceId: t.clientInstanceId });
    const other = users.find((user) => user.displayLabel === "Other");
    await grant("agent.read");
    const write = await grant("agent.write");
    const theirs = await t.converse(OTHER);
    const saved = writeSchema.parse(
      JSON.parse(
        (
          await t.say(
            theirs,
            `/tool platform.assets.put ${JSON.stringify({
              config: { ...before.config, instructions: "Theirs." },
              expectedRevision: before.revision
            })}`,
            OTHER
          )
        ).answer ?? "null"
      )
    );
    expect(saved).toMatchObject({ saved: true, revision: 1 });
    await t.ok(t.app.call("permissions.revoke", { params: { grantId: write } }));
    const unentitled = await t.apply(theirs, 1, OTHER);
    expect(unentitled.statusCode).toBe(403);
    expect(await t.live()).toEqual(before);
  }, 120_000);

  it("never applies a proposal the person did not read, also after a discard", async () => {
    const t = await fixture();
    const before = await t.live();
    const id = await t.converse();
    // The person reads proposal A and discards it; the agent then proposes B.
    expect(await t.put(id, "Proposal A.", before.revision)).toMatchObject({ saved: true });
    const read = await t.proposal(id);
    expect(read).toMatchObject({ config: { instructions: "Proposal A." } });
    await t.ok(t.app.call("agents.proposal.discard", t.proposalCall(id)));
    const second = await t.put(id, "Proposal B.", before.revision);
    expect(second).toMatchObject({ saved: true });
    expect(second.revision).not.toBe(read?.revision);

    // Applying the revision of A, which the person read, does not put B live.
    const unread = await t.apply(id, read?.revision ?? 0);
    expect(unread.statusCode).toBe(412);
    expect(errorSchema.parse(unread.json()).error).toMatchObject({
      code: "REVISION_CONFLICT",
      details: { reason: "proposal_changed" }
    });
    expect(await t.live()).toEqual(before);
    await t.ok(t.apply(id, second.revision ?? 0));
    expect((await t.live()).config.instructions).toBe("Proposal B.");
  }, 120_000);

  it("holds proposals and saves to the fields a person may change outside a release", async () => {
    const t = await fixture();
    const before = await t.live();
    // A person's own save of the instructions alone is allowed: the fields the agent's
    // definition fills in when it is read, such as its skills, are no change.
    const written = await t.app.call("assets.put", {
      params: AGENT,
      payload: {
        config: { ...before.config, instructions: "Saved by a person." },
        expectedRevision: before.revision
      }
    });
    expect(written.statusCode, written.body).toBe(200);
    const live = await t.live();
    // A change of a field the list leaves out is still refused (asset-kind-registry.test.ts).
    const prompts = await t.app.call("assets.put", {
      params: AGENT,
      payload: {
        config: { ...live.config, initialPrompts: [{ title: "Start", prompt: "Start here." }] },
        expectedRevision: live.revision
      }
    });
    expect(prompts.statusCode, prompts.body).toBe(403);
    expect(prompts.body).toContain("initialPrompts");

    // The agent is told at once which field its proposal may not change, and nothing is saved.
    const id = await t.converse();
    const refused = writeSchema.parse(
      await t.call(id, "platform.assets.put", {
        config: { ...live.config, initialPrompts: [{ title: "Start", prompt: "Start here." }] },
        expectedRevision: live.revision
      })
    );
    expect(refused.saved).toBe(false);
    expect(JSON.stringify(refused.issues)).toContain("initialPrompts");
    expect(await t.proposal(id)).toBeNull();
    expect(await t.live()).toEqual(live);
  }, 120_000);

  it("removes a conversation's proposals with its other data when it is deleted", async () => {
    const t = await fixture();
    const before = await t.live();
    const id = await t.converse();
    expect(await t.put(id, "Proposed.", before.revision)).toMatchObject({ saved: true });
    const agent = await t.app.stores.configAssets.getConfigAsset({
      clientInstanceId: t.clientInstanceId,
      ...AGENT
    });
    const stored = () =>
      t.app.stores.agentProposals.get({
        clientInstanceId: t.clientInstanceId,
        agentId: agent?.id ?? "",
        source: { kind: "conversation", conversationId: asConversationId(id) }
      });
    expect(await stored()).toMatchObject({ revision: 1 });
    await t.ok(t.app.call("conversations.delete", { params: { conversationId: id } }));
    expect(await stored()).toBeUndefined();
    expect(await t.live()).toEqual(before);
  }, 120_000);
});
