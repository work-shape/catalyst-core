import { useEffect, useState, type ReactNode } from "react";
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  Field,
  FormNotice,
  List,
  Select,
  SkeletonList
} from "@vivd-catalyst/ui";
import type { ConnectionDetail, ConnectionDiscoveredTool } from "@vivd-catalyst/api-client";
import { useTranslation } from "../i18n";
import type { BuildAsset, BuildAssetEditorProps } from "./build-asset-kind";
import { instanceSentence, PendingApprovalError, type BuildWriteOutcome } from "./build-refusals";
import {
  ConnectionAuthFields,
  ConnectionSecretField,
  ConnectionServerFields
} from "./connection-form";
import {
  connectionConfigToForm,
  countConnectionFormChanges,
  withAcceptedOperation,
  withConnectionForm
} from "./connection-form-model";
import type { ConnectionSource } from "./connection-source";

// The parts of the Connection page that change a Connection made on the instance: its
// settings, its key and which tools it accepts. Each part saves on its own, through the
// frame's save of the definition or through the write of the key, and names what failed.

/** What a refused write says on the page. A conflict is told by the frame's notice instead. */
function refusalText(outcome: BuildWriteOutcome): string | undefined {
  if (outcome.ok || outcome.conflict) return undefined;
  return outcome.refusals.map((refusal) => refusal.message).join(" ");
}

/**
 * One write of the definition from a part of the page: the frame saves it against the
 * revision the page holds. `written` hears of every write that was stored.
 */
export function useConnectionWrite(frame: BuildAssetEditorProps, written: () => void) {
  const { t } = useTranslation();
  const [saving, setSaving] = useState<string>();
  const [failure, setFailure] = useState<string>();
  return {
    saving,
    failure,
    async write(key: string, config: Record<string, unknown>): Promise<boolean> {
      setSaving(key);
      setFailure(undefined);
      const outcome = await frame.save(config);
      setSaving(undefined);
      if (outcome.ok) {
        written();
        return true;
      }
      const text = refusalText(outcome);
      if (!outcome.conflict) setFailure(text || t("connections.writeFailed"));
      return false;
    }
  };
}

/** The address and the auth scheme, shown as they are and changed after Edit. */
export function ConnectionSettingsEditor({
  asset,
  frame,
  written,
  view
}: {
  asset: BuildAsset;
  frame: BuildAssetEditorProps;
  written(): void;
  /** The settings as the page shows them while nobody edits them. */
  view: ReactNode;
}) {
  const { t } = useTranslation();
  const stored = connectionConfigToForm(asset.config);
  const [form, setForm] = useState<typeof stored>();
  const write = useConnectionWrite(frame, written);
  const changes = form ? countConnectionFormChanges(form, stored) : 0;
  const { onUnsavedChange } = frame;
  useEffect(() => {
    onUnsavedChange(changes > 0);
    return () => onUnsavedChange(false);
  }, [changes, onUnsavedChange]);

  if (!form) {
    return (
      <div className="grid gap-3">
        {view}
        <Button
          variant="outline"
          size="sm"
          className="justify-self-start"
          disabled={frame.saveBlocked}
          onClick={() => setForm(stored)}
        >
          {t("connections.settingsEdit")}
        </Button>
      </div>
    );
  }
  return (
    <form
      className="grid gap-4"
      data-connection-settings-form=""
      onSubmit={(event) => {
        event.preventDefault();
        write
          .write("settings", withConnectionForm(asset.config, form))
          .then((saved) => {
            if (saved) setForm(undefined);
          })
          .catch(() => undefined);
      }}
    >
      <ConnectionServerFields form={form} onChange={setForm} />
      <ConnectionAuthFields form={form} onChange={setForm} />
      {write.failure ? <FormNotice tone="error">{write.failure}</FormNotice> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          size="sm"
          loading={write.saving === "settings"}
          disabled={changes === 0 || frame.saveBlocked}
        >
          {t("connections.settingsSave")}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setForm(undefined)}>
          {t("connections.settingsCancel")}
        </Button>
      </div>
    </form>
  );
}

/**
 * The key of the Connection: entered, never shown. A new one replaces the version the page
 * read; somebody else's version in between refuses it.
 */
export function ConnectionSecretEditor({
  name,
  secret,
  source,
  written
}: {
  name: string;
  secret: ConnectionDetail["secret"];
  source: ConnectionSource;
  written(): void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ tone: "success" | "error"; text: string }>();
  if (value === undefined) {
    return (
      <div className="grid justify-items-start gap-1">
        <Button
          variant="outline"
          size="sm"
          data-connection-secret-open=""
          onClick={() => {
            setValue("");
            setResult(undefined);
          }}
        >
          {t(secret.state === "set" ? "connections.secretReplace" : "connections.secretEnter")}
        </Button>
        {result ? <FormNotice tone={result.tone}>{result.text}</FormNotice> : null}
      </div>
    );
  }
  return (
    <form
      className="grid w-full gap-2"
      data-connection-secret-form=""
      onSubmit={(event) => {
        event.preventDefault();
        setSaving(true);
        source
          .setSecret(name, value, secret.version ?? null)
          .then(
            () => {
              setValue(undefined);
              setResult({ tone: "success", text: t("connections.secretSaved") });
              written();
            },
            (error: unknown) =>
              setResult({
                tone: "error",
                text: instanceSentence(error) ?? t("connections.secretFailed")
              })
          )
          .finally(() => setSaving(false));
      }}
    >
      <ConnectionSecretField value={value} onChange={setValue} />
      {result?.tone === "error" ? <FormNotice tone="error">{result.text}</FormNotice> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" loading={saving} disabled={value === ""}>
          {t("connections.secretSave")}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setValue(undefined)}>
          {t("connections.secretCancel")}
        </Button>
      </div>
    </form>
  );
}

/**
 * What the server offers that the Connection does not accept, each with what it does and
 * whether agents may use it, to accept. "Read tools again" asks for a new discovery.
 */
export function DiscoveredTools({
  name,
  asset,
  frame,
  detail,
  waiting,
  source,
  written
}: {
  name: string;
  asset: BuildAsset;
  frame: BuildAssetEditorProps;
  detail: ConnectionDetail | undefined;
  /** The page waits for a discovery it asked for. */
  waiting: boolean;
  source: ConnectionSource;
  written(): void;
}) {
  const { t } = useTranslation();
  const write = useConnectionWrite(frame, written);
  const [asking, setAsking] = useState(false);
  const [asked, setAsked] = useState<string>();
  const discover = () => {
    setAsking(true);
    setAsked(undefined);
    source
      .discover(name)
      .then(written, (error: unknown) =>
        setAsked(
          error instanceof PendingApprovalError
            ? t("connections.discoverHeld")
            : (instanceSentence(error) ?? t("connections.discoverFailed"))
        )
      )
      .finally(() => setAsking(false));
  };
  const tools = detail?.discovered ?? [];
  const body = !detail ? (
    <SkeletonList rows={2} />
  ) : tools.length > 0 ? (
    <List aria-label={t("connections.discoveredTitle")}>
      {tools.map((tool) => (
        <DiscoveredTool
          key={tool.name}
          tool={tool}
          saving={write.saving === tool.name}
          blocked={frame.saveBlocked === true || write.saving !== undefined}
          accept={(choice) =>
            write.write(tool.name, withAcceptedOperation(asset.config, { ...tool, ...choice }))
          }
        />
      ))}
    </List>
  ) : (
    <EmptyState layout="inline" data-connection-discovered-empty="">
      {t(
        waiting
          ? "connections.discoveredWaiting"
          : detail.discoveredAt
            ? "connections.discoveredEmpty"
            : detail.lastErrorCode
              ? "connections.discoveredFailed"
              : "connections.discoveredNever"
      )}
    </EmptyState>
  );
  return (
    <div className="grid gap-3">
      {body}
      {write.failure ? <FormNotice tone="error">{write.failure}</FormNotice> : null}
      <div className="grid justify-items-start gap-1">
        <Button variant="outline" size="sm" loading={asking || waiting} onClick={discover}>
          {t("connections.discoverAgain")}
        </Button>
        {asked ? <FormNotice tone="error">{asked}</FormNotice> : null}
      </div>
    </div>
  );
}

function DiscoveredTool({
  tool,
  saving,
  blocked,
  accept
}: {
  tool: ConnectionDiscoveredTool;
  saving: boolean;
  blocked: boolean;
  accept(choice: { effect: "reading" | "changing"; forAgents: boolean }): Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [effect, setEffect] = useState(tool.proposedEffect);
  const [forAgents, setForAgents] = useState(true);
  return (
    <li
      data-connection-discovered={tool.name}
      className="grid min-w-0 gap-2 border-b py-3 first:pt-0 last:border-b-0 last:pb-0"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <code className="min-w-0 font-mono text-label break-all">{tool.name}</code>
        <Badge tone={tool.proposedEffect === "changing" ? "warning" : "neutral"}>
          {t(
            tool.proposedEffect === "changing"
              ? "connections.effectChanging"
              : "connections.effectReading"
          )}
        </Badge>
      </div>
      {tool.description ? (
        <p className="line-clamp-3 text-body whitespace-pre-line">{tool.description}</p>
      ) : null}
      <p className="text-caption text-muted-foreground">
        {t(
          tool.proposedEffect === "reading"
            ? "connections.proposedReading"
            : "connections.proposedChanging"
        )}
      </p>
      <div className="flex min-w-0 flex-wrap items-end gap-3">
        <Field label={t("connections.acceptEffect")} className="w-44">
          <Select
            size="sm"
            value={effect}
            onChange={(event) =>
              setEffect(event.target.value === "changing" ? "changing" : "reading")
            }
          >
            <option value="reading">{t("connections.effectReading")}</option>
            <option value="changing">{t("connections.effectChanging")}</option>
          </Select>
        </Field>
        <Checkbox
          label={t("connections.acceptForAgents")}
          checked={forAgents}
          onCheckedChange={setForAgents}
        />
        <Button
          size="sm"
          loading={saving}
          disabled={blocked}
          data-connection-accept={tool.name}
          onClick={() => {
            accept({ effect, forAgents }).catch(() => undefined);
          }}
        >
          {t("connections.accept")}
        </Button>
      </div>
    </li>
  );
}
