import type { ReactNode } from "react";
import type { ApprovalRequestView } from "@work-shape/catalyst-api-client";
import { Badge, Banner, FoldedText, KeyValue, KeyValueList } from "@work-shape/catalyst-ui";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import { useAppPublishData } from "../../studio/apps/app-data";
import { AppPublishData } from "../../studio/apps/app-publish-data";
import {
  narrativeHolds,
  PublishDetails,
  PublishNarrativeReadLead
} from "../../shared/publish-narrative";
import {
  parseOperationCallPreview,
  type AgentPublishReview,
  type PublishChange,
  type PublishReview,
  type PublishStale
} from "./operation-call-preview";

const STALE: Record<PublishStale, TranslationKey> = {
  gone: "operations.publishStaleGone",
  draft_moved: "operations.publishStaleDraft",
  live_moved: "operations.publishStaleLive"
};

const CHANGE: Record<PublishChange["change"], TranslationKey> = {
  new: "operations.publishChangeNew",
  changed: "operations.publishChangeChanged",
  added: "operations.publishChangeAdded",
  removed: "operations.publishChangeRemoved"
};

/** How the item names the kind it publishes. Another kind is "the asset". */
const KIND_PHRASE: Record<string, TranslationKey> = {
  app: "operations.publishKindApp",
  workflow: "operations.publishKindWorkflow",
  agent: "operations.publishKindAgent"
};

/** The words of an agent's field, as the review of its publish names the fields that differ. */
const AGENT_FIELD: Record<string, TranslationKey> = {
  displayName: "operations.agentField.displayName",
  description: "operations.agentField.description",
  instructions: "operations.agentField.instructions",
  modelBindingId: "operations.agentField.modelBindingId",
  userSelectableModelBindingIds: "operations.agentField.userSelectableModelBindingIds",
  reasoningEffort: "operations.agentField.reasoningEffort",
  fastMode: "operations.agentField.fastMode",
  maxSteps: "operations.agentField.maxSteps",
  toolNames: "operations.agentField.toolNames",
  skillNames: "operations.agentField.skillNames",
  knowledgeBases: "operations.agentField.knowledgeBases",
  subagentNames: "operations.agentField.subagentNames",
  welcomeMessage: "operations.agentField.welcomeMessage",
  welcomeSubtitle: "operations.agentField.welcomeSubtitle",
  initialPrompts: "operations.agentField.initialPrompts"
};

/** The words for the kind a publish makes live, as a sentence names it. */
export function publishKindPhrase(kind: string): TranslationKey {
  return KIND_PHRASE[kind] ?? "operations.publishKindOther";
}

/**
 * Whether the review of a held publish names who sees which stored data (DS-13b): an App that
 * lists a Data Store, while it still stands.
 */
function reviewReadsStoredData(review: PublishReview): boolean {
  return review.kind === "app" && review.dataStores.length > 0 && review.stale !== "gone";
}

/**
 * Holds Approve of a held publish until the lines on who sees which stored data are there, as
 * Publish waits for them in the App's Publish dialog: not while they load, and not after their
 * read failed. The read is the one the item's body shows, so it is asked once.
 */
export function PublishApproveHold({
  item,
  children
}: {
  item: ApprovalRequestView;
  children: (held: boolean) => ReactNode;
}) {
  const review = parseOperationCallPreview(item.preview)?.review;
  // A narrative this client cannot read whole holds Approve: its warnings come before the click.
  if (review?.narrative && narrativeHolds(review.narrative)) return children(true);
  return review && reviewReadsStoredData(review) ? (
    <StoredDataHold app={review.name} revision={review.revision}>
      {children}
    </StoredDataHold>
  ) : (
    children(false)
  );
}

function StoredDataHold({
  app,
  revision,
  children
}: {
  app: string;
  revision: number;
  children: (held: boolean) => ReactNode;
}) {
  return children(useAppPublishData(app, revision).status !== "ready");
}

/**
 * A publish that waits for an approver (GR-PUB-1): who wants to make which version live, what
 * approving does, and the review against the live version: the files that differ, the changing
 * actions or steps that are new or changed, the outside hosts it adds, the Connections, Data
 * Stores and account it uses, and for an App who sees which stored data (DS-13b). A request
 * whose draft or live version moved says it cannot be approved.
 */
export function PublishReviewBody({
  actor,
  review,
  headline = true,
  technical
}: {
  actor: string;
  review: PublishReview;
  /** Without it the review starts with its lists: a confirmation says who asks in its own words. */
  headline?: boolean;
  /**
   * The call itself (operation, origin, expiry, whole input), last in "Details" beside the
   * lists, so a publish that leads with its sentence has one fold. Shown only with a sentence.
   */
  technical?: ReactNode;
}) {
  const { t } = useTranslation();
  const effect = (
    <p className="text-caption text-muted-foreground" data-testid="publish-review-effect">
      {t("operations.publishEffect")}
    </p>
  );
  const lists = <PublishReviewLists review={review} />;
  return (
    <section className="grid min-w-0 gap-4" data-testid="publish-review">
      {headline ? (
        <div className="grid min-w-0 gap-1.5">
          <p className="font-medium text-foreground" data-testid="operation-call-headline">
            {t("operations.publishHeadline", {
              actor,
              kind: t(publishKindPhrase(review.kind)),
              title: review.title
            })}
          </p>
          {review.narrative ? null : effect}
        </div>
      ) : null}
      {review.stale ? (
        <Banner tone="warning" role="note" data-testid="publish-review-stale">
          {t(STALE[review.stale])}
        </Banner>
      ) : null}
      {/* "For whom?" as the requester answered it, before the sentence that names them. */}
      {review.audience ? (
        <KeyValueList layout="stacked">
          <KeyValue label={t("operations.publishAudience")} data-field="audience">
            <span data-testid="publish-review-audience">{review.audience.label}</span>
          </KeyValue>
        </KeyValueList>
      ) : null}
      {review.widens === undefined ? null : (
        <p
          className="text-body text-muted-foreground"
          data-testid="publish-review-widens"
          data-widens={review.widens ? "true" : "false"}
        >
          {t(review.widens ? "operations.publishWidens" : "operations.publishNarrows")}
        </p>
      )}
      {/* The same sentence the Publish dialog leads with, then the lists behind "Details". */}
      {review.narrative ? <PublishNarrativeReadLead read={review.narrative} /> : null}
      {review.publishedWith ? <PublishedWith reviews={review.publishedWith} /> : null}
      {review.narrative ? (
        // What approving does in general is a detail of the sentence on this publish.
        <PublishDetails>
          {headline ? effect : null}
          {lists}
          {technical ? (
            <section className="grid min-w-0 gap-2" data-testid="publish-details-technical">
              <h4 className="text-label">{t("operations.callDetails")}</h4>
              {technical}
            </section>
          ) : null}
        </PublishDetails>
      ) : (
        lists
      )}
    </section>
  );
}

/**
 * The Workflows an App's publish makes live with it (DP-3), children first: each with the
 * version it makes live and its own sentence. Approving approves them all.
 */
function PublishedWith({ reviews }: { reviews: readonly PublishReview[] }) {
  const { t } = useTranslation();
  return (
    <KeyValueList layout="stacked">
      <KeyValue label={t("operations.publishTogether")} data-field="published-with">
        <ul className="grid gap-3" data-testid="publish-review-published-with">
          {reviews.map((review) => (
            <li key={review.name} className="grid min-w-0 gap-1" data-asset={review.name}>
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="wrap-anywhere">
                  {t("operations.publishTogetherWorkflow", { title: review.title })}
                </span>
                <Badge tone={review.liveRevision === undefined ? "accent" : "neutral"}>
                  {review.liveRevision === undefined
                    ? t("operations.publishFirst", { number: review.revision })
                    : t("operations.publishReplaces", {
                        number: review.revision,
                        live: review.liveRevision
                      })}
                </Badge>
              </span>
              {review.narrative ? <PublishNarrativeReadLead read={review.narrative} /> : null}
            </li>
          ))}
        </ul>
      </KeyValue>
    </KeyValueList>
  );
}

/** The lists of the review, as they stood before its sentence. */
function PublishReviewLists({ review }: { review: PublishReview }) {
  const { t } = useTranslation();
  if (review.agent) return <AgentPublishLists review={review} agent={review.agent} />;
  const none = <span className="text-muted-foreground">{t("operations.publishNone")}</span>;
  const names = (list: readonly string[]) => (list.length === 0 ? none : list.join(", "));
  const changes = (list: readonly PublishChange[]) =>
    list.length === 0 ? (
      none
    ) : (
      <ul className="grid gap-1">
        {list.map((entry) => (
          <li key={entry.label} className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="wrap-anywhere">{entry.label}</span>
            <Badge tone="neutral">{t(CHANGE[entry.change])}</Badge>
          </li>
        ))}
      </ul>
    );
  return (
    <KeyValueList layout="stacked">
      <KeyValue label={t("operations.publishVersion")} data-field="version">
        {review.liveRevision === undefined
          ? t("operations.publishFirst", { number: review.revision })
          : t("operations.publishReplaces", {
              number: review.revision,
              live: review.liveRevision
            })}
      </KeyValue>
      <KeyValue label={t("operations.publishFiles")} data-field="files">
        {changes(review.files)}
      </KeyValue>
      {review.changing ? (
        <KeyValue label={t("operations.publishChanging")} data-field="changing">
          {changes(review.changing)}
        </KeyValue>
      ) : null}
      {review.kind === "app" ? (
        <KeyValue label={t("operations.publishHosts")} data-field="hosts">
          {names(review.hostsAdded)}
        </KeyValue>
      ) : null}
      <KeyValue label={t("operations.publishConnections")} data-field="connections">
        {names(review.connections)}
      </KeyValue>
      {review.kind === "app" ? (
        <KeyValue label={t("operations.publishDataStores")} data-field="data-stores">
          {names(
            review.dataStores.map((store) =>
              store.minSchema === undefined
                ? store.name
                : t("operations.publishDataStoreLevel", {
                    name: store.name,
                    level: store.minSchema
                  })
            )
          )}
        </KeyValue>
      ) : null}
      {/* Who sees which stored data, read for the version this request would make live. */}
      {reviewReadsStoredData(review) ? (
        <AppPublishData
          app={review.name}
          revision={review.revision}
          audienceLabel={review.audience?.label}
        />
      ) : null}
      {review.runAs ? (
        <KeyValue label={t("operations.publishRunsAs")} data-field="runs-as">
          {review.runAs}
        </KeyValue>
      ) : null}
    </KeyValueList>
  );
}

/**
 * The review of an agent's held publish (WS-PUB-1b): the draft revision and the live one it
 * replaces, the workspace that owns it and whether this publish offers it there, the fields
 * that differ, the tools and models it adds, the skills it names, and the draft's instructions
 * beside the live ones where they changed.
 */
function AgentPublishLists({
  review,
  agent
}: {
  review: PublishReview;
  agent: AgentPublishReview;
}) {
  const { t } = useTranslation();
  const none = <span className="text-muted-foreground">{t("operations.publishNone")}</span>;
  const names = (list: readonly string[] | undefined) =>
    list === undefined || list.length === 0 ? none : list.join(", ");
  const workspace = agent.workspace?.name ?? agent.workspace?.id;
  return (
    <KeyValueList layout="stacked">
      <KeyValue label={t("operations.publishVersion")} data-field="version">
        {review.liveRevision === undefined
          ? t("operations.publishFirst", { number: review.revision })
          : t("operations.publishDraftReplaces", {
              number: review.revision,
              live: review.liveRevision
            })}
      </KeyValue>
      {workspace ? (
        <KeyValue label={t("operations.publishAgentWorkspace")} data-field="workspace">
          <span className="grid min-w-0 gap-1">
            <span className="wrap-anywhere" data-testid="publish-review-workspace">
              {workspace}
            </span>
            <span
              className="text-caption text-muted-foreground"
              data-testid="publish-review-offers"
              data-offers={agent.offers ? "true" : "false"}
            >
              {agent.offers
                ? t("operations.publishAgentOffers", { workspace })
                : t("operations.publishAgentOffered")}
            </span>
          </span>
        </KeyValue>
      ) : null}
      {agent.fields ? (
        <KeyValue label={t("operations.publishAgentFields")} data-field="agent-fields">
          {agent.fields.length === 0 ? (
            none
          ) : (
            <ul className="grid gap-1">
              {agent.fields.map((entry) => {
                const label = AGENT_FIELD[entry.field];
                return (
                  <li
                    key={entry.field}
                    className="flex min-w-0 flex-wrap items-center gap-2"
                    data-agent-field={entry.field}
                  >
                    <span className="wrap-anywhere">{label ? t(label) : entry.field}</span>
                    <Badge tone="neutral">{t(CHANGE[entry.change])}</Badge>
                  </li>
                );
              })}
            </ul>
          )}
        </KeyValue>
      ) : null}
      {agent.fields ? (
        <>
          <KeyValue label={t("operations.publishAgentToolsAdded")} data-field="tools-added">
            {names(agent.toolsAdded)}
          </KeyValue>
          {agent.toolsRemoved && agent.toolsRemoved.length > 0 ? (
            <KeyValue label={t("operations.publishAgentToolsRemoved")} data-field="tools-removed">
              {names(agent.toolsRemoved)}
            </KeyValue>
          ) : null}
          <KeyValue label={t("operations.publishAgentModels")} data-field="models-added">
            {names(agent.modelBindingsAdded)}
          </KeyValue>
          <KeyValue label={t("operations.publishAgentSkills")} data-field="skills">
            {names(agent.skills)}
          </KeyValue>
        </>
      ) : null}
      {agent.instructions ? (
        <KeyValue label={t("operations.publishAgentInstructions")} data-field="instructions">
          <FoldedText data-testid="publish-review-instructions">
            {agent.instructions.after}
          </FoldedText>
        </KeyValue>
      ) : null}
      {agent.instructions?.before ? (
        <KeyValue
          label={t("operations.publishAgentInstructionsLive")}
          data-field="instructions-live"
        >
          <FoldedText className="text-muted-foreground">{agent.instructions.before}</FoldedText>
        </KeyValue>
      ) : null}
    </KeyValueList>
  );
}
