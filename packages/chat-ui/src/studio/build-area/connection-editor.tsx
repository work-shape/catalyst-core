import { useState } from "react";
import { useTranslation } from "../../shared/i18n";
import { AssetEditorShell, type AssetSection } from "./asset-editor-shell";
import type { BuildAssetEditorProps } from "./build-asset-kind";
import { ConnectionAuthFields, ConnectionServerFields } from "./connection-form";
import {
  connectionConfigToForm,
  countConnectionFormChanges,
  emptyConnectionForm,
  newConnectionConfig,
  sendsSecret
} from "./connection-form-model";
import { ConnectionPage } from "./connection-page";
import { useConnectionSource, type ConnectionSource } from "./connection-source";

/**
 * The page of a Connection in Build. A new one is a form: the server, how the instance
 * proves itself, and the key. An existing one is the Connection page, with its parts editable
 * where the reader may change it and the Connection was made on the instance.
 */
export function ConnectionAssetEditor(frame: BuildAssetEditorProps) {
  return <ConnectionEditor frame={frame} source={useConnectionSource()} />;
}

/** The same page on a source it is handed, so a test hands it answers of its own. */
export function ConnectionEditor({
  frame,
  source
}: {
  frame: BuildAssetEditorProps;
  source: ConnectionSource;
}) {
  const { asset } = frame;
  if (!asset) {
    return <NewConnectionPage frame={frame} source={source} />;
  }
  const editable = frame.canWrite && asset.config.origin !== "release";
  return (
    <ConnectionPage
      page={frame.page}
      back={frame.back}
      asset={asset}
      actions={frame.actions}
      notice={frame.notice}
      source={source}
      editing={editable ? frame : undefined}
    />
  );
}

/**
 * A new Connection. It is created first and its key entered after it, as its own write: the
 * key is never part of a definition. The frame opens the Connection's page once it exists,
 * where the key shows as set, and the tools of the server as they are read.
 */
function NewConnectionPage({
  frame,
  source
}: {
  frame: BuildAssetEditorProps;
  source: ConnectionSource;
}) {
  const { t } = useTranslation();
  const start = frame.start ?? { name: "", title: "" };
  const initial = start.copyOf ? connectionConfigToForm(start.copyOf) : emptyConnectionForm();
  const [form, setForm] = useState(initial);
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<Awaited<ReturnType<typeof frame.save>>>();

  const submit = async () => {
    setSaving(true);
    const answer = await frame.save(newConnectionConfig(start, form));
    if (answer.ok && sendsSecret(form.authScheme) && secret !== "") {
      // The Connection exists and its page is open. A key that could not be stored shows
      // there as not set, with the field to enter it again.
      await source.setSecret(start.name, secret, null).catch(() => undefined);
    }
    setSaving(false);
    setOutcome(answer);
    return answer;
  };
  const sections: AssetSection[] = [
    {
      id: "server",
      label: t("connections.serverTitle"),
      description: t("connections.serverDescription"),
      body: <ConnectionServerFields form={form} onChange={setForm} />
    },
    {
      id: "authentication",
      label: t("connections.authTitle"),
      description: t("connections.authDescription"),
      body: (
        <ConnectionAuthFields
          form={form}
          onChange={setForm}
          secret={{ value: secret, onChange: setSecret }}
        />
      )
    }
  ];
  return (
    <AssetEditorShell
      frame={frame}
      title={start.title || start.name}
      sections={sections}
      control={{
        changes: countConnectionFormChanges(form, initial) + Number(secret !== ""),
        submit,
        discard: () => {
          setForm(initial);
          setSecret("");
        }
      }}
      outcome={outcome}
      saving={saving}
      saveLabel={t("connections.create")}
    />
  );
}
