import { z } from "zod";
import { configAssetConfigSchema } from "./configuration";
import { conversationSchema } from "./conversations";
import { timestampSchema } from "./shared";

// The pending change proposal of an agent (TRY-1a): what the agent of a Build conversation saved
// for an agent that exists, which a person applies or discards. Applying is the person's own save
// of the agent; a proposal based on a revision that is no longer the agent's live one is stale
// and is not applied.

const revisionNumberSchema = z.number().int().positive();

export const agentProposalSchema = z.object({
  /** The agent, by name. */
  agent: z.string(),
  /** The Build conversation whose agent wrote the proposal. */
  conversationId: z.string(),
  /** The proposal's newest revision: the one Apply writes, and names. */
  revision: revisionNumberSchema,
  /** The agent's live revision the proposal is based on. */
  baseRevision: revisionNumberSchema,
  /** The agent's live revision now. */
  liveRevision: revisionNumberSchema,
  /** The live revision is another than the base: Apply refuses with `stale_base`. */
  stale: z.boolean(),
  /** The whole definition of the agent as proposed. */
  config: configAssetConfigSchema,
  updatedAt: timestampSchema
});

export const agentProposalResponseSchema = z.object({
  /** Empty where the conversation has no pending proposal for the agent. */
  proposal: agentProposalSchema.nullable()
});

export const applyAgentProposalRequestSchema = z.object({
  /** The proposal's revision the person read. A newer one is refused, not applied unseen. */
  revision: revisionNumberSchema
});

export const discardAgentProposalResponseSchema = z.object({ discarded: z.literal(true) });

// The Try conversation beside a Build conversation (TRY-1b): the person tries the agent under
// construction there. No conversation list shows it, and its usage is marked `preview`.
export const agentTryConversationResponseSchema = z.object({
  conversation: conversationSchema,
  /** A Try conversation is a preview: its head says so. */
  preview: z.literal(true)
});
