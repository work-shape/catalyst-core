import type { LocaleCode } from "@work-shape/catalyst-api-client";
import { EGRESS_DENIED } from "@work-shape/catalyst-core";
import type { TranslationContextValue, TranslationKey } from "../../shared/i18n";
import { formatFileBytes } from "./skill-form-model";
import { apiErrorCode, apiErrorMessage } from "../../shared/workspace-utils";

type Translate = TranslationContextValue["t"];

/** The part of an asset page a refusal is about. A kind names its sections' fields with these. */
export type BuildRefusalField =
  "tools" | "model" | "skills" | "knowledge" | "source" | "availability" | "files";

/** What a refused change says, and where on the page it says it. */
interface BuildRefusal {
  /** The field the refusal concerns. Without one it shows above the save bar. */
  field?: BuildRefusalField;
  message: string;
  /**
   * The instance's own sentence where the page told a refusal in its own words. It is written
   * for the operator and may name release config, so only an administrator is shown it.
   */
  detail?: string;
  /** The message is the instance's sentence as it came, in the instance's words. */
  asSent?: true;
  /** Nothing is refused: the change waits for somebody's approval. */
  waiting?: true;
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
  /**
   * The agent's draft is not the one the page read: somebody saved a newer draft, or
   * published or discarded it. The live agent may be as the page read it.
   */
  draft?: true;
  /** The newer revision is the delete of the asset. */
  deleted?: true;
  /** The revision the asset is at, told to a reader of its history. */
  currentRevision?: number;
  changedBy?: string;
  changedAt?: string;
}

/** A write the instance accepted and did not make: somebody else has to approve it first. */
export class PendingApprovalError extends Error {
  /** People who may approve it, by name, as far as the writer may see them. */
  readonly approverNames: readonly string[];

  constructor(approverNames: readonly string[] = []) {
    super("The change waits for an approval");
    this.name = "PendingApprovalError";
    this.approverNames = approverNames;
  }
}

/** The names the instance gives in the preview of a waiting request of who may approve it. */
export function approverNamesOf(preview: unknown): string[] {
  const names = field(preview, "approverNames");
  return Array.isArray(names)
    ? names.filter((name): name is string => typeof name === "string" && name.trim() !== "")
    : [];
}

/** The details a refusal of the instance carries, read from an answer nobody vouches for. */
interface RefusalDetails {
  reason?: string;
  toolName?: string;
  modelBindingId?: string;
  namespace?: string;
  /** The file of a folder a refusal names. */
  path?: string;
  /** The file a refused path lies below, where a path is a file and a folder at once. */
  folder?: string;
  /** The limit a refusal names, and what the write had of it. */
  limit?: number;
  actual?: number;
  /** The guardrail that blocked the write, by its title, and its reason as its author wrote it. */
  guardrailTitle?: string;
  guardrailReason?: string;
  issues: RefusalIssue[];
}

/** One issue of a refused definition: the instance's sentence, its place and its code. */
interface RefusalIssue {
  message: string;
  path: unknown[];
  /** The fixed code of the check that found it, where the check names one. */
  code?: string;
}

/**
 * The issues the reader is told in their own language: what happened and who changes it. The
 * instance's sentence names release config keys, which a builder cannot act on.
 */
const ISSUE_SENTENCES: Readonly<Record<string, TranslationKey>> = {
  [EGRESS_DENIED]: "build.refusedEgress",
  read_only_origin: "build.refusedReadOnlyOrigin"
};

/**
 * An issue's sentence in the reader's language where its code is known, else the instance's.
 * A refused egress is told whole in the sentence, with nothing in English under it.
 */
export function issueRefusal(issue: RefusalIssue, t: Translate): BuildRefusal {
  const key = issue.code === undefined ? undefined : ISSUE_SENTENCES[issue.code];
  if (key === undefined) return { message: issue.message, asSent: true };
  return issue.code === EGRESS_DENIED
    ? { message: t(key) }
    : { message: t(key), detail: issue.message };
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

function number(value: unknown, key: string): number | undefined {
  const found = field(value, key);
  return typeof found === "number" ? found : undefined;
}

/**
 * What a refusal of a folder says in the reader's language, with the path of the file it
 * names: the instance holds the limits and the rules, and says which one a write broke.
 */
function folderRefusal(
  details: RefusalDetails,
  t: Translate,
  locale: LocaleCode
): string | undefined {
  const path = details.path ?? "";
  const size = (bytes: number | undefined) =>
    bytes === undefined ? "" : formatFileBytes(bytes, locale);
  // A size just over its limit reads as the limit once rounded: it is told in bytes then.
  const over = (actual: number | undefined, limit: number | undefined) =>
    actual !== undefined && size(actual) === size(limit)
      ? `${new Intl.NumberFormat(locale).format(actual)} B`
      : size(actual);
  switch (details.reason) {
    case "skill_file_too_large":
      return t("skillFiles.refusedTooLarge", {
        path,
        size: over(details.actual, details.limit),
        limit: size(details.limit)
      });
    case "skill_too_many_files":
      return t("skillFiles.refusedTooMany", {
        count: String(details.actual ?? ""),
        limit: String(details.limit ?? "")
      });
    case "skill_too_large":
    case "files_too_large":
      return t("skillFiles.refusedTotal", {
        size: over(details.actual, details.limit),
        limit: size(details.limit)
      });
    case "skill_file_executable":
      return t("skillFiles.refusedExecutable", { path });
    case "skill_file_not_text":
      return t("skillFiles.refusedNotText", { path });
    case "skill_file_lfs_pointer":
      return t("skillFiles.refusedLfs", { path });
    case "skill_path_invalid":
      return t("skillFiles.refusedPath", { path });
    case "skill_path_duplicate":
      return details.folder === undefined
        ? t("skillFiles.refusedPathTwice", { path })
        : t("skillFiles.refusedPathBelowFile", { path, folder: details.folder });
    case "files_unavailable":
      return t("skillFiles.refusedUnavailable", { path });
    default:
      return undefined;
  }
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
    path: text(details, "path"),
    folder: text(details, "folder"),
    limit: number(details, "limit"),
    actual: number(details, "actual"),
    guardrailTitle: text(details, "guardrailTitle"),
    guardrailReason: text(details, "guardrailReason"),
    issues: (Array.isArray(issues) ? issues : []).flatMap((issue: unknown) => {
      const message = text(issue, "message");
      const path = field(issue, "path");
      const code = text(issue, "code");
      return message
        ? [{ message, path: Array.isArray(path) ? path : [], ...(code ? { code } : {}) }]
        : [];
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
export function readBuildRefusal(
  error: unknown,
  t: Translate,
  locale: LocaleCode = "en"
): BuildWriteOutcome {
  if (apiErrorCode(error) === "REVISION_CONFLICT") {
    return readRefusalDetails(error).reason === "draft_changed"
      ? { ok: false, conflict: true, draft: true }
      : { ok: false, conflict: true, ...readConflict(error) };
  }
  if (error instanceof PendingApprovalError) {
    const names = new Intl.ListFormat(locale, { type: "disjunction" }).format(error.approverNames);
    return refused({
      message: names ? t("build.pendingApprovalBy", { names }) : t("build.pendingApproval"),
      waiting: true
    });
  }
  const details = readRefusalDetails(error);
  // A guardrail is named by its title in the reader's language, with its author's reason.
  if (apiErrorCode(error) === "GUARDRAIL_BLOCKED" && details.guardrailTitle !== undefined) {
    const blocked = t("guardrails.blockedChange", { name: details.guardrailTitle });
    return refused({
      message: details.guardrailReason ? `${blocked} ${details.guardrailReason}` : blocked
    });
  }
  if (details.reason === "person_context_app_unavailable") {
    return refused({ message: t("connections.personContextAppUnavailable") });
  }
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
  const folder = folderRefusal(details, t, locale);
  if (folder !== undefined) {
    return refused({ field: "files", message: folder });
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
        return { ...(concerned ? { field: concerned } : {}), ...issueRefusal(issue, t) };
      })
    };
  }
  const sentence = apiErrorMessage(error, undefined);
  return refused(
    sentence === undefined
      ? { message: t("configChangeSaveFailed") }
      : { message: sentence, asSent: true }
  );
}

function refused(refusal: BuildRefusal): BuildWriteOutcome {
  return { ok: false, conflict: false, refusals: [refusal] };
}

/** What a change that waits for an approval says. Undefined for every other outcome. */
export function waitingNotice(outcome: BuildWriteOutcome | undefined): string | undefined {
  if (!outcome || outcome.ok || outcome.conflict) return undefined;
  return outcome.refusals.find((refusal) => refusal.waiting)?.message;
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
