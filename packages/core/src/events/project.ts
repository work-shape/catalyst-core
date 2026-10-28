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
  },
  // A file of a project was deleted with all its versions (PRJ-2). The project and a count:
  // never the path, which can name a client.
  "project.file_purged": {
    name: "project.file_purged",
    subject: "project",
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["versions"],
      properties: {
        versions: { type: "integer", minimum: 0 },
        operationRunId: { type: "string" }
      }
    }
  }
} as const satisfies Record<string, PlatformEventDefinition>;
