import { useEffect, useState } from "react";
import { useTranslation } from "../i18n";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { Input, Textarea } from "../ui/input";
import {
  defaultCollaborationWorkspaceAccentColor,
  type CollaborationWorkspaceAccentColor
} from "./collaboration-workspace-accent";
import { CollaborationWorkspaceAvatar } from "./collaboration-workspace-avatar";
import {
  CollaborationWorkspaceAccentField,
  CollaborationWorkspaceEmojiField,
  CollaborationWorkspaceVisibilityField,
  type CollaborationWorkspaceVisibility
} from "./collaboration-workspace-fields";

export interface CreateCollaborationWorkspaceValues {
  name: string;
  description: string | null;
  visibility: CollaborationWorkspaceVisibility;
  emoji: string | null;
  accentColor: CollaborationWorkspaceAccentColor;
}

export function CreateCollaborationWorkspaceDialog({
  open,
  pending,
  errorMessage,
  onClose,
  onCreate
}: {
  open: boolean;
  pending: boolean;
  errorMessage: string | undefined;
  onClose(): void;
  onCreate(values: CreateCollaborationWorkspaceValues): void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [emoji, setEmoji] = useState("");
  const [visibility, setVisibility] = useState<CollaborationWorkspaceVisibility>("discoverable");
  const [accentColorOverride, setAccentColorOverride] = useState<
    CollaborationWorkspaceAccentColor | undefined
  >();
  const [nameTouched, setNameTouched] = useState(false);
  const accentColor = accentColorOverride ?? defaultCollaborationWorkspaceAccentColor(name);
  const trimmedName = name.trim();
  const nameMissing = nameTouched && !trimmedName;

  useEffect(() => {
    if (open) {
      return;
    }
    setName("");
    setDescription("");
    setEmoji("");
    setVisibility("discoverable");
    setAccentColorOverride(undefined);
    setNameTouched(false);
  }, [open]);

  function submit() {
    setNameTouched(true);
    if (!trimmedName || pending) {
      return;
    }
    onCreate({
      name: trimmedName,
      description: description.trim() ? description.trim() : null,
      visibility,
      emoji: emoji.trim() ? emoji.trim() : null,
      accentColor
    });
  }

  return (
    <Dialog
      open={open}
      title={t("collaborationWorkspaceCreateTitle")}
      onClose={() => {
        if (!pending) {
          onClose();
        }
      }}
    >
      <form
        className="grid gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
          <CollaborationWorkspaceAvatar
            name={trimmedName}
            emoji={emoji}
            accentColor={accentColor}
            size="lg"
          />
          <div className="grid gap-2">
            <label className="text-sm font-medium" htmlFor="collaboration-workspace-name">
              {t("collaborationWorkspaceNameLabel")}
            </label>
            <Input
              id="collaboration-workspace-name"
              value={name}
              maxLength={120}
              autoFocus
              disabled={pending}
              placeholder={t("collaborationWorkspaceNamePlaceholder")}
              aria-invalid={nameMissing || undefined}
              onChange={(event) => setName(event.currentTarget.value)}
              onBlur={() => setNameTouched(true)}
            />
          </div>
        </div>
        {nameMissing ? (
          <p className="text-sm text-destructive">{t("collaborationWorkspaceNameRequired")}</p>
        ) : null}

        <div className="grid gap-2">
          <label className="text-sm font-medium" htmlFor="collaboration-workspace-description">
            {t("collaborationWorkspaceDescriptionLabel")}
          </label>
          <Textarea
            id="collaboration-workspace-description"
            value={description}
            maxLength={500}
            disabled={pending}
            onChange={(event) => setDescription(event.currentTarget.value)}
          />
          <p className="text-xs text-muted-foreground">
            {t("collaborationWorkspaceDescriptionHint")}
          </p>
        </div>

        <CollaborationWorkspaceVisibilityField
          value={visibility}
          disabled={pending}
          onChange={setVisibility}
        />
        <CollaborationWorkspaceEmojiField value={emoji} disabled={pending} onChange={setEmoji} />
        <CollaborationWorkspaceAccentField
          value={accentColor}
          disabled={pending}
          onChange={setAccentColorOverride}
        />

        {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" disabled={pending}>
            {pending
              ? t("collaborationWorkspaceCreating")
              : t("collaborationWorkspaceCreateSubmit")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
