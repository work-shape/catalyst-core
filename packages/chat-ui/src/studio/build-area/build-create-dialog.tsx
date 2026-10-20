import { useState, type FormEvent } from "react";
import { assetAddressFromName } from "@work-shape/catalyst-core";
import {
  Button,
  Dialog,
  Field,
  KeyValue,
  KeyValueList,
  NameWithAddress,
  Select,
  Textarea,
  addressOf,
  type NameAndAddress
} from "@work-shape/catalyst-ui";
import type { CheckName } from "../../shared/api/asset-writes";
import { useTranslation } from "../../shared/i18n";
import type { BuildAssetKind, BuildAssetStart } from "./build-asset-kind";
import { addressBlocksCreate, useAddressCheck } from "./name-check";

/** Where a new asset of a kind that starts in its workspace is made, and who may widen that. */
export interface BuildCreateStart {
  /** The shared workspace the reader works in. Absent in a personal one. */
  workspace: { id: string; name: string } | undefined;
  /** The reader may make the asset available in every workspace. */
  mayChooseAll: boolean;
}

/**
 * Starts a new asset: its name, and under "Advanced" its address. The address follows the name
 * until the reader changes it, and is checked as it changes; Continue stops at a refused
 * address. A kind that starts in its workspace says where the asset will be available, and
 * lets whoever may change that choose every workspace instead. A kind that names what its
 * asset does asks that too.
 */
export function BuildCreateDialog({
  entry,
  heading,
  initialTitle = "",
  startsIn,
  checkName,
  onClose,
  onStart
}: {
  entry: BuildAssetKind;
  /** The dialog's title where it starts something else than an empty asset, such as a copy. */
  heading?: string;
  /** The name the dialog starts with, such as the name of the asset a copy is made of. */
  initialTitle?: string;
  /** Present for a kind that starts in its workspace. */
  startsIn: BuildCreateStart | undefined;
  /** Asks the instance about the whole address. Without it nothing is checked before the save. */
  checkName?: CheckName;
  onClose(): void;
  /** Hears the name and the id chosen. A copy adds the definition it starts from itself. */
  onStart(start: Omit<BuildAssetStart, "copyOf">): void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState<NameAndAddress>({ name: initialTitle });
  const [purpose, setPurpose] = useState("");
  const [everywhere, setEverywhere] = useState(false);
  const title = value.name.trim();
  const derive = (named: string) => assetAddressFromName(named, entry.kind);
  const id = addressOf(value, derive).trim();
  const check = useAddressCheck(checkName, id);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (title && id && !addressBlocksCreate(check)) {
      const availableIn = everywhere
        ? ("all" as const)
        : startsIn?.workspace && { workspaceId: startsIn.workspace.id };
      onStart({
        name: id,
        title,
        ...(purpose.trim() ? { description: purpose.trim() } : {}),
        ...(availableIn ? { availableIn } : {}),
        ...(availableIn && availableIn !== "all" && startsIn?.workspace
          ? { availableInName: startsIn.workspace.name }
          : {})
      });
    }
  };

  return (
    <Dialog
      open
      size="sm"
      title={heading ?? t(entry.newLabel)}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            type="submit"
            form="build-create-form"
            disabled={!title || !id || addressBlocksCreate(check)}
          >
            {t("build.createContinue")}
          </Button>
        </>
      }
    >
      <form id="build-create-form" onSubmit={submit}>
        <NameWithAddress
          autoFocus
          value={value}
          onChange={setValue}
          derive={derive}
          check={check}
          nameLabel={t(entry.titleLabel)}
          addressLabel={t("build.createAddress")}
          addressHint={t("build.createAddressHint")}
          advancedLabel={t("build.createAdvanced")}
        >
          {entry.purposeLabel ? (
            <Field label={t(entry.purposeLabel)} optional>
              <Textarea
                rows={2}
                value={purpose}
                onChange={(event) => setPurpose(event.target.value)}
              />
            </Field>
          ) : null}
          {startsIn ? (
            <AvailableIn startsIn={startsIn} everywhere={everywhere} onChange={setEverywhere} />
          ) : null}
        </NameWithAddress>
      </form>
    </Dialog>
  );
}

/** Where the new asset will be available: a choice for whoever may widen it, a line otherwise. */
function AvailableIn({
  startsIn,
  everywhere,
  onChange
}: {
  startsIn: BuildCreateStart;
  everywhere: boolean;
  onChange(everywhere: boolean): void;
}) {
  const { t } = useTranslation();
  const where = startsIn.workspace?.name ?? t("build.createAvailableHidden");
  const hint =
    startsIn.workspace && !everywhere ? t("build.createAvailableWorkspaceHint") : undefined;
  if (!startsIn.mayChooseAll) {
    return (
      <KeyValueList layout="stacked">
        <KeyValue label={t("configAvailability")}>{where}</KeyValue>
      </KeyValueList>
    );
  }
  return (
    <Field label={t("configAvailability")} hint={hint}>
      <Select
        value={everywhere ? "all" : "start"}
        onChange={(event) => onChange(event.target.value === "all")}
      >
        <option value="start">{where}</option>
        <option value="all">{t("configAvailabilityAll")}</option>
      </Select>
    </Field>
  );
}
