import { useState } from "react";
import { Ellipsis } from "lucide-react";
import {
  Banner,
  Button,
  ConfirmDialog,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton
} from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { uiLabelsFor } from "../../shared/ui-labels";
import { findStep, heldIds, readersOf } from "./step-edits";
import type { WorkflowEditing } from "./workflow-editing";

// Deleting and moving a step from its panel (workflow-canvas 9.6, WF-EDIT-4): the step's "…"
// menu, and the one question before a delete. Each saves at once as one revision of the draft,
// so both wait while something else is not saved.

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** Whether a step can be moved and deleted: one trigger and one result stay where they are. */
export function stepMovable(editing: WorkflowEditing, stepId: string): boolean {
  const step = findStep(editing.manifest, stepId);
  return step !== undefined && step.type !== "trigger" && step.type !== "output";
}

/** The "…" menu of a step: Move, and Delete step. */
export function StepMenu({
  editing,
  onMove,
  onDelete
}: {
  editing: WorkflowEditing;
  onMove(): void;
  onDelete(): void;
}) {
  const { t, locale } = useTranslation();
  const waiting = editing.unsaved.size > 0 ? t("workflows.stepMenu.unsavedFirst") : undefined;
  const reason = waiting === undefined ? {} : { disabledReason: waiting };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton size="sm" label={uiLabelsFor(locale).moreActions} data-step-menu="">
          <Ellipsis aria-hidden="true" />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={editing.saving} {...reason} onSelect={onMove}>
          {t("workflows.stepMenu.move")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem tone="danger" disabled={editing.saving} {...reason} onSelect={onDelete}>
          {t("workflows.stepMenu.delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The question before a step is deleted, with how many steps go with a block. A step whose
 * result a later step reads is not offered for deleting: the dialog names those steps, since
 * the instance refuses a reference to a step that is not there.
 */
export function DeleteStepDialog({
  editing,
  stepId,
  onClose,
  onDeleted
}: {
  editing: WorkflowEditing;
  stepId: string;
  onClose(): void;
  /** The step was deleted and saved. */
  onDeleted(): void;
}) {
  const { t, locale } = useTranslation();
  const [refused, setRefused] = useState<string>();
  const step = findStep(editing.manifest, stepId);
  if (step === undefined) return null;
  const name = text(step.name) || stepId;
  const readers = readersOf(editing.manifest, stepId).map(
    (reader) => text(reader.name) || String(reader.id)
  );
  if (readers.length > 0) {
    return (
      <Dialog
        open
        size="sm"
        title={t("workflows.delete.blockedTitle", { name })}
        footer={
          <Button type="button" variant="outline" onClick={onClose}>
            {t("workflows.delete.close")}
          </Button>
        }
        onClose={onClose}
      >
        <p className="text-body text-muted-foreground" data-delete-readers="">
          {readers.length === 1
            ? t("workflows.delete.readersOne", { names: readers[0] ?? "" })
            : t("workflows.delete.readersMany", {
                names: new Intl.ListFormat(locale, { type: "conjunction" }).format(
                  readers.map((reader) => t("workflows.delete.readerName", { name: reader }))
                )
              })}
        </p>
      </Dialog>
    );
  }
  const inside = heldIds(step).length - 1;
  return (
    <ConfirmDialog
      open
      title={t("workflows.delete.title", { name })}
      confirmLabel={t("workflows.delete.confirm")}
      tone="danger"
      loading={editing.saving}
      onConfirm={() => {
        setRefused(undefined);
        editing
          .commit({ kind: "delete", step: stepId })
          .then((sentence) => {
            if (sentence === undefined) onDeleted();
            else setRefused(sentence);
          })
          .catch(() => undefined);
      }}
      onClose={onClose}
    >
      <div className="grid gap-3">
        <p>
          {t("workflows.delete.body")}
          {inside === 0
            ? null
            : ` ${
                inside === 1
                  ? t("workflows.delete.withStep")
                  : t("workflows.delete.withSteps", { count: String(inside) })
              }`}
        </p>
        {refused === undefined ? null : (
          <Banner tone="danger" layout="inline" title={t("workflows.delete.refused", { name })}>
            {refused}
          </Banner>
        )}
      </div>
    </ConfirmDialog>
  );
}
