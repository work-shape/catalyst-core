import { PROJECT_DELETION_CONVERSATIONS } from "@work-shape/catalyst-asset-schemas";
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
  },
  // A project's default agent, attached skills or Knowledge Bases changed (PRJ-7, PRJ-8). Whether
  // the default changed and how many came and went: never their names, which can name a
  // person's own.
  "project.setup_changed": {
    name: "project.setup_changed",
    subject: "project",
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["defaultAgentChanged", "skillsAdded", "skillsRemoved"],
      properties: {
        defaultAgentChanged: { type: "boolean" },
        skillsAdded: { type: "integer", minimum: 0 },
        skillsRemoved: { type: "integer", minimum: 0 },
        knowledgeBasesAdded: { type: "integer", minimum: 0 },
        knowledgeBasesRemoved: { type: "integer", minimum: 0 },
        operationRunId: { type: "string" }
      }
    }
  },
  // Who reads a project changed (PRJ-6): ids, audiences and counts, never its title.
  "project.audience_changed": {
    name: "project.audience_changed",
    subject: "project",
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["workspaceId", "previousAudience", "audience"],
      properties: {
        workspaceId: { type: "string" },
        previousAudience: { type: "string", enum: ["workspace", "private"] },
        audience: { type: "string", enum: ["workspace", "private"] },
        conversationsShared: { type: "integer", minimum: 0 },
        conversationsLeft: { type: "integer", minimum: 0 },
        conversationsMadePrivate: { type: "integer", minimum: 0 },
        operationRunId: { type: "string" }
      }
    }
  },
  // A project moved to another workspace with its chats and files (PRJ-6): a change of who
  // may reach it, so both workspaces are named.
  "project.moved": {
    name: "project.moved",
    subject: "project",
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["fromWorkspaceId", "toWorkspaceId", "audience"],
      properties: {
        fromWorkspaceId: { type: "string" },
        toWorkspaceId: { type: "string" },
        previousAudience: { type: "string", enum: ["workspace", "private"] },
        audience: { type: "string", enum: ["workspace", "private"] },
        conversationsMoved: { type: "integer", minimum: 0 },
        grantsDropped: { type: "integer", minimum: 0 },
        operationRunId: { type: "string" }
      }
    }
  },
  // A person deleted a project (PRJ-6), its chats kept or deleted with it.
  "project.deleted": {
    name: "project.deleted",
    subject: "project",
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["workspaceId", "conversations", "cleanup"],
      properties: {
        workspaceId: { type: "string" },
        audience: { type: "string", enum: ["workspace", "private"] },
        conversations: { type: "string", enum: [...PROJECT_DELETION_CONVERSATIONS] },
        conversationsDeleted: { type: "integer", minimum: 0 },
        conversationsKept: { type: "integer", minimum: 0 },
        cleanup: { type: "string", enum: ["complete", "pending"] },
        operationRunId: { type: "string" }
      }
    }
  },
  // The retention job told the people who answer for an idle project that it goes in seven
  // days (PRJ-6). Counts only.
  "project.idle_noticed": {
    name: "project.idle_noticed",
    subject: "project",
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["idleDays", "recipients"],
      properties: {
        idleDays: { type: "integer", minimum: 0 },
        recipients: { type: "integer", minimum: 0 },
        mailsQueued: { type: "integer", minimum: 0 }
      }
    }
  },
  // The retention job deleted an idle project after its notice (PRJ-6). Its chats stay.
  "project.retention_deleted": {
    name: "project.retention_deleted",
    subject: "project",
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["idleDays", "cleanup"],
      properties: {
        idleDays: { type: "integer", minimum: 0 },
        conversationsKept: { type: "integer", minimum: 0 },
        cleanup: { type: "string", enum: ["complete", "pending"] }
      }
    }
  },
  // Removing the stored bytes and rows of a deleted project failed; the retention job retries.
  "project.cleanup_failed": {
    name: "project.cleanup_failed",
    subject: "project",
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["errorCode", "errorCategory"],
      properties: {
        errorCode: { type: "string" },
        errorCategory: { type: "string" }
      }
    }
  },
  // The retry finished a deleted project's cleanup.
  "project.cleanup_completed": {
    name: "project.cleanup_completed",
    subject: "project",
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["objects"],
      properties: {
        objects: { type: "integer", minimum: 0 }
      }
    }
  }
} as const satisfies Record<string, PlatformEventDefinition>;
