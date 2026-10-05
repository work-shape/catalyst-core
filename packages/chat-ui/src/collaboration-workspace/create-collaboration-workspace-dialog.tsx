import { useEffect, useState } from "react";
import { useTranslation } from "../i18n";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { Input, Textarea } from "../ui/input";
import {
  randomCollaborationWorkspaceAccentColor,
  type CollaborationWorkspaceAccentColor
} from "./collaboration-workspace-accent";
import { CollaborationWorkspaceAvatar } from "./collaboration-workspace-avatar";
import {
  CollaborationWorkspaceDialogFooter,
  CollaborationWorkspaceDialogScrollBody
} from "./collaboration-workspace-dialog-chrome";
import {
  CollaborationWorkspaceAccentField,
  CollaborationWorkspaceConversationVisibilityField,
  CollaborationWorkspaceEmojiField,
  CollaborationWorkspaceVisibilityField,
  type CollaborationWorkspaceVisibility,
  type ConversationVisibility
} from "./collaboration-workspace-fields";

export interface CreateCollaborationWorkspaceValues {
  name: string;
  description: string | null;
  visibility: CollaborationWorkspaceVisibility;
  defaultConversationVisibility: ConversationVisibility;
  emoji: string | null;
  accentColor: CollaborationWorkspaceAccentColor;
}

export function CreateCollaborationWorkspaceDialog({
  open,
  pending,
  errorMessage,
  initialAccentColor,
  onClose,
  onCreate
}: {
  open: boolean;
  pending: boolean;
  errorMessage: string | undefined;
  /** Pins the starting accent instead of picking one; keeps tests deterministic. */
  initialAccentColor?: CollaborationWorkspaceAccentColor;
  onClose(): void;
  onCreate(values: CreateCollaborationWorkspaceValues): void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [emoji, setEmoji] = useState("");
  const [visibility, setVisibility] = useState<CollaborationWorkspaceVisibility>("discoverable");
  const [defaultConversationVisibility, setDefaultConversationVisibility] =
    useState<ConversationVisibility>("workspace");
  /*
   * Picked once per dialog opening rather than derived from the name: deriving
   * it re-rolled the accent on every keystroke, so the preview cycled through
   * the palette while typing. An explicit swatch pick simply overwrites it.
   */
  const [accentColor, setAccentColor] = useState<CollaborationWorkspaceAccentColor>(
    () => initialAccentColor ?? randomCollaborationWorkspaceAccentColor()
  );
  const [nameTouched, setNameTouched] = useState(false);
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
    setDefaultConversationVisibility("workspace");
    setAccentColor(initialAccentColor ?? randomCollaborationWorkspaceAccentColor());
    setNameTouched(false);
  }, [open, initialAccentColor]);

  function submit() {
    setNameTouched(true);
    if (!trimmedName || pending) {
      return;
    }
    onCreate({
      name: trimmedName,
      description: description.trim() ? description.trim() : null,
      visibility,
      defaultConversationVisibility,
      emoji: emoji.trim() ? emoji.trim() : null,
      accentColor
    });
  }

  return (
    <Dialog
      open={open}
      title={t("collaborationWorkspaceCreateTitle")}
      /*
        The body below caps its own height, so the frame should not need to
        scroll; theming it keeps the fallback from showing an OS scrollbar under
        the rounded border on an unusually short viewport.
      */
      className="chat-scrollbar"
      onClose={() => {
        if (!pending) {
          onClose();
        }
      }}
    >
      {/*
        Same chrome as the settings dialog: the fields scroll, the actions stay
        pinned, and the dialog body's own p-5 is cancelled so both the scroll
        region and the footer rule reach the dialog edge.
      */}
      <form
        className="-m-5 grid"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <CollaborationWorkspaceDialogScrollBody className="max-h-[clamp(20rem,68vh,44rem)]">
          {/*
            The label sits above the whole row so the avatar centers against the
            input line itself, not against the label-plus-input block.
          */}
          <div className="grid gap-2">
            <label className="text-sm font-medium" htmlFor="collaboration-workspace-name">
              {t("collaborationWorkspaceNameLabel")}
            </label>
            <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
              <CollaborationWorkspaceAvatar
                name={trimmedName}
                emoji={emoji}
                accentColor={accentColor}
                size="lg"
              />
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
          <CollaborationWorkspaceConversationVisibilityField
            value={defaultConversationVisibility}
            disabled={pending}
            onChange={setDefaultConversationVisibility}
          />
          <CollaborationWorkspaceEmojiField value={emoji} disabled={pending} onChange={setEmoji} />
          <CollaborationWorkspaceAccentField
            value={accentColor}
            disabled={pending}
            onChange={setAccentColor}
          />

          {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}
        </CollaborationWorkspaceDialogScrollBody>

        <CollaborationWorkspaceDialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" disabled={pending}>
            {pending
              ? t("collaborationWorkspaceCreating")
              : t("collaborationWorkspaceCreateSubmit")}
          </Button>
        </CollaborationWorkspaceDialogFooter>
      </form>
    </Dialog>
  );
}
