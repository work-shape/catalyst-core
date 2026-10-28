import { useEffect, useState } from "react";
import { Button } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import {
  AvailabilityFields,
  useAvailabilityEdit,
  type AvailabilityChoice
} from "./asset-availability-fields";

/**
 * Where agents can use a Connection, as a section of its page. The Connection page has no save
 * bar: like its settings, the section saves itself, and its buttons show once it changed.
 */
export function ConnectionAvailability({
  choice,
  saveBlocked = false,
  onUnsavedChange
}: {
  choice: AvailabilityChoice;
  saveBlocked?: boolean;
  onUnsavedChange(unsaved: boolean): void;
}) {
  const { t } = useTranslation();
  const edit = useAvailabilityEdit(choice);
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<string>();
  const { changed } = edit;
  useEffect(() => {
    onUnsavedChange(changed);
    return () => onUnsavedChange(false);
  }, [changed, onUnsavedChange]);

  return (
    <form
      className="grid gap-4"
      data-connection-availability=""
      onSubmit={(event) => {
        event.preventDefault();
        setSaving(true);
        edit
          .save()
          .then(setRefused)
          .finally(() => setSaving(false))
          .catch(() => undefined);
      }}
    >
      <AvailabilityFields
        edit={edit}
        disabled={saving}
        workspaces={choice.workspaces}
        workspacesError={choice.workspacesError}
        fixedReason={choice.fixedReason}
        hiddenHint={t("configAvailabilityAssetHiddenHint")}
        refusals={refused === undefined ? [] : [refused]}
      />
      {changed ? (
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" loading={saving} disabled={saveBlocked}>
            {t("configSaveChanges")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={() => {
              edit.discard();
              setRefused(undefined);
            }}
          >
            {t("connections.settingsCancel")}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
