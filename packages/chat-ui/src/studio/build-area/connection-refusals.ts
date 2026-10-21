import { EGRESS_DENIED } from "@work-shape/catalyst-core";
import type { TranslationContextValue, TranslationKey } from "../../shared/i18n";
import { issueRefusal, readBuildRefusal, readRefusalDetails } from "./build-refusals";
import type { CreateFieldErrors } from "./connection-create-form";

type Translate = TranslationContextValue["t"];

/**
 * A refused Connection as the reader is told it: what happened and who changes it, in their
 * language. `detail` holds the instance's sentences, which an administrator reads under
 * Technical details; they are the instance's own checks, never a secret or an upstream answer.
 */
export interface ConnectionRefusal {
  message: string;
  detail?: string;
}

/** The field of the New connection dialog an issue is about: the address for a refused egress. */
function fieldOfIssue({ path, code }: { path: readonly unknown[]; code?: string }) {
  // The authorization server a REST API names: its addresses, client and permissions.
  if (path[0] === "settings" && path[1] === "oauth") return "oauth";
  if (code === EGRESS_DENIED) return "url";
  if (path.includes("url") || path.includes("baseUrl")) return "url";
  if (path.includes("headers")) return "headers";
  if (path.includes("testPath")) return "testPath";
  if (path.includes("headerName")) return "headerName";
  if (path[0] === "name") return "id";
  return "general";
}

/** What a field says where the instance refused it in its own words. */
const FIELD_FALLBACK: Record<ReturnType<typeof fieldOfIssue>, TranslationKey> = {
  url: "connections.refusedAddress",
  headers: "connections.refusedHeaders",
  headerName: "connections.refusedHeaders",
  testPath: "connections.refusedTestPath",
  oauth: "connections.refusedOAuth",
  id: "connections.refusedName",
  general: "connections.refusedUnknown"
};

/** The host of an address as the operator allows it, such as `10.0.0.5:8080`. */
function hostOf(url: string): string {
  try {
    return new URL(url.trim()).host;
  } catch {
    return url.trim();
  }
}

/**
 * The address the operator's network rule blocks, said once: what blocks it and the host to
 * send the operator. There is nothing more to say under Technical details.
 */
export function egressRefusal(url: string, t: Translate): string {
  return t("connectionCreate.errorEgress", { host: hostOf(url) });
}

/**
 * Each refused field of a new Connection with its sentence in the reader's language, and the
 * instance's sentences for an administrator. A name taken meanwhile is told at the name. A
 * refused egress names the host of `url`, the address the person typed.
 */
export function connectionWriteErrors(
  error: unknown,
  name: string,
  t: Translate,
  url?: string
): { errors: CreateFieldErrors; detail?: string } {
  const outcome = readBuildRefusal(error, t);
  if (!outcome.ok && outcome.conflict) {
    return { errors: { id: t("connectionCreate.errorIdTaken", { name }) } };
  }
  const issues = readRefusalDetails(error).issues;
  if (issues.length === 0) {
    const told = connectionRefusalOf(outcome, "connections.refusedUnknown", t);
    return { errors: { general: told.message }, ...(told.detail ? { detail: told.detail } : {}) };
  }
  const errors: CreateFieldErrors = {};
  const details: string[] = [];
  for (const issue of issues) {
    const field = fieldOfIssue(issue);
    const egress = issue.code === EGRESS_DENIED;
    const known = issueRefusal(issue, t);
    // An address of the authorization server is blocked: which one, the detail says.
    const oauthEgress = egress && field === "oauth";
    const message = oauthEgress
      ? t("connections.refusedOAuthEgress")
      : egress && url !== undefined
        ? egressRefusal(url, t)
        : known.asSent
          ? t(FIELD_FALLBACK[field])
          : known.message;
    if (!egress || oauthEgress) details.push(issue.message);
    const before = errors[field];
    errors[field] =
      before === undefined || before.includes(message) ? message : `${before} ${message}`;
  }
  return details.length === 0 ? { errors } : { errors, detail: details.join(" ") };
}

/**
 * A refused change of a Connection's page in the reader's language. A sentence the page could
 * not put into the reader's words gives way to `fallback`; the instance's sentences go to the
 * detail. A conflict is told by the frame's notice instead.
 */
export function connectionRefusalOf(
  outcome: ReturnType<typeof readBuildRefusal>,
  fallback: TranslationKey,
  t: Translate
): ConnectionRefusal {
  if (outcome.ok || outcome.conflict) return { message: t("connections.writeFailed") };
  const messages = new Set<string>();
  const details: string[] = [];
  for (const refusal of outcome.refusals) {
    messages.add(refusal.asSent ? t(fallback) : refusal.message);
    if (refusal.asSent) details.push(refusal.message);
    else if (refusal.detail !== undefined) details.push(refusal.detail);
  }
  const message = [...messages].join(" ") || t("connections.writeFailed");
  return details.length === 0 ? { message } : { message, detail: details.join(" ") };
}

/** Why the approved tools were not saved, and the instance's sentences for an administrator. */
export interface ApprovalRefused {
  refusals: string[];
  detail?: string;
}

/**
 * Why the approved tools were not saved: each refusal in the reader's language, with the name
 * of the operation it is about where its path names one.
 */
export function approvalRefusals(
  error: unknown,
  config: Record<string, unknown>,
  t: Translate
): ApprovalRefused {
  const issues = readRefusalDetails(error).issues;
  const operations = Array.isArray(config.operations) ? config.operations : [];
  if (issues.length === 0) {
    const told = connectionRefusalOf(readBuildRefusal(error, t), "connections.refusedUnknown", t);
    return { refusals: [told.message], ...(told.detail ? { detail: told.detail } : {}) };
  }
  const refusals = issues.map((issue) => {
    const [first, index] = issue.path;
    const operation: unknown =
      first === "operations" && typeof index === "number" ? operations[index] : undefined;
    const named =
      typeof operation === "object" && operation !== null && "name" in operation
        ? operation.name
        : undefined;
    const known = issueRefusal(issue, t);
    const message = known.asSent ? t("connections.refusedOperation") : known.message;
    return typeof named === "string" ? `${named}: ${message}` : message;
  });
  return { refusals, detail: issues.map((issue) => issue.message).join(" ") };
}
