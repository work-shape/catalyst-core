import {
  AppError,
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
  const config: JsonObject = { ...draft.config, skillNames };
  const saved = await saveAgentProposal(tx, {
    ...input,
    config,
    baseRevision: input.revision,
    expectedDraftRevision: draft.revision,
    author: draft.author
  });
  if (!saved)
    throw new AppError("REVISION_CONFLICT", "The agent draft changed", { reason: "draft_changed" });
}
