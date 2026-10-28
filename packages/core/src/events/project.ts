import type { PlatformEventDefinition } from "./definition";

export const projectEvents = {
  // A project was created (PRJ-1). Ids and the audience only: never its title or description.
  "project.created": {
    name: "project.created",
    subject: "project",
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["workspaceId", "audience"],
      properties: {
        workspaceId: { type: "string" },
        audience: { type: "string", enum: ["workspace", "private"] },
        operationRunId: { type: "string" }
      }
    }
  }
} as const satisfies Record<string, PlatformEventDefinition>;
