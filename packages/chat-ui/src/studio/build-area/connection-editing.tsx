import { useEffect, useState, type ReactNode } from "react";
import {
  Banner,
  Button,
  ConfirmDialog,
  EmptyState,
  FormNotice,
  SkeletonList
} from "@work-shape/catalyst-ui";
import type { ConnectionDetail } from "@work-shape/catalyst-api-client";
import { useTranslation, type TranslationContextValue } from "../../shared/i18n";
import type { BuildAsset, BuildAssetEditorProps } from "./build-asset-kind";
import { instanceSentence, PendingApprovalError } from "./build-refusals";
import {
  ConnectionAuthFields,
  ConnectionSecretField,
  ConnectionServerFields
} from "./connection-form";
import { ConnectionApprovalList, approveLabel, useApprovalChoice } from "./connection-approval";
import { usedByNames } from "./connection-used-by";
import {
  discoveredCandidates,
  selectedCandidates,
  type ApprovalCandidate
} from "./connection-approval-model";
import {
  connectionConfigToForm,
  countConnectionFormChanges,
  sendsSecret,
  withApprovedOperations,
  withConnectionForm
} from "./connection-form-model";
import { connectionRefusalOf, type ConnectionRefusal } from "./connection-refusals";
import type { ConnectionSource } from "./connection-source";
import { RefusalNotice } from "./refusal-notice";
import type { ActionNotice } from "./build-model";

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
  view,
  keyUsers
}: {
  asset: BuildAsset;
  frame: BuildAssetEditorProps;
  written(): void;
  /** The settings as the page shows them while nobody edits them. */
  view: ReactNode;
  /**
   * What uses the Connection, where a key is stored: a change to no key deletes it
   * (spec CS :373), and the form says whom that stops.
   */
  keyUsers?: KeyUsers;
}) {
  const { locale, t } = useTranslation();
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
      {keyUsers && sendsSecret(stored.authScheme) && form.authScheme === "none" ? (
        <Banner layout="line" tone="warning" data-connection-key-clears="">
          {keyRemovalWarning(keyUsers, locale, t)}
        </Banner>
      ) : null}
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

/** What "Used by" lists: the agents that carry the Connection's tools and the other assets. */
type KeyUsers = Pick<ConnectionDetail, "usedBy" | "usedByAssets">;

/** Whom deleting the key stops: everything "Used by" lists. */
function keyRemovalWarning(
  usedBy: KeyUsers,
  locale: string,
  t: TranslationContextValue["t"]
): string {
  const users = usedByNames(usedBy, t);
  return users.length === 0
    ? t("connections.secretRemoveNoAgents")
    : t("connections.secretRemoveAgents", {
        users: new Intl.ListFormat(locale, { type: "conjunction" }).format(users)
      });
}

/**
 * The key of the Connection: entered, never shown. A new one replaces the version the page
 * read; somebody else's version in between refuses it. A saved key is tested at once, so the
 * status says whether the outside system takes it. "Remove key" saves the definition without a
 * key, which deletes it, after a warning that names who uses the Connection.
 */
export function ConnectionSecretEditor({
  name,
  secret,
  source,
  written,
  retest,
  removal
}: {
  name: string;
  secret: ConnectionDetail["secret"];
  source: ConnectionSource;
  written(): void;
  /** Tests the Connection with the key just saved. */
  retest?: () => void;
  /** Where the reader may change the definition: the write that deletes the key. */
  removal?: {
    frame: BuildAssetEditorProps;
    config: Record<string, unknown>;
    usedBy: KeyUsers;
  };
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<ActionNotice>();
  if (value === undefined) {
    return (
      <div className="grid justify-items-start gap-1">
        <div className="flex flex-wrap gap-2">
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
          {removal && secret.state === "set" ? (
            <ConnectionKeyRemoval
              {...removal}
              written={written}
              onOpen={() => setResult(undefined)}
            />
          ) : null}
        </div>
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
              retest?.();
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
 * "Remove key" and its question: the definition is saved without a key, which deletes the key
 * stored for it (spec CS :373). A refusal stays in the question, beside the warning. Once
 * saved, the Credential row says the Connection sends none.
 */
function ConnectionKeyRemoval({
  frame,
  config,
  usedBy,
  written,
  onOpen
}: {
  frame: BuildAssetEditorProps;
  config: Record<string, unknown>;
  usedBy: KeyUsers;
  written(): void;
  onOpen(): void;
}) {
  const { locale, t } = useTranslation();
  const [open, setOpen] = useState(false);
  const write = useConnectionWrite(frame, written);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={frame.saveBlocked}
        data-connection-secret-remove=""
        onClick={() => {
          onOpen();
          setOpen(true);
        }}
      >
        {t("connections.secretRemove")}
      </Button>
      <ConfirmDialog
        open={open}
        title={t("connections.secretRemoveTitle")}
        confirmLabel={t("connections.secretRemove")}
        loading={write.saving === "key"}
        onClose={() => setOpen(false)}
        onConfirm={() => {
          const form = connectionConfigToForm(config);
          write
            .write("key", withConnectionForm(config, { ...form, authScheme: "none" }))
            .then((removed) => {
              if (removed) setOpen(false);
            })
            .catch(() => undefined);
        }}
      >
        <div className="grid gap-2">
          <p data-connection-secret-remove-warning="">{keyRemovalWarning(usedBy, locale, t)}</p>
          {write.failure ? <RefusalNotice {...write.failure} /> : null}
        </div>
      </ConfirmDialog>
    </>
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
  const chosen = selectedCandidates(candidates, approval.choice.selected, approval.choice.effects);
  return (
    <div className="grid gap-3" data-connection-discovered="">
      <ConnectionApprovalList
        candidates={candidates}
        choice={approval.choice}
        onSelectedChange={approval.setSelected}
        onSurfacesChange={approval.setSurfaces}
        onEffectsChange={approval.setEffects}
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
