import { LEGACY_AUDIT, type PlatformEventDefinition } from "./definition";

export const workspaceCommandEvents = {
  "workspace_command.cancelled": {
    ...LEGACY_AUDIT,
    name: "workspace_command.cancelled",
    subject: "workspace_command"
  },
  "workspace_command.completed": {
    ...LEGACY_AUDIT,
    name: "workspace_command.completed",
    subject: "workspace_command"
  },
  "workspace_command.failed": {
    ...LEGACY_AUDIT,
    name: "workspace_command.failed",
    subject: "workspace_command"
  },
  "workspace_command.queued": {
    ...LEGACY_AUDIT,
    name: "workspace_command.queued",
    subject: "workspace_command"
  },
  "workspace_command.recovered_stale": {
    ...LEGACY_AUDIT,
    name: "workspace_command.recovered_stale",
    subject: "workspace_command"
  },
  "workspace_command.running": {
    ...LEGACY_AUDIT,
    name: "workspace_command.running",
    subject: "workspace_command"
  },
  "workspace_command.timed_out": {
    ...LEGACY_AUDIT,
    name: "workspace_command.timed_out",
    subject: "workspace_command"
  }
} as const satisfies Record<string, PlatformEventDefinition>;
