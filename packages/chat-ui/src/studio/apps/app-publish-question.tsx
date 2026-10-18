import { useEffect, useState } from "react";
import { RadioGroup } from "@work-shape/catalyst-ui";
import { instanceSentence, PendingApprovalError } from "../build-area/build-refusals";
import { useTranslation, type TranslationContextValue } from "../../shared/i18n";
import { useApp, useAppWrites, type AppAudience, type AppAudienceOffer } from "./app-data";
import {
  appDraftRevision,
  appDraftShown,
  appManifestSummary,
  appReadsStoredData,
  appRefusalText,
  appTitle,
  type AppManifestSummary
} from "./app-model";
import { useAppsHost, type AppsWorkspace } from "./apps-host";

// "For whom?" (SHARE-1): the first question of an App's Publish dialog. The choices are the
// ones the instance offers this person: "Only me", the workspace that owns the App, and the
// whole instance only where the person may publish at instance scope.

/** The words of one choice. The workspace is named by its own name. */
function appAudienceChoiceLabel(
  audience: AppAudience,
  workspaceName: string,
  t: TranslationContextValue["t"]
): string {
  if (audience === "self") return t("apps.publishAudienceSelf");
  if (audience === "instance") return t("apps.publishAudienceInstance");
  return workspaceName;
}

/** The question, with the choices the instance offers in its order. */
export function AppAudienceQuestion({
  offer,
  selected,
  workspaceName,
  disabled,
  onChange
}: {
  offer: AppAudienceOffer;
  selected: AppAudience;
  workspaceName: string;
  disabled?: boolean;
  onChange(audience: AppAudience): void;
}) {
  const { t } = useTranslation();
  return (
    <div data-testid="app-publish-audience">
      <RadioGroup<AppAudience>
        variant="plain"
        label={t("apps.publishAudience")}
        value={selected}
        disabled={disabled}
        options={offer.choices.map((choice) => ({
          value: choice,
          label: appAudienceChoiceLabel(choice, workspaceName, t)
        }))}
        onValueChange={onChange}
      />
    </div>
  );
}

/** The sentence under "Details" on who gets the revision, by the chosen audience. */
export function appPublishBody(
  audience: AppAudience | undefined,
  revision: number,
  workspaceName: string,
  t: TranslationContextValue["t"]
): string {
  if (audience === "self") return t("apps.publishBodySelf", { number: revision });
  if (audience === "instance") return t("apps.publishBodyInstance", { number: revision });
  return t("apps.publishBody", { number: revision, workspace: workspaceName });
}

/** Where a publish sent from the dialog stands. */
export interface AppPublishSend {
  busy: boolean;
  error: string | undefined;
  /** The publish waits for an approver: the live revision stays until then. */
  waits: boolean;
  /** Sends the publish: made live, held for an approver, or refused. */
  send(
    revision: number,
    audience: AppAudience | undefined
  ): Promise<"published" | "waits" | "failed">;
}

/** The publish the dialog sends itself, with the audience it asked for. */
export function useAppPublishSend(workspaceId: string, app: string): AppPublishSend {
  const { t } = useTranslation();
  const writes = useAppWrites(workspaceId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [waits, setWaits] = useState(false);
  return {
    busy,
    error,
    waits,
    send: async (revision, audience) => {
      setBusy(true);
      setError(undefined);
      try {
        await writes.publish(app, revision, audience);
        return "published";
      } catch (caught) {
        if (caught instanceof PendingApprovalError) {
          setWaits(true);
          return "waits";
        }
        const refusal = appRefusalText(caught);
        setError(refusal ? t(refusal) : (instanceSentence(caught) ?? t("apps.publishFailed")));
        return "failed";
      } finally {
        setBusy(false);
      }
    }
  };
}

/** What "Share" asks the Publish dialog about: the App's draft, in the open workspace. */
export interface SharePublishQuestion {
  name: string;
  workspace: AppsWorkspace;
  ask: { revision: number; summary: AppManifestSummary; readsStoredData: boolean };
}

/**
 * Reads the draft "Share" asks about, for a reader who may write and publish Apps. A draft that
 * is what is live is asked about too: Share may change only who the App is for. Where the
 * reader may not publish, or the draft cannot be read, it calls `onClose` and asks nothing.
 */
export function useSharePublishQuestion(
  app: string,
  onClose: () => void
): SharePublishQuestion | undefined {
  const host = useAppsHost();
  const workspace = host?.workspace;
  const mayWrite = Boolean(workspace && host?.rights.write);
  const record = useApp(workspace?.id ?? "", app, mayWrite);
  const asset = record.app;
  const draft = asset && appDraftShown(asset) ? appDraftRevision(asset) : undefined;
  const asks = workspace !== undefined && host?.rights.publish === true && draft !== undefined;
  const refused = !mayWrite || record.missing || record.failed || (asset !== undefined && !asks);
  useEffect(() => {
    if (refused) onClose();
  }, [refused, onClose]);
  if (!asks || workspace === undefined || asset === undefined || draft === undefined) {
    return undefined;
  }
  return {
    name: appTitle(asset, app),
    workspace,
    ask: {
      revision: draft,
      summary: appManifestSummary(asset.config),
      readsStoredData: appReadsStoredData(asset.config)
    }
  };
}
