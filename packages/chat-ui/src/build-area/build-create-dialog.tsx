import { useState, type FormEvent } from "react";
import { Button, Dialog, Field, Input, KeyValue, KeyValueList, Select } from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";
import type { BuildAssetKind, BuildAssetStart } from "./build-asset-kind";
import { assetIdFromTitle } from "./build-model";
import type { BuildNamespace } from "./build-rights";

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
 * Starts a new asset: its name, and its id with the Namespace it is named in. The id follows
 * the name until the reader changes it. Only the Namespaces the reader may write in are
 * offered, and the choice of none only to somebody who may write anywhere. A kind that starts
 * in its workspace says where the asset will be available, and lets whoever may change that
 * choose every workspace instead.
 */
export function BuildCreateDialog({
  entry,
  namespaces,
  mayNameFreely,
  startsIn,
  onClose,
  onStart
}: {
  entry: BuildAssetKind;
  namespaces: readonly BuildNamespace[];
  mayNameFreely: boolean;
  /** Present for a kind that starts in its workspace. */
  startsIn: BuildCreateStart | undefined;
  onClose(): void;
  onStart(start: BuildAssetStart): void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [typedId, setTypedId] = useState<string>();
  const [prefix, setPrefix] = useState(
    mayNameFreely ? NO_NAMESPACE : (namespaces[0]?.prefix ?? NO_NAMESPACE)
  );
  const [everywhere, setEverywhere] = useState(false);
  const id = typedId ?? assetIdFromTitle(title);
  const choices = [
    ...(mayNameFreely ? [{ prefix: NO_NAMESPACE, displayName: t("build.createNoNamespace") }] : []),
    ...namespaces
  ];

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (title.trim() && id.trim()) {
      const availableIn = everywhere
        ? ("all" as const)
        : startsIn?.workspace && { workspaceId: startsIn.workspace.id };
      onStart({
        name: `${prefix}${id.trim()}`,
        title: title.trim(),
        ...(availableIn ? { availableIn } : {})
      });
    }
  };

  return (
    <Dialog
      open
      size="sm"
      title={t(entry.newLabel)}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" form="build-create-form">
            {t("build.createContinue")}
          </Button>
        </>
      }
    >
      <form id="build-create-form" className="grid gap-4" onSubmit={submit}>
        <Field label={t(entry.titleLabel)} required>
          <Input
            autoFocus
            value={title}
            required
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        {choices.length > 1 ? (
          <Field label={t("build.createNamespace")} hint={t("build.createNamespaceHint")}>
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
        ) : null}
        <Field
          label={t("build.createId")}
          required
          hint={
            prefix === NO_NAMESPACE
              ? t("build.createIdHint")
              : t("build.createIdHintNamespace", { id: `${prefix}${id}` })
          }
        >
          <Input
            value={id}
            required
            className="font-mono"
            onChange={(event) => setTypedId(event.target.value)}
          />
        </Field>
        {startsIn ? (
          <AvailableIn startsIn={startsIn} everywhere={everywhere} onChange={setEverywhere} />
        ) : null}
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
