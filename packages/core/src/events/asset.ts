import type { PlatformEventDefinition } from "./definition";

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
  }
} as const satisfies Record<string, PlatformEventDefinition>;
