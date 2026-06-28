import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { createDraftKey } from "../workspace-utils";

interface WorkspaceDraftTarget {
  authScope: string;
  conversationId: string | undefined;
}

interface MoveWorkspaceDraftInput {
  authScope: string;
  fromConversationId: string | undefined;
  toConversationId: string;
}

interface WorkspaceDraftsContextValue {
  draftFor(target: WorkspaceDraftTarget): string;
  setDraft(target: WorkspaceDraftTarget, value: string): void;
  clearDraft(target: WorkspaceDraftTarget): void;
  moveDraft(input: MoveWorkspaceDraftInput): void;
  clearDrafts(): void;
}

const WorkspaceDraftsContext = createContext<WorkspaceDraftsContextValue | undefined>(undefined);

export function WorkspaceDraftsProvider({ children }: { children: ReactNode }) {
  const [draftsByTarget, setDraftsByTarget] = useState<Record<string, string>>({});

  const draftFor = useCallback(
    ({ authScope, conversationId }: WorkspaceDraftTarget) =>
      draftsByTarget[createDraftKey(authScope, conversationId)] ?? "",
    [draftsByTarget]
  );

  const setDraft = useCallback(({ authScope, conversationId }: WorkspaceDraftTarget, value: string) => {
    const draftKey = createDraftKey(authScope, conversationId);
    setDraftsByTarget((currentDrafts) => {
      if (value.length === 0) {
        const remainingDrafts = { ...currentDrafts };
        delete remainingDrafts[draftKey];
        return remainingDrafts;
      }
      return {
        ...currentDrafts,
        [draftKey]: value
      };
    });
  }, []);

  const clearDraft = useCallback(
    (target: WorkspaceDraftTarget) => {
      setDraft(target, "");
    },
    [setDraft]
  );

  const moveDraft = useCallback(
    ({ authScope, fromConversationId, toConversationId }: MoveWorkspaceDraftInput) => {
      const fromKey = createDraftKey(authScope, fromConversationId);
      const toKey = createDraftKey(authScope, toConversationId);
      if (fromKey === toKey) {
        return;
      }

      setDraftsByTarget((currentDrafts) => {
        const draft = currentDrafts[fromKey];
        if (!draft) {
          return currentDrafts;
        }
        const nextDrafts = { ...currentDrafts };
        delete nextDrafts[fromKey];
        nextDrafts[toKey] = draft;
        return nextDrafts;
      });
    },
    []
  );

  const clearDrafts = useCallback(() => {
    setDraftsByTarget({});
  }, []);

  const value = useMemo<WorkspaceDraftsContextValue>(
    () => ({
      draftFor,
      setDraft,
      clearDraft,
      moveDraft,
      clearDrafts
    }),
    [clearDraft, clearDrafts, draftFor, moveDraft, setDraft]
  );

  return <WorkspaceDraftsContext.Provider value={value}>{children}</WorkspaceDraftsContext.Provider>;
}

export function useWorkspaceDraftController(): WorkspaceDraftsContextValue {
  const value = useContext(WorkspaceDraftsContext);
  if (!value) {
    throw new Error("useWorkspaceDraftController must be used within WorkspaceDraftsProvider");
  }
  return value;
}

export function useWorkspaceDraft(target: WorkspaceDraftTarget) {
  const controller = useWorkspaceDraftController();
  const draft = controller.draftFor(target);
  const draftKey = createDraftKey(target.authScope, target.conversationId);
  const setDraft = useCallback(
    (value: string) => {
      controller.setDraft(target, value);
    },
    [controller, target.authScope, target.conversationId]
  );
  const clearDraft = useCallback(() => {
    controller.clearDraft(target);
  }, [controller, target.authScope, target.conversationId]);

  return useMemo(
    () => ({
      draftKey,
      draft,
      setDraft,
      clearDraft
    }),
    [clearDraft, draft, draftKey, setDraft]
  );
}
