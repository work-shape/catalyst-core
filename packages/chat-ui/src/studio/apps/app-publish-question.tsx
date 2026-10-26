import { useEffect, useState } from "react";
import { RadioGroup } from "@work-shape/catalyst-ui";
import { instanceSentence, PendingApprovalError } from "../build-area/build-refusals";
import { useTranslation, type TranslationContextValue } from "../../shared/i18n";
import type { RefusalAction, ToldRefusal } from "../../shared/i18n/refusals";
import {
  useApp,
  useAppWrites,
  type AppAudience,
  type AppAudienceOffer,
  type AppPublishNamed
} from "./app-data";
import {
  appDraftRevision,
  appDraftShown,
  appManifestSummary,
  appReadsStoredData,
  appPublishRefusal,
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

/**
 * Whether the dialog may send the publish: the revision differs from what is live, or only the
 * audience changes (SHARE-1). Publishing the live revision for its own audience changes nothing.
 */
export function appPublishMaySend(
  ask: { revision: number; live?: number | undefined },
  offer: AppAudienceOffer | undefined,
  selected: AppAudience | undefined
): boolean {
  if (ask.live === undefined || ask.revision !== ask.live) return true;
  return appAudienceDiffers(offer, selected);
}

/**
 * Whether the choice shown makes the App live for other people than now: another audience, or
 * "Only me" where the live revision is only another person's.
 */
function appAudienceDiffers(
  offer: AppAudienceOffer | undefined,
  selected: AppAudience | undefined
): boolean {
  const live = offer?.live;
  if (!offer || !live || selected === undefined) return false;
  if (live.audience !== selected) return true;
  return offer.selected === selected && live.label !== undefined && live.label !== offer.label;
}

/**
 * Who the live revision is for, in the words of the dialog. A workspace audience is named by
 * the workspace's name as the interface shows it: the instance's label carries the name stored
 * on the workspace's row, which for a Personal Workspace is "Personal workspace" in every
 * language (ACCEPT-FIX-2 C5). Every other audience keeps the instance's label, which can name a
 * person the interface does not know.
 */
function appAudienceLiveLabel(
  live: NonNullable<AppAudienceOffer["live"]>,
  workspaceName: string,
  t: TranslationContextValue["t"]
): string | undefined {
  return live.audience === "workspace"
    ? t("apps.publishAudienceWorkspace", { workspace: workspaceName })
    : live.label;
}

/**
 * The line that says who the live revision is for and who it will be for, where the choice
 * shown changes it: "Shared now: Everyone in the instance. After publishing: Everyone in Sales."
 * It waits for the people of the choice shown, so it never names those of another choice.
 */
export function AppAudienceChange({
  offer,
  selected,
  workspaceName
}: {
  offer: AppAudienceOffer | undefined;
  selected: AppAudience | undefined;
  /** The name of the App's workspace as the interface shows it. */
  workspaceName: string;
}) {
  const { t } = useTranslation();
  const live = offer?.live;
  const liveLabel = live ? appAudienceLiveLabel(live, workspaceName, t) : undefined;
  if (!offer || !liveLabel || offer.selected !== selected || !appAudienceDiffers(offer, selected)) {
    return null;
  }
  return (
    <p className="text-body text-muted-foreground" data-testid="app-publish-audience-change">
      {t("apps.publishAudienceChange", { live: liveLabel, next: offer.label })}
    </p>
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
  /** The way to what the refusal names, where it names a Data Store or a Workflow. */
  errorAction: RefusalAction | undefined;
  /** The publish waits for an approver: the live revision stays until then. */
  waits: boolean;
  /** Sends the publish: made live, held for an approver, or refused. */
  send(
    revision: number,
    audience: AppAudience | undefined,
    /** The Data Stores and Workflows the one Publish makes live with the App (DP-3, GOLIVE-1). */
    together?: AppPublishNamed
  ): Promise<"published" | "waits" | "failed">;
}

/**
 * The publish the dialog sends itself, with the audience it asked for. `onRefusal` hears each
 * refusal, and nothing when a later send was not refused, so the page can keep it in its head.
 */
export function useAppPublishSend(
  workspaceId: string,
  app: string,
  onRefusal?: (refusal: ToldRefusal | undefined) => void
): AppPublishSend {
  const { t } = useTranslation();
  const host = useAppsHost();
  const writes = useAppWrites(workspaceId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ToldRefusal>();
  const [waits, setWaits] = useState(false);
  return {
    busy,
    error: error?.message,
    errorAction: error?.action,
    waits,
    send: async (revision, audience, together) => {
      setBusy(true);
      setError(undefined);
      onRefusal?.(undefined);
      try {
        await writes.publish(app, revision, audience, together);
        return "published";
      } catch (caught) {
        if (caught instanceof PendingApprovalError) {
          setWaits(true);
          return "waits";
        }
        const refusal = appPublishRefusal(caught, t, {
          workspaceId,
          ...(host?.canOpen ? { canOpen: host.canOpen } : {})
        }) ?? { message: instanceSentence(caught, t) ?? t("apps.publishFailed") };
        setError(refusal);
        onRefusal?.(refusal);
        return "failed";
      } finally {
        setBusy(false);
      }
    }
  };
}

/** What "Publish" on the App's card asks the dialog about: the draft, in the open workspace. */
export interface SharePublishQuestion {
  name: string;
  workspace: AppsWorkspace;
  ask: {
    revision: number;
    live: number | undefined;
    summary: AppManifestSummary;
    readsStoredData: boolean;
  };
}

/**
 * Reads the draft the App's card asks about, for a reader who may write and publish Apps. A draft
 * that is what is live is asked about too: the publish may change only who the App is for. Where the
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
      live: asset.publishedRevision,
      summary: appManifestSummary(asset.config),
      readsStoredData: appReadsStoredData(asset.config)
    }
  };
}
