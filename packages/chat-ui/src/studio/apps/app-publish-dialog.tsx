import { useState } from "react";
import { Banner, Button, Dialog, KeyValue, KeyValueList } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import {
  narrativeHolds,
  PublishDetails,
  PublishNarrativeReadLead,
  type PublishNarrativeRead
} from "../../shared/publish-narrative";
import {
  useAppPublishData,
  useAppPublishNarrative,
  useAppPublishTogether,
  type AppAudience,
  type AppAudienceOffer,
  type AppPublishDataRead,
  type AppPublishHandover,
  type AppPublishTogetherRead
} from "./app-data";
import { NameList } from "./app-header";
import { appManifestSummary, appReadsStoredData, type AppManifestSummary } from "./app-model";
import { AppPublishDataView } from "./app-publish-data";
import { AppPublishHandoverView } from "./app-publish-handover";
import {
  AppPublishTogetherView,
  appPublishTogetherNamed,
  appPublishTogetherReady
} from "./app-publish-together";
import {
  AppAudienceChange,
  AppAudienceQuestion,
  appPublishBody,
  appPublishMaySend,
  useAppPublishSend,
  useSharePublishQuestion
} from "./app-publish-question";
import { useAppsHost, type AppsWorkspace } from "./apps-host";
import type { RefusalAction, ToldRefusal } from "../../shared/i18n/refusals";
import { RefusalNotice } from "../refusal-notice";

/** The revision a publish names, with what its manifest reaches. */
export interface PublishAsk {
  revision: number;
  /** The live revision, where one is: publishing it again may change only its audience. */
  live?: number | undefined;
  summary: AppManifestSummary;
  /** Its manifest has a reading `sql` action: the question names who sees which stored data. */
  readsStoredData: boolean;
}

/** What the config of the revision a publish names asks the question to say. */
export function askToPublish(
  revision: number,
  live: number | undefined,
  config: unknown
): PublishAsk {
  return {
    revision,
    live,
    summary: appManifestSummary(config),
    readsStoredData: appReadsStoredData(config)
  };
}

/** A dialog asked without the instance's sentence, as in a sample. */
const NO_NARRATIVE: PublishNarrativeRead = { status: "none" };

type PublishDialogProps = {
  name: string;
  workspace: AppsWorkspace;
  ask: PublishAsk;
  loading: boolean;
  error: string | undefined;
  /** The way to the Data Store or the Workflow a refusal names, shown beside its sentence. */
  errorAction?: RefusalAction | undefined;
  onConfirm(): void;
  onClose(): void;
};

/** "For whom?" as the dialog holds it: the instance's offer and the choice shown. */
interface PublishAudienceAsk {
  /** Absent while the first answer loads, and where the instance offers no choice. */
  offer: AppAudienceOffer | undefined;
  selected: AppAudience | undefined;
  onChange(audience: AppAudience): void;
}

/**
 * The Publish dialog for the revision it asks about, which sends the publish itself with the
 * audience chosen in "For whom?" (SHARE-1). The sentence and the lines on who sees which stored
 * data are read for that revision's number and that audience, whether it is the draft, the
 * first publish or an older revision from the revisions drawer. A publish held for approval
 * says so in the dialog, and Close leaves it.
 */
export function AskedPublishDialog({
  app,
  onPublished,
  onRefusal,
  ...props
}: PublishDialogProps & {
  app: string;
  /** The draft went live, not held for an approval: the card it was asked from says so. */
  onPublished?(): void;
  /** Hears each refusal of a send, and nothing for a send that was not refused. */
  onRefusal?: (refusal: ToldRefusal | undefined) => void;
}) {
  const [chosen, setChosen] = useState<AppAudience>();
  const question = useAppPublishNarrative(props.workspace.id, app, props.ask.revision, chosen);
  const publishing = useAppPublishSend(props.workspace.id, app, onRefusal);
  // The pending Workflows the draft reaches go live with it, on this one Publish (DP-3).
  const together = useAppPublishTogether(app, props.ask.revision);
  // What is sent is what is shown: the choice, or the audience the instance proposed.
  const selected = chosen ?? question.audience?.selected;
  const shared = {
    ...props,
    loading: publishing.busy,
    error: publishing.error,
    errorAction: publishing.errorAction,
    waits: publishing.waits,
    narrative: question.narrative,
    handover: question.handover,
    together,
    audience: {
      offer: question.audience,
      selected,
      onChange: setChosen
    },
    onConfirm: () => {
      publishing
        .send(
          props.ask.revision,
          question.audience === undefined ? undefined : selected,
          appPublishTogetherNamed(together),
          question.handover?.confirmation
        )
        .then((outcome) => afterPublishSend(outcome, { ...props, onPublished }))
        .catch(() => undefined);
    }
  };
  return props.ask.readsStoredData ? (
    <PublishDialogWithData app={app} {...shared} />
  ) : (
    <PublishDialog {...shared} />
  );
}

/**
 * What follows a sent publish: one that went live closes the dialog and tells whoever asked
 * for it. A held publish stays in the dialog, which says it waits; Close leaves it. A refused
 * one stays with its refusal.
 */
export function afterPublishSend(
  outcome: "published" | "waits" | "failed",
  then: { onClose(): void; onPublished?: (() => void) | undefined }
): void {
  if (outcome !== "published") return;
  then.onPublished?.();
  then.onClose();
}

function PublishDialogWithData({
  app,
  ...props
}: Parameters<typeof PublishDialog>[0] & { app: string }) {
  return <PublishDialog {...props} storedData={useAppPublishData(app, props.ask.revision)} />;
}

/**
 * Publish of an App's draft from outside its page, as "Publish" on the App's card in the
 * conversation: the same dialog, once the draft is read, for a reader who may publish. It also
 * asks where the draft is what is live, so only who it is for can change.
 */
export function SharePublishDialog({
  app,
  onClose,
  onPublished
}: {
  app: string;
  onClose(): void;
  /** The draft went live from this dialog. */
  onPublished?(): void;
}) {
  const share = useSharePublishQuestion(app, onClose);
  return share ? (
    <AskedPublishDialog
      app={app}
      {...share}
      loading={false}
      error={undefined}
      onConfirm={() => undefined}
      onClose={onClose}
      {...(onPublished ? { onPublished } : {})}
    />
  ) : null;
}

/**
 * Asks once before a revision becomes what its audience is served. It opens with "For whom?"
 * (SHARE-1) where the instance offers the choice, then says what that revision reaches for the
 * audience chosen: the instance's sentence, the Connections it uses, the hosts outside the
 * instance it calls and, where it reads stored data, who sees which (DS-13b). Publish waits
 * until those lines are there for the choice shown: the question is not asked without them.
 */
export function PublishDialog({
  name,
  workspace,
  ask,
  loading,
  error,
  errorAction,
  storedData,
  narrative = NO_NARRATIVE,
  audience,
  together,
  handover,
  waits = false,
  onConfirm,
  onClose
}: PublishDialogProps & {
  /** The lines on stored data, read for `ask.revision`. Absent where it reads none. */
  storedData?: AppPublishDataRead;
  /** The instance's sentence on the publish, read for `ask.revision` and the audience shown. */
  narrative?: PublishNarrativeRead;
  /** "For whom?". Absent, as in a sample, the dialog asks as before SHARE-1. */
  audience?: PublishAudienceAsk;
  /** The publish was sent and waits for an approver. */
  waits?: boolean;
  /** The Workflows the Publish makes live with the App. Absent, as in a sample, it names none. */
  together?: AppPublishTogetherRead;
  /** The widening check for the audience shown (DS-13c). Absent: nothing to say. */
  handover?: AppPublishHandover | undefined;
}) {
  const { t } = useTranslation();
  const host = useAppsHost();
  const offer = audience?.offer;
  const selected = audience?.selected;
  // The offer names the people of the audience it was read for; for another choice it waits.
  const audienceLabel = offer && offer.selected === selected ? offer.label : undefined;
  const waitsForData =
    (storedData !== undefined && storedData.status !== "ready") ||
    narrativeHolds(narrative) ||
    (offer !== undefined && audienceLabel === undefined) ||
    (together !== undefined && !appPublishTogetherReady(together));
  // The live revision for its own audience again changes nothing: Publish waits for a change.
  const changes = appPublishMaySend(ask, offer, selected);
  const body = appPublishBody(offer ? selected : undefined, workspace.name, t);
  const lists = (
    <KeyValueList>
      <KeyValue label={t("apps.publishConnections")}>
        <NameList names={ask.summary.connections} />
      </KeyValue>
      <KeyValue label={t("apps.publishHosts")}>
        <NameList names={ask.summary.hosts} />
      </KeyValue>
      {storedData ? (
        <AppPublishDataView
          read={storedData}
          audienceLabel={audienceLabel}
          audiencePeople={selected === "self" ? undefined : offer?.people}
          audiencePending={offer !== undefined && audienceLabel === undefined}
        />
      ) : null}
    </KeyValueList>
  );
  return (
    <Dialog
      open
      size="sm"
      title={t("apps.publishTitle", { name })}
      {...(narrative.status === "none" && offer === undefined ? { description: body } : {})}
      onClose={onClose}
      footer={
        waits ? (
          <Button variant="outline" onClick={onClose}>
            {t("close")}
          </Button>
        ) : (
          <>
            <Button variant="outline" disabled={loading} onClick={onClose}>
              {t("cancel")}
            </Button>
            <Button loading={loading} disabled={waitsForData || !changes} onClick={onConfirm}>
              {t("apps.publish")}
            </Button>
          </>
        )
      }
    >
      <div className="grid gap-4">
        {offer && selected !== undefined ? (
          <AppAudienceQuestion
            offer={offer}
            selected={selected}
            workspaceName={workspace.name}
            disabled={loading || waits}
            onChange={(next) => audience?.onChange(next)}
          />
        ) : null}
        <AppAudienceChange offer={offer} selected={selected} workspaceName={workspace.name} />
        <div className="grid gap-3">
          <PublishNarrativeReadLead read={narrative} />
          <AppPublishHandoverView handover={handover} />
          {together ? <AppPublishTogetherView read={together} /> : null}
          {narrative.status === "none" && offer === undefined ? (
            lists
          ) : (
            // The sentence leads; which revision goes live for whom is a detail of it.
            <PublishDetails>
              <p className="text-body text-muted-foreground" data-testid="app-publish-body">
                {body}
              </p>
              {lists}
            </PublishDetails>
          )}
          {waits ? <Banner data-testid="app-publish-waits">{t("apps.publishWaits")}</Banner> : null}
          {error ? (
            <RefusalNotice
              message={error}
              action={errorAction}
              // The way leaves the dialog: it closes, and the page it names opens.
              onOpen={
                host
                  ? (route) => {
                      onClose();
                      host.showRoute(route);
                    }
                  : undefined
              }
            />
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}
