import { LEGACY_AUDIT, type PlatformEventDefinition } from "./definition";

export const connectionEvents = {
  // A sign-in at the outside system was completed for a Connection (CS-4b). The subject is the
  // Connection's name. The metadata names granted scopes, never a token, a code or an account.
  "connection.binding_connected": {
    name: "connection.binding_connected",
    subject: "connection",
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["connectionName", "connectionRevision", "subjectKind", "scopes"],
      properties: {
        connectionName: { type: "string" },
        connectionRevision: { type: "integer" },
        subjectKind: { type: "string", enum: ["shared"] },
        scopes: { type: "array", items: { type: "string" } },
        accountChanged: { type: "boolean" },
        operationRunId: { type: "string" }
      }
    }
  },
  // The outside system refused a Connection's sign-in: a refresh was refused (`invalid_grant`,
  // `invalid_client`), or a call lacked a scope (`insufficient_scope`). The reason is the
  // event's reason. A refused refresh leaves the binding `needs_reconnect` with its token set
  // deleted; a missing scope leaves it connected for what it has.
  "connection.binding_needs_reconnect": {
    name: "connection.binding_needs_reconnect",
    subject: "connection",
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["connectionName", "connectionRevision", "subjectKind"],
      properties: {
        connectionName: { type: "string" },
        connectionRevision: { type: "integer" },
        subjectKind: { type: "string", enum: ["shared"] },
        /** The scopes a call lacked, with `insufficient_scope`. Names, never a token. */
        missingScopes: { type: "array", items: { type: "string" } },
        operationRunId: { type: "string" }
      }
    }
  },
  // A Connection's sign-in ended: Disconnect, or the Connection was deleted, moved to another
  // origin or set to another auth scheme. The reason is the event's reason; the metadata says
  // what the provider answered to the revocation.
  "connection.binding_revoked": {
    name: "connection.binding_revoked",
    subject: "connection",
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["connectionName", "connectionRevision", "subjectKind", "providerRevocation"],
      properties: {
        connectionName: { type: "string" },
        connectionRevision: { type: "integer" },
        subjectKind: { type: "string", enum: ["shared"] },
        providerRevocation: { type: "string", enum: ["confirmed", "failed", "not_offered"] },
        operationRunId: { type: "string" }
      }
    }
  },
  "connection.person_context_set": {
    name: "connection.person_context_set",
    subject: "connection",
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["connectionName", "subjectKind", "subjectId", "mapped"],
      properties: {
        connectionName: { type: "string" },
        subjectKind: { type: "string", enum: ["user", "service_principal"] },
        subjectId: { type: "string" },
        mapped: { type: "boolean" },
        operationRunId: { type: "string" }
      }
    }
  },
  "connection.discovered": {
    ...LEGACY_AUDIT,
    name: "connection.discovered",
    subject: "connection"
  },
  "connection.discovery_failed": {
    ...LEGACY_AUDIT,
    name: "connection.discovery_failed",
    subject: "connection"
  },
  // The platform registered an OAuth client for a Connection at its authorization server by
  // Dynamic Client Registration. The metadata names the issuer's host, never a client secret.
  "connection.oauth_client_registered": {
    name: "connection.oauth_client_registered",
    subject: "connection",
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["connectionName", "connectionRevision", "issuerHost", "method"],
      properties: {
        connectionName: { type: "string" },
        connectionRevision: { type: "integer" },
        issuerHost: { type: "string" },
        method: { type: "string", enum: ["dcr"] },
        operationRunId: { type: "string" }
      }
    }
  },
  // The start or the callback of a sign-in was refused. The reason is the event's reason; the
  // metadata names the stage, never a state, a code or the authorization address.
  "connection.oauth_refused": {
    name: "connection.oauth_refused",
    subject: "connection",
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["stage", "subjectKind"],
      properties: {
        connectionName: { type: "string" },
        connectionRevision: { type: "integer" },
        stage: { type: "string", enum: ["start", "callback"] },
        subjectKind: { type: "string", enum: ["shared"] },
        operationRunId: { type: "string" }
      }
    }
  }
} as const satisfies Record<string, PlatformEventDefinition>;
