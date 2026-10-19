import { useEffect, useState } from "react";
import {
  Button,
  ConfirmDialog,
  Field,
  Input,
  KeyValue,
  KeyValueList,
  Textarea
} from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import type { BuildAsset, BuildAssetEditorProps } from "./build-asset-kind";
import { useConnectionWrite } from "./connection-editing";
import { withConnectionAbout } from "./connection-form-model";
import { RefusalNotice } from "./refusal-notice";

// The name people read and the description of a Connection made on the instance: shown as they
// are, changed after Edit and saved through the frame's save of the definition. The id stays.

function textOf(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  return typeof value === "string" ? value : "";
}

/** What the about form holds: the name and the description as typed. */
export interface ConnectionAbout {
  title: string;
  description: string;
}

/** The about form of a stored definition: its name, else its id, and its description. */
export function connectionAboutOf(asset: Pick<BuildAsset, "config" | "name">): ConnectionAbout {
  return {
    title: textOf(asset.config, "displayName").trim() || asset.name,
    description: textOf(asset.config, "description")
  };
}

/** How many of the two fields differ from what was loaded. */
export function countAboutChanges(form: ConnectionAbout, stored: ConnectionAbout): number {
  return (
    Number(form.title.trim() !== stored.title.trim()) +
    Number(form.description.trim() !== stored.description.trim())
  );
}

export function ConnectionAboutEditor({
  asset,
  frame,
  written
}: {
  asset: BuildAsset;
  frame: BuildAssetEditorProps;
  written(): void;
}) {
  const { t } = useTranslation();
  const stored = connectionAboutOf(asset);
  const [form, setForm] = useState<ConnectionAbout>();
  // Cancel with something typed asks first: it drops what was typed.
  const [asking, setAsking] = useState(false);
  const write = useConnectionWrite(frame, written);
  const changes = form ? countAboutChanges(form, stored) : 0;
  const { onUnsavedChange } = frame;
  useEffect(() => {
    onUnsavedChange(changes > 0);
    return () => onUnsavedChange(false);
  }, [changes, onUnsavedChange]);

  if (!form) {
    return (
      <div className="grid gap-3" data-connection-about="">
        <KeyValueList>
          <KeyValue label={t("connectionPage.name")}>{stored.title}</KeyValue>
          <KeyValue label={t("connectionPage.descriptionField")} foldable>
            {stored.description.trim() === "" ? (
              <span className="text-muted-foreground">{t("connectionPage.noDescription")}</span>
            ) : (
              <span className="break-words whitespace-pre-line">{stored.description}</span>
            )}
          </KeyValue>
        </KeyValueList>
        <Button
          variant="outline"
          size="sm"
          className="justify-self-start"
          disabled={frame.saveBlocked}
          data-connection-about-edit=""
          onClick={() => setForm(stored)}
        >
          {t("connectionPage.aboutEdit")}
        </Button>
      </div>
    );
  }
  const titleMissing = form.title.trim() === "";
  return (
    <form
      className="grid gap-4"
      data-connection-about-form=""
      onSubmit={(event) => {
        event.preventDefault();
        if (titleMissing) return;
        write
          .write("about", withConnectionAbout(asset.config, form))
          .then((saved) => {
            if (saved) setForm(undefined);
          })
          .catch(() => undefined);
      }}
    >
      <Field
        label={t("connectionPage.name")}
        required
        error={titleMissing ? t("connectionPage.nameRequired") : undefined}
      >
        <Input
          autoFocus
          value={form.title}
          data-connection-field="title"
          onChange={(event) => setForm({ ...form, title: event.target.value })}
        />
      </Field>
      <Field
        label={t("connectionPage.descriptionField")}
        hint={t("connectionPage.descriptionHint")}
        optional
      >
        <Textarea
          rows={3}
          value={form.description}
          data-connection-field="description"
          onChange={(event) => setForm({ ...form, description: event.target.value })}
        />
      </Field>
      {write.failure ? <RefusalNotice {...write.failure} /> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          size="sm"
          loading={write.saving === "about"}
          disabled={changes === 0 || titleMissing || frame.saveBlocked}
          data-connection-about-save=""
        >
          {t("connectionPage.aboutSave")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          data-connection-about-cancel=""
          onClick={() => (changes > 0 ? setAsking(true) : setForm(undefined))}
        >
          {t("connectionPage.aboutCancel")}
        </Button>
      </div>
      <ConfirmDialog
        open={asking}
        title={t("build.leaveTitle")}
        confirmLabel={t("build.leaveConfirm")}
        onConfirm={() => {
          setAsking(false);
          setForm(undefined);
        }}
        onClose={() => setAsking(false)}
      >
        {t("build.leaveDescription")}
      </ConfirmDialog>
    </form>
  );
}
