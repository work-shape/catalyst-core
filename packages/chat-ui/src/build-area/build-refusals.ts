import type { TranslationContextValue } from "../i18n";
import { apiErrorCode, apiErrorMessage } from "../workspace-utils";

type Translate = TranslationContextValue["t"];

/** The part of an asset page a refusal is about. A kind names its sections' fields with these. */
export type BuildRefusalField =
  "tools" | "model" | "skills" | "knowledge" | "source" | "availability";

/** What a refused change says, and where on the page it says it. */
interface BuildRefusal {
  /** The field the refusal concerns. Without one it shows above the save bar. */
  field?: BuildRefusalField;
  message: string;
}

/** How a change went. */
export type BuildWriteOutcome =
  | { ok: true }
  /**
   * Somebody saved or deleted the asset after this page loaded it. The page offers the newer
   * version, and names who wrote it and when where the instance said so.
   */
  | ({ ok: false; conflict: true } & BuildConflict)
  | { ok: false; conflict: false; refusals: BuildRefusal[] };

/** What the instance told of the revision a refused write met. */
interface BuildConflict {
  /** The newer revision is the delete of the asset. */
  deleted?: true;
  /** The revision the asset is at, told to a reader of its history. */
  currentRevision?: number;
  changedBy?: string;
  changedAt?: string;
}

/** A write the instance accepted and did not make: somebody else has to approve it first. */
export class PendingApprovalError extends Error {
  constructor() {
    super("The change waits for an approval");
    this.name = "PendingApprovalError";
  }
}

/** The details a refusal of the instance carries, read from an answer nobody vouches for. */
interface RefusalDetails {
  reason?: string;
  toolName?: string;
  modelBindingId?: string;
  namespace?: string;
  issues: { message: string; path: unknown[] }[];
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value) && key in value
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;
}

function text(value: unknown, key: string): string | undefined {
  const found = field(value, key);
  return typeof found === "string" ? found : undefined;
}

/** The reason and the issues a refusal of the instance names in its details. */
export function readRefusalDetails(error: unknown): RefusalDetails {
  const details = field(field(field(error, "payload"), "error"), "details");
  const issues = field(details, "issues");
  return {
    reason: text(details, "reason"),
    toolName: text(details, "toolName"),
    modelBindingId: text(details, "modelBindingId"),
    namespace: text(details, "namespace"),
    issues: (Array.isArray(issues) ? issues : []).flatMap((issue: unknown) => {
      const message = text(issue, "message");
      const path = field(issue, "path");
      return message ? [{ message, path: Array.isArray(path) ? path : [] }] : [];
    })
  };
}

/** The one asset a refused write of this page names, as far as the reader may know it. */
function readConflict(error: unknown): BuildConflict {
  const conflicts = field(field(field(field(error, "payload"), "error"), "details"), "conflicts");
  const [conflict]: unknown[] = Array.isArray(conflicts) ? conflicts : [];
  const changedBy = text(conflict, "changedBy");
  const changedAt = text(conflict, "changedAt");
  const currentRevision = field(conflict, "currentRevision");
  return {
    ...(field(conflict, "deleted") === true ? { deleted: true as const } : {}),
    ...(typeof currentRevision === "number" ? { currentRevision } : {}),
    ...(changedBy === undefined ? {} : { changedBy }),
    ...(changedAt === undefined ? {} : { changedAt })
  };
}

/**
 * What the instance said about a call it refused or could not serve. A call that never got an
 * answer has no such sentence: the page then says in the reader's language what did not work.
 */
export function instanceSentence(error: unknown): string | undefined {
  return apiErrorCode(error) === undefined ? undefined : apiErrorMessage(error, undefined);
}

/** The fields of a definition whose refusal belongs to one field of the page. */
const FIELD_OF_CONFIG_KEY = new Map<string, BuildRefusalField>([
  ["toolNames", "tools"],
  ["skillNames", "skills"],
  ["modelBindingId", "model"],
  ["modelProviderId", "model"],
  ["userSelectableModelBindingIds", "model"],
  ["modelReasoningEfforts", "model"],
  ["reasoningEffort", "model"],
  ["fastMode", "model"],
  ["knowledgeBases", "knowledge"],
  ["backend", "source"],
  ["tables", "source"]
]);

/**
 * Reads a refused change. A refusal from a Namespace's lists names its field and is told in
 * the reader's language; an issue of the definition goes to the field its path names; every
 * other sentence is shown as the instance said it, which includes the one sentence about an
 * asset the reader may not read.
 */
export function readBuildRefusal(error: unknown, t: Translate): BuildWriteOutcome {
  if (apiErrorCode(error) === "REVISION_CONFLICT") {
    return { ok: false, conflict: true, ...readConflict(error) };
  }
  if (error instanceof PendingApprovalError) {
    return refused({ message: t("build.pendingApproval") });
  }
  const details = readRefusalDetails(error);
  const namespace = details.namespace ?? "";
  if (details.reason === "tool_not_allowed" && details.toolName !== undefined) {
    return refused({
      field: "tools",
      message: t("build.refusedTool", { tool: details.toolName, namespace })
    });
  }
  if (details.reason === "model_not_allowed" && details.modelBindingId !== undefined) {
    return refused({
      field: "model",
      message: t("build.refusedModel", { model: details.modelBindingId, namespace })
    });
  }
  if (details.reason === "model_binding_required") {
    return refused({ field: "model", message: t("build.refusedModelRequired", { namespace }) });
  }
  const { issues } = details;
  if (issues.length > 0) {
    return {
      ok: false,
      conflict: false,
      refusals: issues.map((issue) => {
        const concerned = issue.path
          .map((segment) =>
            typeof segment === "string" ? FIELD_OF_CONFIG_KEY.get(segment) : undefined
          )
          .find((candidate) => candidate !== undefined);
        return { ...(concerned ? { field: concerned } : {}), message: issue.message };
      })
    };
  }
  return refused({ message: apiErrorMessage(error, undefined) ?? t("configChangeSaveFailed") });
}

function refused(refusal: BuildRefusal): BuildWriteOutcome {
  return { ok: false, conflict: false, refusals: [refusal] };
}

/** The sentences of a refused change that concern one field, or the ones that concern none. */
export function refusalsOf(
  outcome: BuildWriteOutcome | undefined,
  field: BuildRefusalField | undefined
): string[] {
  if (!outcome || outcome.ok || outcome.conflict) {
    return [];
  }
  return outcome.refusals
    .filter((refusal) => refusal.field === field)
    .map((refusal) => refusal.message);
}
