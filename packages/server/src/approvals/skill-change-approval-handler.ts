import {
  agentConfigSchema,
  applySkillChange,
  assertSkillChangeScope,
  createSkillChangePreview,
  guardrailFieldOf,
  guardrailStringsOf,
  skillChangeOperationsSchema,
  skillConfigSchema,
  skillNameSchema
} from "@work-shape/catalyst-config-schema";
import {
  AppError,
  CONFIG_ASSET_KINDS,
  INSTANCE_ASSET_SCOPE,
  SKILL_CHANGE_TYPES,
  auditActorFromUser,
  isJsonObject,
  unknownToJsonValue,
  type ApprovalRequest,
  type ApprovalRequestContext,
  type ApprovalRequestHandler,
  type AssetScope,
  type AuthenticatedUser,
  type ConfigAssetMutation,
  type ConfigAssetRevisionRecord,
  type JsonObject
} from "@work-shape/catalyst-core";
import { z } from "zod";
import {
  applyValidatedConfigAssetMutations,
  type ConfigAssetWriterOptions
} from "../assets/config-asset-writer";

const previewSchema = z.object({
  skillName: z.string(),
  skillTitle: z.string(),
  isNewSkill: z.boolean(),
  changes: z.array(
    z.object({
      type: z.enum(SKILL_CHANGE_TYPES),
      target: z.string(),
      sectionHeading: z.string().optional(),
      before: z.string().optional(),
      after: z.string()
    })
  ),
  newSkill: z
    .object({ name: z.string(), title: z.string(), description: z.string(), content: z.string() })
    .optional()
});
const payloadSchema = z
  .object({
    agentName: z.string().min(1),
    skillName: skillNameSchema,
    operations: skillChangeOperationsSchema,
    // Informational proposal-time hash; applicability is checked against the current skill.
    baseSourceVersion: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/u)
      .nullable(),
    preview: previewSchema
  })
  .superRefine((payload, context) => {
    const creation = payload.operations[0]?.type === "create_skill";
    if (creation !== (payload.baseSourceVersion === null)) {
      context.addIssue({
        code: "custom",
        message: "baseSourceVersion must be null only for create_skill"
      });
    }
    if (
      payload.operations[0]?.type === "create_skill" &&
      payload.operations[0].name !== payload.skillName
    ) {
      context.addIssue({ code: "custom", message: "create_skill name must match skillName" });
    }
  });

export function createSkillChangeApprovalHandler(
  options: ConfigAssetWriterOptions
): ApprovalRequestHandler {
  const store = options.configAssets.store;
  return {
    kind: "skill_change",
    requiredPermission: "agent_skills.approve",
    validate(payload) {
      return toJsonObject(validatePayload(payload));
    },
    checkContent(payload) {
      const data = validatePayload(payload);
      return JSON.stringify(
        data.operations.map((operation) => {
          switch (operation.type) {
            case "replace_text":
              return { newText: operation.newText };
            case "append_text":
              return { sectionHeading: operation.sectionHeading, text: operation.text };
            case "create_resource":
              return { content: operation.content };
            case "create_skill":
              return {
                name: operation.name,
                title: operation.title,
                description: operation.description,
                content: operation.content
              };
          }
        })
      );
    },
    async preview(payload, context) {
      const data = validatePayload(payload);
      if (context.status !== "pending") {
        return toJsonObject(data.preview);
      }
      const skill = await options.configAssets.source.getSkill(data.skillName);
      try {
        return toJsonObject(createSkillChangePreview(skill, data.operations));
      } catch {
        return toJsonObject(data.preview);
      }
    },
    async isStale(payload, context) {
      const data = validatePayload(payload);
      // Recover a committed asset write if persisting the approval outcome failed.
      if (await findProducedRevision(data.skillName, context.requestId)) {
        return false;
      }
      const storedAgent = await store.getConfigAsset({
        clientInstanceId: options.clientInstanceId,
        kind: "agent",
        name: data.agentName
      });
      // The proposing agent was deleted or the skill detached from it: the request can never
      // be in scope again, unlike a disabled policy, which stays a refusal.
      const agent =
        storedAgent?.status === "active" ? agentConfigSchema.parse(storedAgent.config) : undefined;
      const creation = data.operations[0]?.type === "create_skill";
      if (!agent || (!creation && !agent.skillNames.includes(data.skillName))) {
        return true;
      }
      const skill = await options.configAssets.source.getSkill(data.skillName);
      try {
        applySkillChange(skill, data.operations);
        return false;
      } catch (error) {
        if (error instanceof AppError && error.code === "VALIDATION_FAILED") {
          return true;
        }
        throw error;
      }
    },
    // The skill as the approval writes it, read by the guardrails on asset writes once more: a
    // guardrail added since the agent proposed it reads it too.
    async applyEvents(payload, context) {
      const data = validatePayload(payload);
      // A change already written, whose approval failed to be recorded, is recovered as it is.
      if (await findProducedRevision(data.skillName, context.requestId)) return [];
      // The skill whole: the snapshot leaves its resources out, and the guardrails read them.
      const current = await options.configAssets.source.getSkill(data.skillName);
      // A change that no longer applies was found stale before this is asked.
      const skill = applySkillChange(current, data.operations);
      return [
        {
          name: "asset.before_write",
          subject: { kind: "skill", name: skill.name },
          checkable: () => ({
            name: skill.name,
            content: guardrailFieldOf(guardrailStringsOf(skill))
          })
        }
      ];
    },
    // The skill as the revert writes it back: the revision before the change, read like a new
    // write. Reverting a created skill deletes it and writes no content.
    async revertEvents(request) {
      const data = validatePayload(request.payload);
      if (data.operations[0]?.type === "create_skill") return [];
      const history = await listSkillRevisions(data.skillName);
      // An undo already written, whose status was not recorded, is recovered as it is.
      if (revertedBy(history, request.id)) return [];
      const applied = findRequestRevision(history, request.id);
      const before =
        applied && history.find((revision) => revision.revision === applied.revision - 1);
      const config = before?.config;
      // Nothing to write back: the revert itself refuses it.
      if (!before || !config) return [];
      return [
        {
          name: "asset.before_write",
          subject: { kind: "skill", id: before.assetId, name: data.skillName },
          checkable: () => ({
            name: data.skillName,
            content: guardrailFieldOf(guardrailStringsOf(config))
          })
        }
      ];
    },
    async isApplied(payload, context) {
      return (
        typeof payload.skillName === "string" &&
        Boolean(await findProducedRevision(payload.skillName, context.requestId))
      );
    },
    async apply(payload, user, context) {
      const data = validatePayload(payload);
      const snapshot = await loadMutationSnapshot(data);
      // Before the scope check: an already committed write is recovered even if the agent or
      // its skill assignment changed since.
      const previous = await findProducedRevision(data.skillName, context.requestId);
      if (previous) {
        return revisionResult(data.skillName, previous);
      }
      const agent = snapshot.agent;
      assertSkillChangeScope({
        policy: options.config.administration.agentConfiguration.agentSkillChanges,
        agent,
        skillName: data.skillName,
        operations: data.operations
      });
      const skill = applySkillChange(snapshot.skill, data.operations);
      const mutations: ConfigAssetMutation[] = [
        {
          type: "upsert",
          kind: "skill",
          name: skill.name,
          scope: snapshot.scopeOf("skill"),
          config: toJsonObject(skill)
        }
      ];
      // An approved request is the review a deleted name needs: it names the tombstone.
      const baseRevisions = { [`skill:${skill.name}`]: snapshot.revisionOf("skill", skill.name) };
      if (data.operations[0]?.type === "create_skill" && agent) {
        baseRevisions[`agent:${agent.name}`] = snapshot.revisionOf("agent", agent.name);
        mutations.push({
          type: "upsert",
          kind: "agent",
          name: agent.name,
          scope: snapshot.scopeOf("agent"),
          config: toJsonObject({
            ...agent,
            skillNames: [...new Set([...agent.skillNames, skill.name])]
          })
        });
      }
      await applyValidatedConfigAssetMutations(options, {
        clientInstanceId: options.clientInstanceId,
        baseRevisions,
        actor: auditActorFromUser(user),
        origin: revisionOrigin(context),
        mutations
      });
      const revision = await findProducedRevision(skill.name, context.requestId);
      if (!revision) {
        throw new AppError("INTERNAL", "Applied skill revision was not found");
      }
      return revisionResult(skill.name, revision);
    },
    async revert(
      request: ApprovalRequest,
      user: AuthenticatedUser,
      context: ApprovalRequestContext
    ) {
      const data = validatePayload(request.payload);
      const snapshot = await loadMutationSnapshot(data);
      const history = await listSkillRevisions(data.skillName);
      const applied = findRequestRevision(history, request.id);
      if (!applied) {
        throw new AppError("CONFLICT", "This request has no applied skill revision");
      }
      const latest = history.at(-1);
      // A previous revert may have committed before its request transition failed.
      if (latest !== undefined && revertedBy(history, request.id)) {
        return revisionResult(data.skillName, latest);
      }
      if (latest?.id !== applied.id) {
        throw new AppError(
          "CONFLICT",
          `Skill '${data.skillName}' has newer changes; this request can no longer be reverted`
        );
      }
      const mutations: ConfigAssetMutation[] = [];
      // The skill is at the revision this request produced, as checked above.
      const baseRevisions = {
        [`skill:${data.skillName}`]: snapshot.revisionOf("skill", data.skillName)
      };
      if (data.operations[0]?.type === "create_skill") {
        const agent = snapshot.agent;
        if (agent) {
          baseRevisions[`agent:${agent.name}`] = snapshot.revisionOf("agent", agent.name);
          mutations.push({
            type: "upsert",
            kind: "agent",
            name: agent.name,
            scope: snapshot.scopeOf("agent"),
            operation: "revert",
            config: toJsonObject({
              ...agent,
              skillNames: agent.skillNames.filter((name) => name !== data.skillName)
            })
          });
        }
        mutations.push({
          type: "delete",
          kind: "skill",
          name: data.skillName,
          scope: snapshot.scopeOf("skill")
        });
      } else {
        const before = history.find((revision) => revision.revision === applied.revision - 1);
        if (!before?.config) {
          throw new AppError("CONFLICT", "The preceding skill revision cannot be restored");
        }
        mutations.push({
          type: "upsert",
          kind: "skill",
          name: data.skillName,
          scope: snapshot.scopeOf("skill"),
          operation: "revert",
          config: before.config
        });
      }
      await applyValidatedConfigAssetMutations(options, {
        clientInstanceId: options.clientInstanceId,
        baseRevisions,
        actor: auditActorFromUser(user),
        origin: revisionOrigin(context),
        mutations
      });
      const reverted = (await listSkillRevisions(data.skillName)).at(-1);
      if (!reverted) {
        throw new AppError("INTERNAL", "Reverted skill revision was not found");
      }
      return revisionResult(data.skillName, reverted);
    }
  };

  async function listSkillRevisions(skillName: string): Promise<ConfigAssetRevisionRecord[]> {
    return store.listConfigAssetRevisions({
      clientInstanceId: options.clientInstanceId,
      kind: "skill",
      name: skillName
    });
  }

  async function findProducedRevision(skillName: string, requestId: string) {
    return findRequestRevision(await listSkillRevisions(skillName), requestId);
  }

  /**
   * The snapshot a change is made from, with the revision of the two assets it may write. The
   * content and revision come from the same stored rows: a write that lands after the read
   * leaves a base the store refuses, so it is never applied to content it did not read.
   */
  async function loadMutationSnapshot(names: { skillName: string; agentName: string }) {
    const read = (kind: (typeof CONFIG_ASSET_KINDS)[number], name: string) =>
      store.getConfigAsset({ clientInstanceId: options.clientInstanceId, kind, name });
    const [skill, agent] = await Promise.all([
      read("skill", names.skillName),
      read("agent", names.agentName)
    ]);
    const revisions = new Map([
      [`skill:${names.skillName}`, skill?.revision ?? null],
      [`agent:${names.agentName}`, agent?.revision ?? null]
    ]);
    return {
      // Mutations use the stored definition, never the degraded runtime copy.
      agent: agent?.status === "active" ? agentConfigSchema.parse(agent.config) : undefined,
      /**
       * The skill whole, with its resources, which the snapshot leaves out: the content of the
       * revision read above, so a change is made from what its base names.
       */
      skill: skill?.status === "active" ? skillConfigSchema.parse(skill.config) : undefined,
      /** The last revision of the asset, a deleted one's included, or `null` for none. */
      revisionOf: (kind: (typeof CONFIG_ASSET_KINDS)[number], name: string) =>
        revisions.get(`${kind}:${name}`) ?? null,
      /**
       * Who owns what the change writes. A skill keeps its owner, a deleted one's included; a
       * skill the change creates is owned by the owner of the agent that proposed it, so the
       * agent names a skill of its own owner.
       */
      scopeOf: (kind: (typeof CONFIG_ASSET_KINDS)[number]): AssetScope =>
        (kind === "skill" ? skill?.scope : undefined) ?? agent?.scope ?? INSTANCE_ASSET_SCOPE
    };
  }
}

function validatePayload(payload: JsonObject) {
  const result = payloadSchema.safeParse(payload);
  if (!result.success) {
    throw new AppError(
      "VALIDATION_FAILED",
      result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
    );
  }
  return result.data;
}

/** Whether the revision was written for this request. */
function appliedBy(revision: ConfigAssetRevisionRecord, requestId: string): boolean {
  return revision.origin?.kind === "approval_request" && revision.origin.requestId === requestId;
}

/** Whether the newest revision is the undo of this request, written by an earlier revert. */
function revertedBy(history: readonly ConfigAssetRevisionRecord[], requestId: string): boolean {
  const latest = history.at(-1);
  return (
    latest !== undefined &&
    appliedBy(latest, requestId) &&
    (latest.operation === "revert" || latest.operation === "delete")
  );
}

function findRequestRevision(revisions: ConfigAssetRevisionRecord[], requestId: string) {
  return revisions.find(
    (revision) =>
      appliedBy(revision, requestId) &&
      revision.operation !== "revert" &&
      revision.operation !== "delete"
  );
}

function revisionOrigin(context: ApprovalRequestContext) {
  return {
    kind: "approval_request" as const,
    requestId: context.requestId,
    summary: context.summary ?? "Skill change"
  };
}

function revisionResult(skillName: string, revision: ConfigAssetRevisionRecord): JsonObject {
  return { skillName, revision: revision.revision, version: revision.globalVersion };
}

function toJsonObject(value: unknown): JsonObject {
  const converted = unknownToJsonValue(value);
  if (!isJsonObject(converted)) {
    throw new AppError("VALIDATION_FAILED", "Expected a JSON object");
  }
  return converted;
}
