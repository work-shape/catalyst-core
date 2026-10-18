import { useEffect, useState, type ReactNode } from "react";
import { Button, EmptyState, FormNotice, SkeletonList } from "@work-shape/catalyst-ui";
import type { ConnectionDetail } from "@work-shape/catalyst-api-client";
import { useTranslation } from "../../shared/i18n";
import type { BuildAsset, BuildAssetEditorProps } from "./build-asset-kind";
import { instanceSentence, PendingApprovalError } from "./build-refusals";
import {
  ConnectionAuthFields,
  ConnectionSecretField,
  ConnectionServerFields
} from "./connection-form";
import { ConnectionApprovalList, approveLabel, useApprovalChoice } from "./connection-approval";
import {
  discoveredCandidates,
  selectedCandidates,
  type ApprovalCandidate
} from "./connection-approval-model";
import {
  connectionConfigToForm,
  countConnectionFormChanges,
  withApprovedOperations,
  withConnectionForm
} from "./connection-form-model";
import { connectionRefusalOf, type ConnectionRefusal } from "./connection-refusals";
import type { ConnectionSource } from "./connection-source";
import { RefusalNotice } from "./refusal-notice";

// The parts of the Connection page that change a Connection made on the instance: its
// settings, its key and which tools it accepts. Each part saves on its own, through the
// frame's save of the definition or through the write of the key, and names what failed.

/**
 * One write of the definition from a part of the page: the frame saves it against the
 * revision the page holds. `written` hears of every write that was stored.
 */
export function useConnectionWrite(frame: BuildAssetEditorProps, written: () => void) {
  const { t } = useTranslation();
  const [saving, setSaving] = useState<string>();
  const [failure, setFailure] = useState<ConnectionRefusal>();
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
      // The settings hold the address, which the instance refuses most often.
      if (!outcome.conflict)
        setFailure(
          connectionRefusalOf(
            outcome,
            key === "settings" ? "connections.refusedSettings" : "connections.refusedUnknown",
            t
          )
        );
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
      <ConnectionAuthFields
        form={form}
        onChange={setForm}
        offersOAuth={stored.authScheme === "oauth"}
      />
      {write.failure ? <RefusalNotice {...write.failure} /> : null}
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
 * What the server offers that the Connection does not accept, as one list to approve at once:
 * the tools that only read are ticked, and one row says who may use what is approved. "Read
 * tools again" asks for a new discovery.
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
  const candidates = discoveredCandidates(detail?.discovered ?? []);
  // A new discovery starts the list again: what is ticked follows what the server now offers.
  const listKey = candidates
    .map((candidate) => `${candidate.name}:${candidate.schemaFingerprint ?? ""}`)
    .join("|");
  const body = !detail ? (
    <SkeletonList rows={2} />
  ) : candidates.length > 0 ? (
    <DiscoveredApproval
      key={listKey}
      candidates={candidates}
      saving={write.saving === "approve"}
      blocked={frame.saveBlocked === true || write.saving !== undefined}
      approve={(chosen, surfaces) =>
        write.write("approve", withApprovedOperations(asset.config, chosen, surfaces))
      }
    />
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
      {write.failure ? <RefusalNotice {...write.failure} /> : null}
      <div className="grid justify-items-start gap-1">
        <Button variant="outline" size="sm" loading={asking || waiting} onClick={discover}>
          {t("connections.discoverAgain")}
        </Button>
        {asked ? <FormNotice tone="error">{asked}</FormNotice> : null}
      </div>
    </div>
  );
}

function DiscoveredApproval({
  candidates,
  saving,
  blocked,
  approve
}: {
  candidates: ApprovalCandidate[];
  saving: boolean;
  blocked: boolean;
  approve(chosen: ApprovalCandidate[], surfaces: string[]): Promise<boolean>;
}) {
  const { t } = useTranslation();
  const approval = useApprovalChoice(candidates);
  const chosen = selectedCandidates(candidates, approval.choice.selected);
  return (
    <div className="grid gap-3" data-connection-discovered="">
      <ConnectionApprovalList
        candidates={candidates}
        choice={approval.choice}
        onSelectedChange={approval.setSelected}
        onSurfacesChange={approval.setSurfaces}
        disabled={blocked}
      />
      <Button
        className="justify-self-start"
        loading={saving}
        disabled={blocked || chosen.length === 0}
        data-connection-approve=""
        onClick={() => {
          approve(chosen, [...approval.choice.surfaces]).catch(() => undefined);
        }}
      >
        {approveLabel(chosen.length, t)}
      </Button>
    </div>
  );
}
