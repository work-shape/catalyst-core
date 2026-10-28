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
  },
  // A run took the project's instructions into its system message (PRJ-3). The project and
  // the version of AGENTS.md: never the path or the text.
  "project.instructions_read": {
    name: "project.instructions_read",
    subject: "project",
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["version", "runId"],
      properties: {
        version: { type: "integer", minimum: 1 },
        runId: { type: "string" },
        operationRunId: { type: "string" }
      }
    }
  }
} as const satisfies Record<string, PlatformEventDefinition>;
