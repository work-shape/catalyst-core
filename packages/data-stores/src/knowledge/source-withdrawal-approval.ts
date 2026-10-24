import { knowledgeBaseDefinitionSchema } from "./definition";
import { sourceBoundaryKey } from "./source-boundary";
import { z } from "zod";
import {
  AppError,
  KNOWLEDGE_BASE_ACTIONS,
  knowledgeSyncJob,
  knowledgeSyncJobPayloadSchema,
  knowledgeSourceKey,
  type ApprovalRequestHandler,
  type ApprovalRequestContext,
  type JsonObject,
  type ClientInstanceId,
  type PlatformStores
} from "@work-shape/catalyst-core";

export const SOURCE_WITHDRAWAL_APPROVAL = "knowledge_source_withdrawal";
const schema = knowledgeSyncJobPayloadSchema.extend({
  boundaryKey: z.string().length(64),
  subject: z.object({
    kind: z.literal("knowledge_base"),
    assetId: z.string(),
    syncRunId: z.string(),
    name: z.string(),
    workspaceId: z.string().optional()
  }),
  withdrawn: z.number(),
  total: z.number()
});

/** Reusable by connector reconciliation and Workflow-fed complete passes. The decision
 * only wakes the existing job; it never acquires an owned-store connection under the Inbox lock. */
export function createSourceWithdrawalApproval(
  stores: PlatformStores,
  clientInstanceId: ClientInstanceId
): ApprovalRequestHandler {
  async function wake(payload: JsonObject, context: ApprovalRequestContext) {
    if (!context.transaction)
      throw new AppError("INTERNAL", "Withdrawal decisions require a transaction");
    const { knowledgeBaseId, sourceId, syncRunId, operationRunId } = schema.parse(payload);
    await context.transaction.jobs.enqueue(
      knowledgeSyncJob,
      { knowledgeBaseId, sourceId, syncRunId, operationRunId },
      {
        clientInstanceId,
        subject: knowledgeBaseId,
        concurrencyKey: knowledgeSourceKey(knowledgeBaseId, sourceId)
      }
    );
  }
  return {
    kind: SOURCE_WITHDRAWAL_APPROVAL,
    requiredPermission: KNOWLEDGE_BASE_ACTIONS.publish,
    resourceOf: (payload) => schema.parse(payload).subject,
    async reviewableSubjects(access) {
      const assets = await stores.configAssets.listActiveConfigAssets({
        clientInstanceId,
        kind: "knowledge_base"
      });
      return assets
        .map((asset) => ({
          kind: "knowledge_base",
          assetId: asset.id,
          name: asset.name,
          ...(asset.scope.kind === "workspace" ? { workspaceId: asset.scope.workspaceId } : {})
        }))
        .filter((subject) => access.authorize(KNOWLEDGE_BASE_ACTIONS.publish, subject).allowed);
    },
    validate: (payload) => schema.parse(payload),
    preview: async (payload) => {
      const parsed = schema.parse(payload);
      return {
        knowledgeBase: parsed.subject.name,
        source: parsed.sourceId,
        withdrawn: parsed.withdrawn,
        total: parsed.total
      };
    },
    async isStale(payload, context) {
      const parsed = schema.parse(payload);
      const asset = await (context.transaction?.configAssets ?? stores.configAssets).getConfigAsset(
        { clientInstanceId, kind: "knowledge_base", name: parsed.subject.name }
      );
      if (!asset || asset.status !== "active" || asset.id !== parsed.knowledgeBaseId) return true;
      // A Workflow-fed source has no boundary in the definition: its pass is its own.
      if (parsed.sourceId.startsWith("workflow:")) return false;
      const source = knowledgeBaseDefinitionSchema
        .parse(asset.publishedConfig)
        .sources?.find((source) => source.id === parsed.sourceId);
      return !source || sourceBoundaryKey(source) !== parsed.boundaryKey;
    },
    async apply(payload, _user, context) {
      await wake(payload, context);
      return { queued: true };
    },
    declined: (payload, _decision, context) => wake(payload, context)
  };
}
