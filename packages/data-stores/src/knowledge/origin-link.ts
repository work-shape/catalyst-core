import { z } from "zod";
import {
  AppError,
  auditActorFromIdentity,
  KNOWLEDGE_BASE_ACTIONS,
  KNOWLEDGE_OPERATION_PREFIX,
  KNOWLEDGE_ORIGIN_LINK_CHANGES,
  knowledgeOriginLinkSchema,
  type KnowledgeDocumentStore,
  type OperationDefinition,
  type OperationResource
} from "@work-shape/catalyst-core";

// `knowledge.<id>.set_origin_link` (right `knowledge_base.write`; DS-6b, spec: Origin link): the
// builder enters, changes or clears where the original of a document added by hand lives, so a
// citation offers it beside the stored copy (check 44). A synced document's link is its
// source's, and a Workflow-fed one's is the Workflow's: both are refused here.
//
// Class C. The link is an address and never a key: `knowledgeOriginLinkSchema` takes only an
// http or https address without a user, a password or a token parameter, so the source's own
// sign-in decides who reaches the original. It is answered only where the Knowledge Base's
// documents are, to holders of `knowledge_base.use`: the document list and a search's passages.
// Every change is audited by document id; the link itself is in no audit row, run answer or log
// line.

/** How long the change may take: one row of the store. */
const SET_ORIGIN_LINK_TIMEOUT_MS = 30_000;

const inputSchema = z.strictObject({
  documentId: z.string().min(1).max(200),
  /** The address of the original; `null` clears it. */
  originLink: knowledgeOriginLinkSchema.nullable()
});

/** What changed, never the link: a run keeps its answer. */
const outputSchema = z.object({
  documentId: z.string(),
  change: z.enum(KNOWLEDGE_ORIGIN_LINK_CHANGES)
});

export function setOriginLinkOperation(knowledgeBase: {
  name: string;
  assetId: string;
  resource: OperationResource;
  store: KnowledgeDocumentStore;
}): OperationDefinition {
  return {
    name: `${KNOWLEDGE_OPERATION_PREFIX}${knowledgeBase.name}.set_origin_link`,
    effect: "changing",
    changeClass: "reversible",
    action: KNOWLEDGE_BASE_ACTIONS.write,
    scope: "data_store_rows:write",
    auth: "principal",
    module: "knowledge",
    timeoutMs: SET_ORIGIN_LINK_TIMEOUT_MS,
    inputSchema,
    outputSchema,
    resource: () => knowledgeBase.resource,
    async execute(input, context) {
      const { documentId, originLink } = inputSchema.parse(input);
      const outcome = await knowledgeBase.store.setOriginLink(
        { documentId, originLink },
        context.runtime.signal
      );
      if (outcome === "missing") {
        throw new AppError("NOT_FOUND", "The document is not in this Knowledge Base.", undefined, {
          exposeMessage: true
        });
      }
      if (outcome === "synced") {
        throw new AppError(
          "CONFLICT",
          "This document comes from a source, which keeps its link to the original.",
          { reason: "knowledge_origin_link_synced" },
          { exposeMessage: true }
        );
      }
      const change = originLink === null ? "cleared" : "set";
      await context.audit.record({
        type: "knowledge_base.origin_link_changed",
        status: "success",
        actor: auditActorFromIdentity(context.actor),
        subject: knowledgeBase.assetId,
        correlationId: context.correlationId,
        metadata: {
          knowledgeBase: knowledgeBase.name,
          documentId,
          change
        }
      });
      return { documentId, change };
    }
  };
}
