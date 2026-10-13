import { useState, type FormEvent } from "react";
import { Button, Dialog, Field, Input, Select } from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";
import type { BuildAssetKind, BuildAssetStart } from "./build-asset-kind";
import { assetIdFromTitle } from "./build-model";
import type { BuildNamespace } from "./build-rights";

/** The choice of no Namespace: the id is taken as typed. */
const NO_NAMESPACE = "";

/**
 * Starts a new asset: its name, and its id with the Namespace it is named in. The id follows
 * the name until the reader changes it. Only the Namespaces the reader may write in are
 * offered, and the choice of none only to somebody who may write anywhere.
 */
export function BuildCreateDialog({
  entry,
  heading,
  initialTitle = "",
  namespaces,
  mayNameFreely,
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
  onClose(): void;
  /** Hears the name and the id chosen. A copy adds the definition it starts from itself. */
  onStart(start: Omit<BuildAssetStart, "copyOf">): void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(initialTitle);
  const [typedId, setTypedId] = useState<string>();
  const [prefix, setPrefix] = useState(
    mayNameFreely ? NO_NAMESPACE : (namespaces[0]?.prefix ?? NO_NAMESPACE)
  );
  const id = typedId ?? assetIdFromTitle(title);
  const choices = [
    ...(mayNameFreely ? [{ prefix: NO_NAMESPACE, displayName: t("build.createNoNamespace") }] : []),
    ...namespaces
  ];

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (title.trim() && id.trim()) {
      onStart({ name: `${prefix}${id.trim()}`, title: title.trim() });
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
      </form>
    </Dialog>
  );
}
