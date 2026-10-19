import { useState } from "react";
import {
  Banner,
  Button,
  Dialog,
  InlineError,
  KeyValue,
  KeyValueList
} from "@work-shape/catalyst-ui";
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
  type AppAudience,
  type AppAudienceOffer,
  type AppPublishDataRead
} from "./app-data";
import { NameList } from "./app-header";
import { appManifestSummary, appReadsStoredData, type AppManifestSummary } from "./app-model";
import { AppPublishDataView } from "./app-publish-data";
import {
  AppAudienceChange,
  AppAudienceQuestion,
  appPublishBody,
  appPublishMaySend,
  useAppPublishSend,
  useSharePublishQuestion
} from "./app-publish-question";
import type { AppsWorkspace } from "./apps-host";

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
export function AskedPublishDialog({ app, ...props }: PublishDialogProps & { app: string }) {
  const [chosen, setChosen] = useState<AppAudience>();
  const question = useAppPublishNarrative(props.workspace.id, app, props.ask.revision, chosen);
  const publishing = useAppPublishSend(props.workspace.id, app);
  // What is sent is what is shown: the choice, or the audience the instance proposed.
  const selected = chosen ?? question.audience?.selected;
  const shared = {
    ...props,
    loading: publishing.busy,
    error: publishing.error,
    waits: publishing.waits,
    narrative: question.narrative,
    audience: {
      offer: question.audience,
      selected,
      onChange: setChosen
    },
    onConfirm: () => {
      publishing
        .send(props.ask.revision, question.audience === undefined ? undefined : selected)
        .then((outcome) => {
          // A held publish stays in the dialog, which says it waits; Close leaves it.
          if (outcome === "published") props.onClose();
        })
        .catch(() => undefined);
    }
  };
  return props.ask.readsStoredData ? (
    <PublishDialogWithData app={app} {...shared} />
  ) : (
    <PublishDialog {...shared} />
  );
}

function PublishDialogWithData({
  app,
  ...props
}: Parameters<typeof PublishDialog>[0] & { app: string }) {
  return <PublishDialog {...props} storedData={useAppPublishData(app, props.ask.revision)} />;
}

/**
 * Publish of an App's draft from outside its page, as "Share" on the line a save leaves in the
 * conversation: the same dialog, once the draft is read, for a reader who may publish. It also
 * asks where the draft is what is live, so only who it is for can change.
 */
export function SharePublishDialog({ app, onClose }: { app: string; onClose(): void }) {
  const share = useSharePublishQuestion(app, onClose);
  return share ? (
    <AskedPublishDialog
      app={app}
      {...share}
      loading={false}
      error={undefined}
      onConfirm={() => undefined}
      onClose={onClose}
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
  storedData,
  narrative = NO_NARRATIVE,
  audience,
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
}) {
  const { t } = useTranslation();
  const offer = audience?.offer;
  const selected = audience?.selected;
  // The offer names the people of the audience it was read for; for another choice it waits.
  const audienceLabel = offer && offer.selected === selected ? offer.label : undefined;
  const waitsForData =
    (storedData !== undefined && storedData.status !== "ready") ||
    narrativeHolds(narrative) ||
    (offer !== undefined && audienceLabel === undefined);
  // The live revision for its own audience again changes nothing: Publish waits for a change.
  const changes = appPublishMaySend(ask, offer, selected);
  const body = appPublishBody(offer ? selected : undefined, ask.revision, workspace.name, t);
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
          {error ? <InlineError>{error}</InlineError> : null}
        </div>
      </div>
    </Dialog>
  );
}
