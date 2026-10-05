import { z } from "zod";
import {
  AppError,
  auditActorFromUser,
  isJsonObject,
  unknownToJsonValue,
  type ApprovalRequest,
  type ApprovalRequestContext,
  type ApprovalRequestHandler,
  type AuthenticatedUser,
  type ConfigAssetMutation,
  type ConfigAssetRevisionRecord,
  type JsonObject
} from "@vivd-catalyst/core";
import {
  applySkillChange,
  assertSkillChangeScope,
  createSkillChangePreview,
  skillChangeOperationsSchema,
  skillNameSchema
} from "@vivd-catalyst/config-schema";
import {
  applyValidatedConfigAssetMutations,
  type ConfigAssetWriterOptions
} from "./config-asset-writer";

const previewSchema = z.object({
  skillName: z.string(),
  skillTitle: z.string(),
  isNewSkill: z.boolean(),
  changes: z.array(
    z.object({
      type: z.enum(["replace", "add", "new_resource"]),
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
    async preview(payload, context) {
      const data = validatePayload(payload);
      if (context.status !== "pending") {
        return toJsonObject(data.preview);
      }
      const snapshot = await options.configAssets.source.getSnapshot();
      const skill = snapshot.skills.find((candidate) => candidate.name === data.skillName);
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
      const snapshot = await options.configAssets.source.getSnapshot();
      const skill = snapshot.skills.find((candidate) => candidate.name === data.skillName);
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
    async apply(payload, user, context) {
      const data = validatePayload(payload);
      const snapshot = await loadMutationSnapshot();
      const agent = snapshot.agents.find((candidate) => candidate.name === data.agentName);
      assertSkillChangeScope({
        policy: options.config.administration.agentConfiguration.agentSkillChanges,
        agent,
        skillName: data.skillName,
        operations: data.operations
      });
      const previous = await findProducedRevision(data.skillName, context.requestId);
      if (previous) {
        return revisionResult(data.skillName, previous);
      }
      const current = snapshot.skills.find((candidate) => candidate.name === data.skillName);
      const skill = applySkillChange(current, data.operations);
      const mutations: ConfigAssetMutation[] = [
        { type: "upsert", kind: "skill", name: skill.name, config: toJsonObject(skill) }
      ];
      if (data.operations[0]?.type === "create_skill" && agent) {
        mutations.push({
          type: "upsert",
          kind: "agent",
          name: agent.name,
          config: toJsonObject({
            ...agent,
            skillNames: [...new Set([...agent.skillNames, skill.name])]
          })
        });
      }
      await applyValidatedConfigAssetMutations(options, {
        clientInstanceId: options.clientInstanceId,
        baseVersion: snapshot.version,
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
      const snapshot = await loadMutationSnapshot();
      const history = await listSkillRevisions(data.skillName);
      const applied = findRequestRevision(history, request.id);
      if (!applied) {
        throw new AppError("CONFLICT", "This request has no applied skill revision");
      }
      const latest = history.at(-1);
      // A previous revert may have committed before its request transition failed.
      if (
        latest?.origin?.requestId === request.id &&
        (latest.operation === "revert" || latest.operation === "delete")
      ) {
        return revisionResult(data.skillName, latest);
      }
      if (latest?.id !== applied.id) {
        throw new AppError(
          "CONFLICT",
          `Skill '${data.skillName}' has newer changes; this request can no longer be reverted`
        );
      }
      const mutations: ConfigAssetMutation[] = [];
      if (data.operations[0]?.type === "create_skill") {
        const agent = snapshot.agents.find((candidate) => candidate.name === data.agentName);
        if (agent) {
          mutations.push({
            type: "upsert",
            kind: "agent",
            name: agent.name,
            operation: "revert",
            config: toJsonObject({
              ...agent,
              skillNames: agent.skillNames.filter((name) => name !== data.skillName)
            })
          });
        }
        mutations.push({ type: "delete", kind: "skill", name: data.skillName });
      } else {
        const before = history.find((revision) => revision.revision === applied.revision - 1);
        if (!before?.config) {
          throw new AppError("CONFLICT", "The preceding skill revision cannot be restored");
        }
        mutations.push({
          type: "upsert",
          kind: "skill",
          name: data.skillName,
          operation: "revert",
          config: before.config
        });
      }
      await applyValidatedConfigAssetMutations(options, {
        clientInstanceId: options.clientInstanceId,
        baseVersion: snapshot.version,
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

  async function loadMutationSnapshot() {
    // Read the CAS version before any snapshot data: a concurrent write must
    // invalidate this mutation even if the source uses separate reads internally.
    const state = await store.getConfigAssetState({ clientInstanceId: options.clientInstanceId });
    return { ...(await options.configAssets.source.getSnapshot()), version: state.version };
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

function findRequestRevision(revisions: ConfigAssetRevisionRecord[], requestId: string) {
  return revisions.find(
    (revision) =>
      revision.origin?.requestId === requestId &&
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
