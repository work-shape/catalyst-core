import { useState, type ReactNode } from "react";
import { RenameField, type RenameFieldSize } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { instanceSentence } from "../build-area/build-refusals";
import { useAppWrites } from "./app-data";
import { APP_NAME_MAX, appRefusalText } from "./app-model";

/** Renaming one App where its name stands: the field that takes the name's place, while open. */
export interface AppRename {
  /** The id of the App being renamed. */
  app: string | undefined;
  field: ReactNode;
  start(app: string, name: string): void;
}

/**
 * A person renames an App in place, in the list or on its page. Only the name people read
 * changes, at once for the draft and what is published; the id stays. `onDone` runs once the
 * field is gone, saved or not, to put the focus back where the rename started.
 */
export function useAppRename(
  workspaceId: string | undefined,
  size: RenameFieldSize,
  onDone?: (app: string) => void
): AppRename {
  const { t } = useTranslation();
  const writes = useAppWrites(workspaceId);
  const [open, setOpen] = useState<{ app: string; name: string }>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const stop = (app: string) => {
    setOpen(undefined);
    setError(undefined);
    if (onDone) window.requestAnimationFrame(() => onDone(app));
  };
  const save = (app: string, title: string) => {
    setSaving(true);
    setError(undefined);
    writes
      .rename(app, title)
      .then(
        () => stop(app),
        (caught: unknown) =>
          setError(
            appRefusalText(caught, t) ?? instanceSentence(caught, t) ?? t("apps.renameFailed")
          )
      )
      .finally(() => setSaving(false));
  };
  return {
    app: open?.app,
    field: open ? (
      <RenameField
        key={open.app}
        size={size}
        value={open.name}
        label={t("apps.renameField")}
        maxLength={APP_NAME_MAX}
        saving={saving}
        error={error}
        onSave={(title) => save(open.app, title)}
        onCancel={() => stop(open.app)}
      />
    ) : undefined,
    start: (app, name) => {
      setError(undefined);
      setOpen({ app, name });
    }
  };
}

/** Puts the focus back on the name of an open App, once it is renamed or left as it was. */
export function focusAppName(): void {
  // The heading came back after the field: it is a new element, focusable as its frame made
  // the first one.
  const title = document.querySelector<HTMLElement>("[data-testid^='app-'] h1");
  if (title) {
    title.tabIndex = -1;
    title.focus({ preventScroll: true });
  }
}
