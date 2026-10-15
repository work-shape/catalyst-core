import { useState, type FormEvent } from "react";
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
} from "@vivd-catalyst/ui";
import type { CheckName } from "../api/asset-writes";
import { useTranslation } from "../i18n";
import type { BuildAssetKind, BuildAssetStart } from "./build-asset-kind";
import { assetIdFromTitle } from "./build-model";
import type { BuildNamespace } from "./build-rights";
import { addressBlocksCreate, useAddressCheck } from "./name-check";

/** The choice of no Namespace: the id is taken as typed. */
const NO_NAMESPACE = "";

/** Where a new asset of a kind that starts in its workspace is made, and who may widen that. */
export interface BuildCreateStart {
  /** The shared workspace the reader works in. Absent in a personal one. */
  workspace: { id: string; name: string } | undefined;
  /** The reader may make the asset available in every workspace. */
  mayChooseAll: boolean;
}

/**
 * Starts a new asset: its name, and under "Advanced" its address with the Namespace it is
 * named in. The address follows the name until the reader changes it, and is checked as it
 * changes; Continue waits for the check and stops at a refused address. Only the Namespaces
 * the reader may write in are offered, and the choice of none only to somebody who may write
 * anywhere. A kind that starts in its workspace says where the asset will be available, and
 * lets whoever may change that choose every workspace instead. A kind that names what its
 * asset does asks that too.
 */
export function BuildCreateDialog({
  entry,
  heading,
  initialTitle = "",
  namespaces,
  mayNameFreely,
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
  namespaces: readonly BuildNamespace[];
  mayNameFreely: boolean;
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
  const [prefix, setPrefix] = useState(
    mayNameFreely ? NO_NAMESPACE : (namespaces[0]?.prefix ?? NO_NAMESPACE)
  );
  const [everywhere, setEverywhere] = useState(false);
  const title = value.name.trim();
  const id = addressOf(value, assetIdFromTitle).trim();
  const name = id === "" ? "" : `${prefix}${id}`;
  const check = useAddressCheck(checkName, name);
  const choices = [
    ...(mayNameFreely ? [{ prefix: NO_NAMESPACE, displayName: t("build.createNoNamespace") }] : []),
    ...namespaces
  ];

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (title && id && !addressBlocksCreate(check)) {
      const availableIn = everywhere
        ? ("all" as const)
        : startsIn?.workspace && { workspaceId: startsIn.workspace.id };
      onStart({
        name,
        title,
        ...(purpose.trim() ? { description: purpose.trim() } : {}),
        ...(availableIn ? { availableIn } : {})
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
          derive={assetIdFromTitle}
          check={check}
          nameLabel={t(entry.titleLabel)}
          addressLabel={t("build.createAddress")}
          addressHint={
            prefix === NO_NAMESPACE
              ? t("build.createAddressHint")
              : t("build.createAddressHintNamespace", { id: name })
          }
          advancedLabel={t("build.createAdvanced")}
          advanced={
            choices.length > 1 ? (
              <Field label={t("build.createNamespace")}>
                <Select value={prefix} onChange={(event) => setPrefix(event.target.value)}>
                  {choices.map((choice) => (
                    <option key={choice.prefix} value={choice.prefix}>
                      {choice.prefix === NO_NAMESPACE
                        ? choice.displayName
                        : `${choice.displayName} (${choice.prefix})`}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : undefined
          }
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
