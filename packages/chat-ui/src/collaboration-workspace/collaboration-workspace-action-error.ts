import { useState } from "react";
import { useTranslation, type TranslationKey } from "../i18n";
import {
  collaborationWorkspaceErrorKey,
  type CollaborationWorkspaceAction
} from "./collaboration-workspace-errors";

/** The message of the last workspace action that failed, in the reader's language. */
export function useCollaborationWorkspaceActionError() {
  const { t } = useTranslation();
  const [errorMessage, setErrorMessage] = useState<string | undefined>();

  return {
    errorMessage,
    clearError: () => setErrorMessage(undefined),
    reportError: (action: CollaborationWorkspaceAction, error: unknown) => {
      setErrorMessage(t(collaborationWorkspaceErrorKey(action, error)));
    }
  };
}

/**
 * Deletion splits its errors: a rejected confirmation name belongs next to the
 * input, everything else at the foot of the dialog.
 */
export function useCollaborationWorkspaceDeletionError() {
  const { t } = useTranslation();
  const [errorKey, setErrorKey] = useState<TranslationKey | undefined>();
  const nameMismatch = errorKey === "collaborationWorkspaceErrorNameMismatch";

  return {
    errorMessage: errorKey && !nameMismatch ? t(errorKey) : undefined,
    nameErrorMessage: errorKey && nameMismatch ? t(errorKey) : undefined,
    clearError: () => setErrorKey(undefined),
    reportError: (error: unknown) => {
      setErrorKey(collaborationWorkspaceErrorKey("deleteCollaborationWorkspace", error));
    }
  };
}
