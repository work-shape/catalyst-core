import type { JsonObject } from "../json";
import type { PlatformEventDefinition } from "./definition";

/** An owner as an event names it: the instance, or a workspace by its id. */
const OWNER: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  properties: {
    kind: { enum: ["instance", "workspace"] },
    workspaceId: { type: "string" }
  }
};

export const assetEvents = {
  // Guardrails answer here before a revision of any asset kind is written. The subject is the
  // asset; its kind narrows the guardrails that apply.
  "asset.before_write": {
    name: "asset.before_write",
    subject: "config_asset",
    legacy: false,
    audited: false,
    phases: ["before"]
  },
  // An asset written before its kind had a repository got one commit per revision (WF-GIT-2).
  // It may lie in a Personal Workspace, so the event holds counts and the asset id, no name.
  "asset.repository_adopted": {
    name: "asset.repository_adopted",
    subject: "config_asset",
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["assetId", "revisions", "commits"],
      properties: {
        assetId: { type: "string" },
        revisions: { type: "integer", minimum: 0 },
        commits: { type: "integer", minimum: 0 }
      }
    }
  },
  // An asset was shared up the ladder with what it uses (SHARE-1, MOVE-1). It may come from a
  // Personal Workspace, so the event names ids, kinds and owners, never a name or content.
  "asset.moved": {
    name: "asset.moved",
    subject: "config_asset",
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["assetId", "kind", "from", "to", "moved"],
      properties: {
        assetId: { type: "string" },
        kind: { type: "string" },
        from: OWNER,
        to: OWNER,
        moved: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["assetId", "kind"],
            properties: { assetId: { type: "string" }, kind: { type: "string" } }
          }
        },
        /** The grants that went with the move: edit rights follow the new place. */
        droppedGrantIds: { type: "array", items: { type: "string" } },
        requestId: { type: "string" },
        operationRunId: { type: "string" }
      }
    }
  }
} as const satisfies Record<string, PlatformEventDefinition>;
