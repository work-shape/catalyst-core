import type { AuditEvent } from "./audit";
import { EVENTS } from "./events";

/**
 * What an audit event is about, as far as its row tells (UXA-1b3). The rows were written by many
 * hands: an asset is named by `metadata.kind` and `metadata.name`, by the subject of an
 * operation's call, or by its id; a person, a workspace, a role or a conversation by its id.
 * The server looks each up under the reader's rights and the interface says its title, or only
 * its kind where the reader may not read it. The id itself is never what a person reads.
 */
export type AuditSubjectReference =
  /** A config asset, by its name or by its id. */
  | { kind: AuditAssetKind; name: string }
  | { kind: AuditAssetKind; assetId: string }
  | { kind: "user"; userId: string }
  | { kind: "collaboration_workspace"; workspaceId: string }
  | { kind: "role"; roleId: string }
  | { kind: "conversation"; conversationId: string }
  /** A call of an operation of its name, such as an agent's tool. */
  | { kind: "operation"; operation: string }
  /** Something the row names only by its kind: a command, a grant, an API key. */
  | { kind: string };

export const AUDIT_ASSET_KINDS = [
  "agent",
  "skill",
  "app",
  "workflow",
  "connection",
  "data_store",
  "knowledge_base",
  "guardrail"
] as const;

export type AuditAssetKind = (typeof AUDIT_ASSET_KINDS)[number];

export function isAuditAssetKind(kind: unknown): kind is AuditAssetKind {
  return typeof kind === "string" && (AUDIT_ASSET_KINDS as readonly string[]).includes(kind);
}

function metadataString(event: AuditEvent, key: string): string | undefined {
  const value = event.metadata?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The domain an event type belongs to: `config_asset` of `config_asset.published`. */
function domainOf(type: string): string {
  return type.split(".")[0] ?? type;
}

/**
 * The emitter's rows (`operation.*`, `live_once.*`) carry the kind of their subject in
 * `subjectKind`, and an asset's id in `assetId` where the call's resource was resolved.
 */
function emittedSubject(event: AuditEvent): AuditSubjectReference | undefined {
  const kind = metadataString(event, "subjectKind");
  const subject = event.subject;
  if (!kind) return undefined;
  if (isAuditAssetKind(kind)) {
    const assetId = metadataString(event, "assetId");
    if (assetId) return { kind, assetId };
    // An asset route names the asset; a Connection's or an App action's call its id.
    if (kind === "connection" || kind === "app") {
      const name = metadataString(event, "connectionName") ?? metadataString(event, "name");
      if (name) return { kind, name };
    }
    if (!subject) return { kind };
    return kind === "data_store" || kind === "knowledge_base"
      ? { kind, assetId: subject }
      : looksLikeAnId(subject)
        ? { kind, assetId: subject }
        : { kind, name: subject };
  }
  return referenceOf(kind, subject);
}

/** A row id the platform makes: a UUID. An asset's name never has that shape. */
function looksLikeAnId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

/** A subject of a kind the server can look up by id, or the kind alone. */
function referenceOf(kind: string, id: string | undefined): AuditSubjectReference {
  if (!id) return { kind };
  switch (kind) {
    case "user":
      return { kind, userId: id };
    case "collaboration_workspace":
      return { kind, workspaceId: id };
    case "role":
      return { kind, roleId: id };
    case "conversation":
      return { kind, conversationId: id };
    case "operation":
      return { kind, operation: id };
    default:
      return { kind };
  }
}

/** What the event is about, or nothing for an event about the instance as a whole. */
export function auditSubjectOf(event: AuditEvent): AuditSubjectReference | undefined {
  const { type, subject } = event;
  const domain = domainOf(type);
  if (type.startsWith("operation.") || type.startsWith("live_once.")) {
    const emitted = emittedSubject(event);
    if (emitted) return emitted;
  }
  switch (domain) {
    case "conversation":
    case "execution_workspace":
      return referenceOf("conversation", subject);
    case "message": {
      const conversationId =
        type === "message.created" ? metadataString(event, "conversationId") : subject;
      return referenceOf("conversation", conversationId);
    }
    case "user":
    case "collaboration_workspace":
    case "role":
      return referenceOf(domain, subject);
    case "connection": {
      const name = metadataString(event, "connectionName") ?? subject;
      return name ? { kind: "connection", name } : { kind: "connection" };
    }
    case "data_store":
    case "knowledge_base":
      return subject ? { kind: domain, assetId: subject } : { kind: domain };
    case "workflow_run": {
      const workflow = metadataString(event, "workflow");
      return workflow ? { kind: "workflow", name: workflow } : { kind: "workflow_run" };
    }
    case "feedback": {
      const agent = metadataString(event, "agentName");
      return agent ? { kind: "agent", name: agent } : { kind: "feedback" };
    }
    default:
      break;
  }
  if (type === "config_asset.default_agent_set") {
    const agent = metadataString(event, "agentName");
    return agent ? { kind: "agent", name: agent } : { kind: "agent" };
  }
  // Rows about a config asset name it by kind and name, and an App's or a Guardrail's by its type.
  const namedKind = event.metadata?.kind;
  const assetKind = isAuditAssetKind(namedKind)
    ? namedKind
    : isAuditAssetKind(domain)
      ? domain
      : undefined;
  if (assetKind) {
    const name = metadataString(event, "name");
    return name ? { kind: assetKind, name } : { kind: assetKind };
  }
  const declared = (EVENTS as Record<string, { subject: string } | undefined>)[type]?.subject;
  if (declared && declared !== "config_asset" && declared !== "instance") {
    return referenceOf(declared, subject);
  }
  return undefined;
}
