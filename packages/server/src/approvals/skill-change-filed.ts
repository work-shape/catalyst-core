import {
  AppError,
  isFileSetId,
  isJsonObject,
  unknownToJsonValue,
  type ApprovalRequest,
  type ApprovalRequestContext,
  type ApprovalRequestHandler,
  type AuthenticatedUser,
  type ConfigAssetRecord,
  type ConfigAssetRevisionRecord,
  type FileSetId,
  type JsonObject,
  type OperationBeforeEvent,
  auditActorFromUser
} from "@work-shape/catalyst-core";
import {
  guardrailFieldOf,
  guardrailStringsOf,
  skillNameSchema
} from "@work-shape/catalyst-config-schema";
import { z } from "zod";
import {
  applyValidatedConfigAssetMutations,
  type ConfigAssetWriterOptions
} from "../assets/config-asset-writer";
import { revisionText } from "../guardrails/asset-guardrail-events";
import { scopeOfWorkspace, skillApproveResource } from "./skill-approval";

export const SKILL_CHANGE_KIND = "skill_change";

/** The handler of an agent's proposal, which names what a filed change does in its own way. */
export type AgentSkillChangeHandler = ApprovalRequestHandler &
  Required<Pick<ApprovalRequestHandler, "resourceOf" | "preview" | "revert">>;

/** The longest text of one file a filed change's preview holds. The revision holds it whole. */
const PREVIEW_TEXT_MAX_CHARS = 20_000;

const filedChangeSchema = z.object({
  skillName: skillNameSchema,
  /**
   * The whole skill as a person, a key or a release wrote it (SKILL-LIVE-1): every changed file
   * in the one revision an approval writes. An agent's change names operations instead.
   */
  proposed: z.object({
    config: z.record(z.string(), z.unknown()),
    fileSetId: z
      .custom<FileSetId>((value) => typeof value === "string" && isFileSetId(value))
      .optional(),
    baseRevision: z.number().int().positive(),
    operation: z.literal("revert").optional()
  }),
  preview: z.record(z.string(), z.unknown()),
  subject: z.object({ skillAssetId: z.string().min(1), workspaceId: z.string().min(1).nullable() })
});
type FiledChange = z.infer<typeof filedChangeSchema>;

/** A request's change as filed by a write, or nothing where an agent proposed it. */
export function filedSkillChangeOf(payload: unknown): FiledChange | undefined {
  const parsed = filedChangeSchema.safeParse(payload);
  return parsed.success ? parsed.data : undefined;
}

function isFiledPayload(payload: JsonObject): boolean {
  return "proposed" in payload;
}

function toJsonObject(value: unknown): JsonObject {
  const converted = unknownToJsonValue(value);
  if (!isJsonObject(converted)) throw new AppError("VALIDATION_FAILED", "Expected a JSON object");
  return converted;
}

function clipped(text: string): string {
  return text.length <= PREVIEW_TEXT_MAX_CHARS ? text : `${text.slice(0, PREVIEW_TEXT_MAX_CHARS)}…`;
}

const previewConfigSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  summary: z.string().optional(),
  content: z.string().optional(),
  resources: z.array(z.object({ path: z.string(), content: z.string() })).optional(),
  files: z.array(z.object({ path: z.string(), sha256: z.string(), bytes: z.number() })).optional()
});

/** A definition as the preview compares it. One its shape does not fit reads as empty. */
function comparable(config: unknown) {
  const parsed = previewConfigSchema.safeParse(config);
  return parsed.success ? parsed.data : {};
}

/**
 * What the change does, file by file, for who decides it: the texts before and after, and a file
 * that holds no text by its name and size.
 */
function previewOf(live: ConfigAssetRecord, config: JsonObject): JsonObject {
  const before = comparable(live.config);
  const after = comparable(config);
  const changes: JsonObject[] = [];
  for (const field of ["title", "description", "summary"] as const) {
    if ((before[field] ?? "") !== (after[field] ?? ""))
      changes.push({
        type: "replace",
        target: "root",
        sectionHeading: field,
        before: before[field] ?? "",
        after: after[field] ?? ""
      });
  }
  if ((before.content ?? "") !== (after.content ?? ""))
    changes.push({
      type: "replace",
      target: "root",
      before: clipped(before.content ?? ""),
      after: clipped(after.content ?? "")
    });
  const textsBefore = new Map((before.resources ?? []).map((file) => [file.path, file.content]));
  const textsAfter = new Map((after.resources ?? []).map((file) => [file.path, file.content]));
  for (const [path, text] of textsAfter) {
    const earlier = textsBefore.get(path);
    if (earlier === undefined)
      changes.push({ type: "new_resource", target: path, after: clipped(text) });
    else if (earlier !== text)
      changes.push({
        type: "replace",
        target: path,
        before: clipped(earlier),
        after: clipped(text)
      });
  }
  for (const [path, text] of textsBefore) {
    if (!textsAfter.has(path))
      changes.push({ type: "replace", target: path, before: clipped(text), after: "" });
  }
  const filesBefore = new Map((before.files ?? []).map((file) => [file.path, file]));
  const filesAfter = new Map((after.files ?? []).map((file) => [file.path, file]));
  const sizeOf = (file: { path: string; bytes: number }) =>
    `${file.path} (${String(file.bytes)} bytes)`;
  for (const [path, file] of filesAfter) {
    if (textsAfter.has(path)) continue;
    const earlier = filesBefore.get(path);
    if (earlier === undefined)
      changes.push({ type: "new_resource", target: path, after: sizeOf(file) });
    else if (earlier.sha256 !== file.sha256)
      changes.push({ type: "replace", target: path, before: sizeOf(earlier), after: sizeOf(file) });
  }
  for (const [path, file] of filesBefore) {
    if (!filesAfter.has(path) && !textsBefore.has(path))
      changes.push({ type: "replace", target: path, before: sizeOf(file), after: "" });
  }
  return toJsonObject({
    skillName: live.name,
    skillTitle: after.title ?? before.title ?? live.name,
    isNewSkill: false,
    changes
  });
}

/** The payload of a filed change: the whole skill, what it was made from and what it changes. */
export function filedSkillChangePayload(
  live: ConfigAssetRecord,
  config: JsonObject,
  write: { fileSetId?: string; operation?: "revert" }
): JsonObject {
  return toJsonObject({
    skillName: live.name,
    proposed: {
      config,
      ...(write.fileSetId === undefined ? {} : { fileSetId: write.fileSetId }),
      baseRevision: live.revision,
      ...(write.operation === undefined ? {} : { operation: write.operation })
    },
    preview: previewOf(live, config),
    subject: {
      skillAssetId: live.id,
      workspaceId: live.scope.kind === "workspace" ? live.scope.workspaceId : null
    }
  });
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

function parse(payload: JsonObject): FiledChange {
  const parsed = filedChangeSchema.safeParse(payload);
  if (!parsed.success)
    throw new AppError(
      "VALIDATION_FAILED",
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
    );
  return parsed.data;
}

/**
 * The part of a `skill_change` request that a write filed rather than an agent proposed
 * (SKILL-LIVE-1). The handler of the kind hands such a request here: the same people decide it,
 * through the same guardrails, and an approval writes the whole change as one live revision.
 */
function filedChangeOperations(options: ConfigAssetWriterOptions) {
  const store = options.configAssets.store;
  const read = (name: string) =>
    store.getConfigAsset({ clientInstanceId: options.clientInstanceId, kind: "skill", name });
  const history = (name: string) =>
    store.listConfigAssetRevisions({
      clientInstanceId: options.clientInstanceId,
      kind: "skill",
      name
    });
  const appliedBy = (revision: ConfigAssetRevisionRecord, requestId: string) =>
    revision.origin?.kind === "approval_request" && revision.origin.requestId === requestId;
  const applied = async (name: string, requestId: string) =>
    (await history(name)).find(
      (revision) =>
        appliedBy(revision, requestId) &&
        (revision.operation === "update" || revision.operation === "create")
    );
  /** The skill's events on what the revision holds: the same on a filing's approval as on a save. */
  const events = async (
    live: Pick<ConfigAssetRecord, "id" | "name" | "scope">,
    config: JsonObject,
    fileSetId: FileSetId | undefined,
    publish: boolean
  ): Promise<OperationBeforeEvent[]> => {
    const parsed = comparable(config);
    const write: OperationBeforeEvent = {
      name: "asset.before_write",
      subject: {
        kind: "skill",
        id: live.id,
        name: live.name,
        ...(parsed.title === undefined ? {} : { title: parsed.title })
      },
      checkable: async () => ({
        name: live.name,
        content: fileSetId
          ? await revisionText(options, { assetId: live.id, fileSetId, config })
          : guardrailFieldOf(guardrailStringsOf(config))
      })
    };
    if (!publish) return [write];
    return [
      write,
      {
        ...write,
        name: "skill.before_publish",
        subject: {
          ...write.subject,
          ...(live.scope.kind === "workspace" ? { workspaceId: live.scope.workspaceId } : {})
        }
      }
    ];
  };
  return {
    resourceOf: (data: FiledChange) =>
      skillApproveResource(
        data.skillName,
        scopeOfWorkspace(data.subject.workspaceId),
        data.subject.skillAssetId
      ),
    checkContent: (data: FiledChange) => JSON.stringify(guardrailStringsOf(data.proposed.config)),
    async isStale(data: FiledChange, requestId: string) {
      if (await applied(data.skillName, requestId)) return false;
      const live = await read(data.skillName);
      return (
        live?.status !== "active" ||
        live.id !== data.subject.skillAssetId ||
        live.revision !== data.proposed.baseRevision
      );
    },
    async applyEvents(data: FiledChange, requestId: string) {
      if (await applied(data.skillName, requestId)) return [];
      const live = await read(data.skillName);
      if (live?.status !== "active") return [];
      return events(live, toJsonObject(data.proposed.config), data.proposed.fileSetId, true);
    },
    async apply(data: FiledChange, user: AuthenticatedUser, context: ApprovalRequestContext) {
      const previous = await applied(data.skillName, context.requestId);
      if (previous) return revisionResult(data.skillName, previous);
      const live = await read(data.skillName);
      if (live?.status !== "active" || live.revision !== data.proposed.baseRevision)
        throw new AppError("CONFLICT", "The live skill changed since the change was filed", {
          reason: "stale_base"
        });
      await applyValidatedConfigAssetMutations(options, {
        clientInstanceId: options.clientInstanceId,
        baseRevisions: { [`skill:${live.name}`]: live.revision },
        actor: auditActorFromUser(user),
        origin: revisionOrigin(context),
        mutations: [
          {
            type: "upsert",
            kind: "skill",
            name: live.name,
            scope: live.scope,
            config: toJsonObject(data.proposed.config),
            ...(data.proposed.fileSetId === undefined ? {} : { fileSetId: data.proposed.fileSetId })
          }
        ]
      });
      const revision = await applied(live.name, context.requestId);
      if (!revision) throw new AppError("INTERNAL", "Applied skill revision was not found");
      return revisionResult(live.name, revision);
    },
    /** The revision the request replaced: what an undo of the approval writes back. */
    async undoEvents(data: FiledChange, requestId: string) {
      const revisions = await history(data.skillName);
      const made = revisions.find(
        (revision) => appliedBy(revision, requestId) && revision.operation !== "revert"
      );
      const before = made && revisions.find((one) => one.revision === made.revision - 1);
      const live = await read(data.skillName);
      if (!before?.config || live?.status !== "active") return [];
      return events(live, before.config, before.fileSetId, false);
    },
    async revert(data: FiledChange, user: AuthenticatedUser, request: ApprovalRequest) {
      const revisions = await history(data.skillName);
      const made = revisions.find(
        (revision) => appliedBy(revision, request.id) && revision.operation !== "revert"
      );
      if (!made) throw new AppError("CONFLICT", "This request has no applied skill revision");
      const latest = revisions.at(-1);
      if (latest?.operation === "revert" && appliedBy(latest, request.id))
        return revisionResult(data.skillName, latest);
      if (latest?.id !== made.id)
        throw new AppError(
          "CONFLICT",
          `Skill '${data.skillName}' has newer changes; this request can no longer be reverted`
        );
      const before = revisions.find((one) => one.revision === made.revision - 1);
      const live = await read(data.skillName);
      if (!before?.config || live?.status !== "active")
        throw new AppError("CONFLICT", "The preceding skill revision cannot be restored");
      await applyValidatedConfigAssetMutations(options, {
        clientInstanceId: options.clientInstanceId,
        baseRevisions: { [`skill:${data.skillName}`]: live.revision },
        actor: auditActorFromUser(user),
        origin: {
          kind: "approval_request",
          requestId: request.id,
          summary: request.summary
        },
        mutations: [
          {
            type: "upsert",
            kind: "skill",
            name: data.skillName,
            scope: live.scope,
            operation: "revert",
            config: before.config,
            ...(before.fileSetId ? { fileSetId: before.fileSetId } : {})
          }
        ]
      });
      const reverted = (await history(data.skillName)).at(-1);
      if (!reverted) throw new AppError("INTERNAL", "Reverted skill revision was not found");
      return revisionResult(data.skillName, reverted);
    }
  };
}

/**
 * The kind's handler for both forms of a request: an agent's proposal as `proposal` handles it,
 * and a filed change here. A request is one form for its whole life, by the payload it was filed
 * with.
 */
export function withFiledSkillChanges(
  options: ConfigAssetWriterOptions,
  proposal: AgentSkillChangeHandler
): ApprovalRequestHandler {
  const filed = filedChangeOperations(options);
  const stored = (payload: JsonObject) => toJsonObject(parse(payload));
  return {
    ...proposal,
    resourceOf: (payload) =>
      isFiledPayload(payload) ? filed.resourceOf(parse(payload)) : proposal.resourceOf(payload),
    validate: (payload) => (isFiledPayload(payload) ? stored(payload) : proposal.validate(payload)),
    filedPayload: async (payload) =>
      isFiledPayload(payload)
        ? stored(payload)
        : ((await proposal.filedPayload?.(payload)) ?? payload),
    checkContent: (payload) =>
      isFiledPayload(payload)
        ? filed.checkContent(parse(payload))
        : (proposal.checkContent?.(payload) ?? ""),
    preview: async (payload, context) =>
      isFiledPayload(payload)
        ? toJsonObject(parse(payload).preview)
        : proposal.preview(payload, context),
    isStale: async (payload, context) =>
      isFiledPayload(payload)
        ? filed.isStale(parse(payload), context.requestId)
        : ((await proposal.isStale?.(payload, context)) ?? false),
    applyEvents: async (payload, context) =>
      isFiledPayload(payload)
        ? filed.applyEvents(parse(payload), context.requestId)
        : ((await proposal.applyEvents?.(payload, context)) ?? []),
    revertEvents: async (request, context) =>
      isFiledPayload(request.payload)
        ? filed.undoEvents(parse(request.payload), request.id)
        : ((await proposal.revertEvents?.(request, context)) ?? []),
    apply: async (payload, user, context) =>
      isFiledPayload(payload)
        ? filed.apply(parse(payload), user, context)
        : proposal.apply(payload, user, context),
    revert: async (request, user, context) =>
      isFiledPayload(request.payload)
        ? filed.revert(parse(request.payload), user, request)
        : proposal.revert(request, user, context)
  };
}
