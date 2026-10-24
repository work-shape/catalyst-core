import {
  AppError,
  type AgentProposal,
  type ConfigAssetMutation,
  type ClientInstanceId,
  type JsonObject
} from "@work-shape/catalyst-core";
import {
  getAgentProposal,
  removeAgentProposal,
  saveAgentProposal
} from "./postgres-agent-proposal-operations";
import type { PostgresTransaction } from "./postgres-database";

type Upsert = Extract<ConfigAssetMutation, { type: "upsert" }>;

/** Runs inside the asset writer's transaction and lock. Draft and live fences never mix. */
export async function writeAgentDraft(
  tx: PostgresTransaction,
  input: {
    clientInstanceId: ClientInstanceId;
    agentId: string;
    liveRevision: number;
    mutation: Upsert;
    savedAt: string;
  }
): Promise<number | undefined> {
  const { mutation } = input;
  if (!mutation.agentDraft) return undefined;
  const address = { clientInstanceId: input.clientInstanceId, agentId: input.agentId };
  const saved = await saveAgentProposal(tx, {
    ...address,
    ...mutation.agentDraft,
    baseRevision: input.liveRevision,
    config: mutation.config,
    savedAt: input.savedAt
  });
  if (!saved) {
    const draft = await getAgentProposal(tx, address);
    throw new AppError(
      "REVISION_CONFLICT",
      "The agent draft changed. Read it again before saving",
      {
        reason: "draft_changed",
        // A batch writes several agents: the refusal names the one whose draft moved.
        kind: mutation.kind,
        name: mutation.name,
        currentDraftRevision: draft?.revision ?? null,
        ...(draft ? { author: draft.author, changedAt: draft.updatedAt } : {})
      }
    );
  }
  return saved.revision;
}

/** Consume under the same lock as the new live revision; a failure rolls both back. */
export async function consumeAgentDraft(
  tx: PostgresTransaction,
  input: {
    clientInstanceId: ClientInstanceId;
    agentId: string;
    liveRevision: number;
    revision: number;
  }
): Promise<void> {
  const draft = await getAgentProposal(tx, input);
  if (draft?.revision !== input.revision) {
    throw new AppError(
      "REVISION_CONFLICT",
      "The agent draft changed. Read it again before publishing",
      { reason: "draft_changed" }
    );
  }
  if (draft.baseRevision !== input.liveRevision) {
    throw new AppError("CONFLICT", "The live agent changed since the draft was written", {
      reason: "stale_base"
    });
  }
  if (!(await removeAgentProposal(tx, { ...input, revision: draft.revision }))) {
    throw new AppError("REVISION_CONFLICT", "The agent draft changed", { reason: "draft_changed" });
  }
}

/** An approved skill change moves the pending draft's base and applies only that attachment. */
export async function carryAgentSkillChange(
  tx: PostgresTransaction,
  input: {
    clientInstanceId: ClientInstanceId;
    agentId: string;
    revision: number;
    change: { name: string; attached: boolean };
    savedAt: string;
  }
): Promise<void> {
  const draft = await getAgentProposal(tx, input);
  if (!draft) return;
  const names = draft.config.skillNames;
  const existing = Array.isArray(names)
    ? names.filter((name): name is string => typeof name === "string")
    : [];
  const skillNames = input.change.attached
    ? [...new Set([...existing, input.change.name])]
    : existing.filter((name) => name !== input.change.name);
  await carryIntoDraft(tx, input, draft, { ...draft.config, skillNames });
}

/**
 * Tools given to the live agent go into the pending draft too, which keeps its content and its
 * author: publishing it later does not take them away. A draft written on the live revision the
 * give replaced moves onto the new one. A draft that was already behind stays behind, so that
 * its publish cannot undo what went live in between.
 */
export async function carryAgentToolsGiven(
  tx: PostgresTransaction,
  input: {
    clientInstanceId: ClientInstanceId;
    agentId: string;
    /** The live revision the give replaced. */
    replacedRevision: number;
    /** The live revision the give wrote. */
    revision: number;
    toolNames: readonly string[];
    savedAt: string;
  }
): Promise<void> {
  const draft = await getAgentProposal(tx, input);
  if (!draft) return;
  const names = draft.config.toolNames;
  const existing = Array.isArray(names)
    ? names.filter((name): name is string => typeof name === "string")
    : [];
  const toolNames = [...new Set([...existing, ...input.toolNames])];
  await carryIntoDraft(
    tx,
    {
      ...input,
      revision: draft.baseRevision === input.replacedRevision ? input.revision : draft.baseRevision
    },
    draft,
    { ...draft.config, toolNames }
  );
}

/** Saves the draft's new content on the live revision `revision` as its base, by its own author. */
async function carryIntoDraft(
  tx: PostgresTransaction,
  input: { clientInstanceId: ClientInstanceId; agentId: string; revision: number; savedAt: string },
  draft: AgentProposal,
  config: JsonObject
): Promise<void> {
  const saved = await saveAgentProposal(tx, {
    clientInstanceId: input.clientInstanceId,
    agentId: input.agentId,
    savedAt: input.savedAt,
    config,
    baseRevision: input.revision,
    expectedDraftRevision: draft.revision,
    author: draft.author
  });
  if (!saved)
    throw new AppError("REVISION_CONFLICT", "The agent draft changed", { reason: "draft_changed" });
}
