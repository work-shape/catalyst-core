import { LEGACY_AUDIT, type PlatformEventDefinition } from "./definition";

export const executionWorkspaceEvents = {
  "execution_workspace.cleaned_up": {
    ...LEGACY_AUDIT,
    name: "execution_workspace.cleaned_up",
    subject: "execution_workspace"
  },
  "execution_workspace.cleanup_failed": {
    ...LEGACY_AUDIT,
    name: "execution_workspace.cleanup_failed",
    subject: "execution_workspace"
  }
} as const satisfies Record<string, PlatformEventDefinition>;
