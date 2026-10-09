import { Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import type { CollaborationWorkspaceDeletionImpact } from "@vivd-catalyst/api-client";
import { Button, Dialog, Input } from "@vivd-catalyst/ui";
import { useTranslation, type TranslationKey } from "../i18n";

export type CollaborationWorkspaceDeletionStep = "impact" | "confirm";

/**
 * Deleting a shared workspace destroys other people's conversations, so the
 * owner first reads what disappears and only then types the exact name. The
 * server re-validates that name; the client gate is there to slow the hand down.
 */
export function DeleteCollaborationWorkspaceDialog({
  open,
  collaborationWorkspaceName,
  deletionImpact,
  deletionImpactLoading,
  deletionImpactLoadFailed,
  pending,
  errorMessage,
  nameErrorMessage,
  onClose,
  onDelete
}: {
  open: boolean;
  collaborationWorkspaceName: string;
  deletionImpact: CollaborationWorkspaceDeletionImpact | undefined;
  deletionImpactLoading: boolean;
  deletionImpactLoadFailed: boolean;
  pending: boolean;
  errorMessage: string | undefined;
  nameErrorMessage: string | undefined;
  onClose(): void;
  onDelete(confirmName: string): void;
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState<CollaborationWorkspaceDeletionStep>("impact");

  useEffect(() => {
    if (!open) {
      setStep("impact");
    }
  }, [open]);

  return (
    <Dialog
      open={open}
      title={t("collaborationWorkspaceDeleteTitle")}
      onClose={() => {
        if (!pending) {
          onClose();
        }
      }}
    >
      {step === "impact" ? (
        <CollaborationWorkspaceDeletionImpactStep
          collaborationWorkspaceName={collaborationWorkspaceName}
          deletionImpact={deletionImpact}
          loading={deletionImpactLoading}
          loadFailed={deletionImpactLoadFailed}
          onCancel={onClose}
          onContinue={() => setStep("confirm")}
        />
      ) : (
        <CollaborationWorkspaceDeletionConfirmStep
          collaborationWorkspaceName={collaborationWorkspaceName}
          pending={pending}
          errorMessage={errorMessage}
          nameErrorMessage={nameErrorMessage}
          onBack={() => setStep("impact")}
          onDelete={onDelete}
        />
      )}
    </Dialog>
  );
}

export function CollaborationWorkspaceDeletionImpactStep({
  collaborationWorkspaceName,
  deletionImpact,
  loading,
  loadFailed,
  onCancel,
  onContinue
}: {
  collaborationWorkspaceName: string;
  deletionImpact: CollaborationWorkspaceDeletionImpact | undefined;
  loading: boolean;
  loadFailed: boolean;
  onCancel(): void;
  onContinue(): void;
}) {
  const { t } = useTranslation();
  const impactLines: Array<{ key: TranslationKey; count: number }> = deletionImpact
    ? [
        {
          key:
            deletionImpact.conversationCount === 1
              ? "collaborationWorkspaceDeleteImpactConversationOne"
              : "collaborationWorkspaceDeleteImpactConversations",
          count: deletionImpact.conversationCount
        },
        {
          key:
            deletionImpact.memberCount === 1
              ? "collaborationWorkspaceDeleteImpactMemberOne"
              : "collaborationWorkspaceDeleteImpactMembers",
          count: deletionImpact.memberCount
        },
        {
          key:
            deletionImpact.pendingAccessRequestCount === 1
              ? "collaborationWorkspaceDeleteImpactRequestOne"
              : "collaborationWorkspaceDeleteImpactRequests",
          count: deletionImpact.pendingAccessRequestCount
        }
      ]
    : [];

  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3">
        <TriangleAlert size={18} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
        <p className="text-sm leading-6">
          {t("collaborationWorkspaceDeleteWarning", { name: collaborationWorkspaceName })}
        </p>
      </div>

      {loadFailed ? (
        <p className="text-sm text-destructive">
          {t("collaborationWorkspaceDeleteImpactLoadFailed")}
        </p>
      ) : loading ? (
        <p className="text-sm text-muted-foreground">
          {t("collaborationWorkspaceDeleteImpactLoading")}
        </p>
      ) : (
        <ul className="grid gap-1.5" data-testid="collaboration-workspace-deletion-impact">
          {impactLines.map((line) => (
            <li key={line.key} className="text-sm leading-6 text-muted-foreground">
              {t(line.key, { count: line.count })}
            </li>
          ))}
        </ul>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button
          type="button"
          variant="danger"
          disabled={loading || loadFailed}
          onClick={onContinue}
        >
          {t("collaborationWorkspaceDeleteContinue")}
        </Button>
      </div>
    </div>
  );
}

export function CollaborationWorkspaceDeletionConfirmStep({
  collaborationWorkspaceName,
  pending,
  errorMessage,
  nameErrorMessage,
  onBack,
  onDelete
}: {
  collaborationWorkspaceName: string;
  pending: boolean;
  errorMessage: string | undefined;
  nameErrorMessage: string | undefined;
  onBack(): void;
  onDelete(confirmName: string): void;
}) {
  const { t } = useTranslation();
  const [confirmName, setConfirmName] = useState("");
  const confirmed = confirmName.trim() === collaborationWorkspaceName;

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!confirmed || pending) {
          return;
        }
        onDelete(confirmName.trim());
      }}
    >
      <div className="grid gap-2">
        <label className="text-sm font-medium" htmlFor="collaboration-workspace-delete-confirm">
          {t("collaborationWorkspaceDeleteConfirmLabel", { name: collaborationWorkspaceName })}
        </label>
        <Input
          id="collaboration-workspace-delete-confirm"
          value={confirmName}
          maxLength={120}
          autoFocus
          disabled={pending}
          autoComplete="off"
          aria-invalid={nameErrorMessage ? true : undefined}
          onChange={(event) => setConfirmName(event.currentTarget.value)}
        />
        {nameErrorMessage ? <p className="text-sm text-destructive">{nameErrorMessage}</p> : null}
      </div>

      {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" disabled={pending} onClick={onBack}>
          {t("collaborationWorkspaceDeleteBack")}
        </Button>
        <Button type="submit" variant="danger" disabled={pending || !confirmed}>
          <Trash2 size={16} aria-hidden="true" />
          {pending ? t("collaborationWorkspaceDeleting") : t("collaborationWorkspaceDeleteConfirm")}
        </Button>
      </div>
    </form>
  );
}
