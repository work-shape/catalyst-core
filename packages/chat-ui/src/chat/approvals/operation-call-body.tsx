import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ApprovalRequestView } from "@work-shape/catalyst-api-client";
import {
  Banner,
  CodeBlock,
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  EmptyState,
  KeyValue,
  KeyValueList
} from "@work-shape/catalyst-ui";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import { operationOriginLabelKeys } from "../../shared/operations-model";
import { formatApprovalDate } from "./approval-request-model";
import { ConfirmationLead } from "./confirmation-lead";
import { useOptionalWorkspaceApiClient } from "../../shared/api/workspace-api-client";
import { workspaceQueryKeys } from "../../shared/api/workspace-query-keys";
import {
  currentRow,
  dataStoreRowChange,
  keyedRowsQuery,
  rowChangeInputs,
  rowChangeSummary,
  type CurrentRows,
  type DataStoreRowChange
} from "./data-store-row-change";
import { useApprovalRevisionHost } from "./approval-revision-host";
import {
  SKILL_ASSET_KIND,
  isInboxConfirmation,
  operationCallFrozenInput,
  operationCallFullInput,
  operationCallOutcome,
  parseOperationCallPreview,
  type OperationCallAsset,
  type OperationCallOutcome,
  type OperationCallPreview
} from "./operation-call-preview";
import { PublishReviewBody } from "./publish-review";
import { SkillChangeBody, type SkillChangeLabels } from "./skill-change-body";
import { parseSkillChangePreview } from "./skill-change-preview";
import { personName } from "../../shared/person-name";

type OutcomeTone = "info" | "success" | "danger" | "warning";

const OUTCOME: Record<OperationCallOutcome, { label: TranslationKey; tone: OutcomeTone }> = {
  queued: { label: "operations.callOutcomeQueued", tone: "info" },
  done: { label: "operations.callOutcomeDone", tone: "success" },
  failed: { label: "operations.callOutcomeFailed", tone: "danger" },
  interrupted: { label: "operations.callOutcomeInterrupted", tone: "danger" },
  refused: { label: "operations.callOutcomeRefused", tone: "warning" },
  expired: { label: "operations.callOutcomeExpired", tone: "warning" },
  held: { label: "operations.callOutcomeHeld", tone: "info" }
};

/** What became of a call its person allowed in their Inbox, in the words of Allow. */
const CONFIRMATION_OUTCOME: Record<
  OperationCallOutcome,
  { label: TranslationKey; tone: OutcomeTone }
> = {
  ...OUTCOME,
  queued: { label: "operations.confirmOutcomeQueued", tone: "info" },
  done: { label: "operations.confirmOutcomeDone", tone: "success" },
  failed: { label: "operations.confirmOutcomeFailed", tone: "danger" },
  interrupted: { label: "operations.confirmOutcomeInterrupted", tone: "danger" },
  expired: { label: "operations.confirmOutcomeExpired", tone: "warning" }
};

interface ShownOutcome {
  outcome: string;
  label: TranslationKey;
  /** The values the label names, such as the title of an asset. */
  values?: Record<string, string>;
  tone: OutcomeTone;
  reason?: string;
}

/** The code a refusal carries when the asset changed after the request: nothing was applied. */
const APPROVAL_STALE = "APPROVAL_STALE";

/**
 * What the item says became of a call once its request ended. A confirmation also says that it
 * was denied, and that Stop withdrew it before anyone decided; the reason a person gave for a
 * denial stands under the decision.
 */
function shownOutcome(
  request: Pick<ApprovalRequestView, "status" | "applyResult">,
  confirmation: boolean,
  asset: OperationCallAsset | undefined,
  /** Who asked, unless the reader did: the sentence then says what they can do. */
  otherActor: string | undefined
): ShownOutcome | undefined {
  if (confirmation && request.status === "rejected") {
    return { outcome: "denied", label: "operations.confirmOutcomeDenied", tone: "info" };
  }
  if (confirmation && request.status === "withdrawn") {
    return { outcome: "withdrawn", label: "operations.confirmOutcomeWithdrawn", tone: "info" };
  }
  const ended = operationCallOutcome(request);
  if (!ended) return undefined;
  // The instance's sentence is in its own language; this one is told in the reader's.
  if (ended.reasonCode === APPROVAL_STALE) {
    return asset
      ? {
          outcome: ended.outcome,
          ...(otherActor === undefined
            ? { label: "operations.callOutcomeStale", values: { title: asset.title } }
            : {
                label: "operations.callOutcomeStaleApprover",
                values: { title: asset.title, actor: otherActor }
              }),
          tone: "warning"
        }
      : { outcome: ended.outcome, ...OUTCOME.refused };
  }
  const words = (confirmation ? CONFIRMATION_OUTCOME : OUTCOME)[ended.outcome];
  return { outcome: ended.outcome, ...words, ...(ended.reason ? { reason: ended.reason } : {}) };
}

/** How a sentence names the kind of an asset. A kind without words of its own is "the asset". */
const ASSET_KIND_PHRASE: Record<string, TranslationKey> = {
  skill: "operations.callAssetKindSkill",
  agent: "operations.callAssetKindAgent",
  connection: "operations.callAssetKindConnection"
};

/** The sentence that says who wants what. */
function assetSentenceKey(asset: OperationCallAsset): TranslationKey {
  if (asset.isNew === undefined) return "operations.callAssetSave";
  return asset.isNew ? "operations.callAssetCreate" : "operations.callAssetChange";
}

/** What approving and declining do: said of the skill, of another asset, or of the call. */
function effectKey(asset: OperationCallAsset | undefined): TranslationKey {
  if (!asset) return "operations.callEffect";
  if (asset.kind !== SKILL_ASSET_KIND || asset.isNew === undefined) {
    return "operations.callAssetEffect";
  }
  return asset.isNew ? "operations.callSkillEffectNew" : "operations.callSkillEffectChange";
}

/**
 * An operation call that waits for another person's approval. While it waits, the item leads
 * with one sentence that says who wants what, what a decision does, and why one is needed. A
 * saved skill then shows as the skill: all of a new one, before and after of a changed one.
 * A row write of a Data Store asks what it changes in one question and lists its rows, a block
 * per key and per values. Every other call shows its operation and its input, a block per
 * field. What a block or the list leaves out is counted in words. The operation's name, where the call came from, when it
 * expires and the whole input as the request keeps it are in one fold at the end. Once the
 * request is decided, the item says what became of the call. A preview it cannot read shows a
 * sentence instead of half a call.
 */
export function OperationCallBody({
  request
}: {
  request: Pick<
    ApprovalRequestView,
    "preview" | "status" | "applyResult" | "payload" | "addresseeUserId"
  >;
}) {
  const { t } = useTranslation();
  const host = useApprovalRevisionHost();
  const call = parseOperationCallPreview(request.preview);
  if (!call) {
    return (
      <EmptyState layout="inline" data-testid="operation-call-unreadable">
        {t("operations.callUnreadable")}
      </EmptyState>
    );
  }

  const pending = request.status === "pending";
  // A person's own confirmation, which only they see: it leads with who asks for them.
  const confirmation = isInboxConfirmation(request);
  const { asset } = call;
  const actor = personName(call.actor.label, t);
  // The reader who asked is told what they can do; anyone else is told what the asker can.
  const ownRequest = host !== undefined && host.currentUserId === call.actor.id;
  const outcome = pending
    ? undefined
    : shownOutcome(request, confirmation, asset, ownRequest ? undefined : actor);
  // A reader who may not read the asset sees its title and why, never what the call writes.
  const withheld = asset?.beforeWithheld ? asset : undefined;
  // The skill's own view needs a text the server could read; without one the input shows.
  const skill =
    !withheld && asset?.kind === SKILL_ASSET_KIND && asset.content !== undefined
      ? asset
      : undefined;
  const hiddenFields = withheld ? 0 : call.inputFieldCount - call.inputs.length;
  // A row write is read from the input the request froze, which it keeps only while it waits.
  const rowChange = pending
    ? dataStoreRowChange(
        call.operation,
        operationCallFrozenInput(request.payload),
        call.targetTitle
      )
    : undefined;

  // A publish that waits shows what it makes live, and the call itself only in the fold.
  const review = pending ? call.review : undefined;
  const technical = (
    <TechnicalDetailsContent
      call={call}
      pending={pending}
      showsOperation={
        skill !== undefined ||
        review !== undefined ||
        withheld !== undefined ||
        rowChange !== undefined
      }
      fullInput={withheld ? undefined : operationCallFullInput(request.payload)}
    />
  );
  // A publish that leads with its sentence has one fold, "Details", and the call goes in it.
  const merged = review?.narrative !== undefined;

  return (
    <div className="grid min-w-0 gap-4" data-testid="operation-call" data-run-id={call.runId}>
      {confirmation && pending ? <ConfirmationLead call={call} /> : null}
      {review ? (
        <PublishReviewBody
          actor={actor}
          review={review}
          headline={!confirmation}
          technical={merged ? technical : undefined}
        />
      ) : confirmation ? null : pending ? (
        <div className="grid min-w-0 gap-1.5">
          <p className="font-medium text-foreground" data-testid="operation-call-headline">
            {asset
              ? t(assetSentenceKey(asset), {
                  actor,
                  kind: t(ASSET_KIND_PHRASE[asset.kind] ?? "operations.callAssetKindOther"),
                  title: asset.title
                })
              : t(
                  call.effect === "changing"
                    ? "operations.callHeadlineChanging"
                    : "operations.callHeadlineReading",
                  { actor }
                )}
          </p>
          {/* An outdated request's warning says what approving does in its stead. */}
          {asset?.isStale ? null : (
            <p className="text-caption text-muted-foreground">{t(effectKey(asset), { actor })}</p>
          )}
          {asset?.isStale ? (
            <Banner tone="warning" role="note" data-testid="operation-call-stale">
              {t(ownRequest ? "operations.callAssetStaleOwn" : "operations.callAssetStale", {
                title: asset.title,
                actor
              })}
            </Banner>
          ) : null}
          {/* A reason is given only where it names the rule that holds the request. */}
          {asset?.kind === SKILL_ASSET_KIND && call.heldByRule ? (
            <Banner layout="line" role="note" data-testid="operation-call-why">
              {t("operations.callWhySkillRule")}
            </Banner>
          ) : null}
          {call.heldByFloor ? (
            <Banner layout="line" role="note" data-testid="operation-call-why">
              {t("operations.callWhyPolicyFloor")}
            </Banner>
          ) : null}
        </div>
      ) : null}
      {pending && call.handover ? (
        // What approving hands on, as the caller was told: who decides it confirms it.
        <Banner tone="warning" role="note" data-testid="operation-call-handover">
          {call.handover.map((line) => (
            <span key={line} className="block">
              {line}
            </span>
          ))}
        </Banner>
      ) : null}
      {outcome ? (
        <Banner
          tone={outcome.tone}
          data-testid="operation-call-outcome"
          data-outcome={outcome.outcome}
        >
          {t(outcome.label, outcome.values)}
          {outcome.reason ? (
            <span className="block text-caption">
              {t("operations.callOutcomeReason", { reason: outcome.reason })}
            </span>
          ) : null}
        </Banner>
      ) : null}
      {review ? null : withheld ? (
        <WithheldAsset asset={withheld} />
      ) : skill ? (
        <SkillAsset asset={skill} actor={actor} />
      ) : rowChange ? (
        <RowChangeInputs change={rowChange} />
      ) : (
        <>
          <KeyValueList>
            <KeyValue label={t("operations.operation")} data-field="operation">
              <span className="font-mono text-code wrap-anywhere">{call.operation}</span>
            </KeyValue>
            {pending || confirmation ? null : (
              <KeyValue label={t("operations.callCalledBy")} data-field="actor">
                {actor}
              </KeyValue>
            )}
          </KeyValueList>
          <CallInputs call={call} hiddenFields={hiddenFields} />
        </>
      )}
      {merged ? null : (
        // A reader who is told to read the rest finds it open.
        <TechnicalDetails defaultOpen={hiddenFields > 0}>{technical}</TechnicalDetails>
      )}
    </div>
  );
}

/** An asset the reader may not read: its title and why nothing else of it is shown. */
function WithheldAsset({ asset }: { asset: OperationCallAsset }) {
  const { t } = useTranslation();
  return (
    <section className="grid min-w-0 gap-3" data-testid="operation-call-withheld">
      <KeyValueList>
        <KeyValue label={t("operations.callSkillTitle")} data-field="title">
          {asset.title}
        </KeyValue>
      </KeyValueList>
      <Banner layout="line" tone="warning" role="note" data-testid="operation-call-no-before">
        {t("operations.callAssetWithheld", {
          kind: t(ASSET_KIND_PHRASE[asset.kind] ?? "operations.callAssetKindOther")
        })}
      </Banner>
    </section>
  );
}

/** A saved skill as people read one: what else changes about it, then its text. */
function SkillAsset({ asset, actor }: { asset: OperationCallAsset; actor: string }) {
  const { t } = useTranslation();
  const { previous, removedResources } = asset;
  const hasText = parseSkillChangePreview(asset.content) !== undefined;
  // An outdated request is compared with the version its requester saw, not with what is saved
  // now: the labels say so, so the comparison does not read as a revert of the newer text.
  const labels = asset.isStale
    ? {
        before: t("operations.callSkillStaleSeen", { actor }),
        after: t("operations.callSkillStaleProposed", { actor })
      }
    : { before: t("skillChangeBefore"), after: t("skillChangeAfter") };
  return (
    <section className="grid min-w-0 gap-3" data-testid="operation-call-skill">
      {previous.title || previous.description || removedResources.length > 0 ? (
        <KeyValueList layout="stacked" data-testid="operation-call-skill-fields">
          {previous.title ? (
            <KeyValue label={t("operations.callSkillTitle")} data-field="title">
              <BeforeAndNow labels={labels} before={previous.title} now={asset.title} />
            </KeyValue>
          ) : null}
          {previous.description ? (
            <KeyValue label={t("operations.callSkillDescription")} data-field="description">
              <BeforeAndNow labels={labels} before={previous.description} now={asset.description} />
            </KeyValue>
          ) : null}
          {removedResources.length > 0 ? (
            <KeyValue label={t("operations.callSkillRemovedResources")}>
              {removedResources.join(", ")}
            </KeyValue>
          ) : null}
        </KeyValueList>
      ) : null}
      {hasText ? (
        <SkillChangeBody preview={asset.content} heading={false} expanded labels={labels} />
      ) : (
        <p className="text-muted-foreground" data-testid="operation-call-skill-same-text">
          {t("operations.callSkillSameText")}
        </p>
      )}
    </section>
  );
}

function BeforeAndNow({
  labels,
  before,
  now
}: {
  labels: SkillChangeLabels;
  before: string;
  now: string | undefined;
}) {
  return (
    <>
      <span className="block text-muted-foreground">
        {labels.before}: {before}
      </span>
      {now === undefined ? null : (
        <span className="block">
          {labels.after}: {now}
        </span>
      )}
    </>
  );
}

/** The input of a call, a block per field as the server rendered it. */
export function CallInputs({
  call,
  hiddenFields
}: {
  call: Pick<OperationCallPreview, "inputs" | "inputFieldCount" | "inputRemoved">;
  hiddenFields: number;
}) {
  const { t } = useTranslation();
  return (
    <section className="grid min-w-0 gap-2" data-testid="operation-call-inputs">
      <h4 className="text-label">{t("operations.callInputs")}</h4>
      {call.inputRemoved ? (
        <p className="text-muted-foreground" data-testid="operation-call-input-removed">
          {t("operations.callInputRemoved")}
        </p>
      ) : call.inputs.length === 0 ? (
        <p className="text-muted-foreground">{t("operations.callNoInputs")}</p>
      ) : (
        <div className="grid min-w-0 gap-3">
          {call.inputs.map((input) => (
            <div
              key={input.key}
              className="grid min-w-0 gap-1"
              data-input-key={input.key}
              data-truncated={input.truncated || undefined}
            >
              <span className="font-mono text-caption text-muted-foreground wrap-anywhere">
                {input.key}
              </span>
              <CodeBlock code={input.value} label={input.key} className="max-h-72" />
              {input.truncated ? (
                <span className="text-caption text-muted-foreground">
                  {input.length === undefined
                    ? t("operations.callTruncated")
                    : t("operations.callTruncatedOf", {
                        shown: input.value.length,
                        total: input.length
                      })}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      )}
      {hiddenFields > 0 ? (
        <p data-testid="operation-call-hidden-fields">
          {t("operations.callHiddenFields", {
            total: call.inputFieldCount,
            shown: call.inputs.length
          })}
        </p>
      ) : null}
    </section>
  );
}

/**
 * A Data Store write as one question, "Add 1 row to Holiday requests?", then its table and every
 * row of it, a block per key and per values. A row named by key also shows as it stands now, read
 * with the reader's own rights inside a workspace.
 */
export function RowChangeInputs({ change }: { change: DataStoreRowChange }) {
  const api = useOptionalWorkspaceApiClient();
  const query = keyedRowsQuery(change);
  return api && query ? (
    <ReadRowChange change={change} query={query} api={api} />
  ) : (
    <RowChangeView change={change} current={undefined} />
  );
}

function ReadRowChange({
  change,
  query,
  api
}: {
  change: DataStoreRowChange;
  query: NonNullable<ReturnType<typeof keyedRowsQuery>>;
  api: NonNullable<ReturnType<typeof useOptionalWorkspaceApiClient>>;
}) {
  const read = useQuery({
    // Under the Data Store reads, so a write of the store reads the rows again.
    queryKey: [
      ...workspaceQueryKeys.dataStores(api.apiBaseUrl),
      "keyed-rows",
      change.store,
      query.sql,
      query.parameters
    ],
    queryFn: ({ signal }) =>
      api.client.data_stores.query({ params: { store: change.store }, body: query, signal }),
    retry: false
  });
  // A capped answer may leave out a keyed row: no row is told gone on its word.
  const current: CurrentRows =
    read.isError || read.data?.truncated === true
      ? { status: "unavailable" }
      : read.data
        ? { status: "read", rows: read.data.rows }
        : undefined;
  return <RowChangeView change={change} current={current} />;
}

function RowChangeView({ change, current }: { change: DataStoreRowChange; current: CurrentRows }) {
  const { locale, t } = useTranslation();
  const inputs = rowChangeInputs(change, t, current);
  // The rows a read found no longer, by their number in the change.
  const gone =
    current?.status === "read"
      ? change.rows.flatMap(({ key }, index) =>
          key && !currentRow(key, current.rows) ? [index + 1] : []
        )
      : [];
  return (
    <div className="grid min-w-0 gap-3" data-testid="row-change-inputs" data-verb={change.verb}>
      <p className="text-foreground wrap-anywhere" data-testid="operation-call-summary">
        {rowChangeSummary(change, t, locale)}
      </p>
      <CallInputs
        call={{ inputs, inputFieldCount: inputs.length, inputRemoved: false }}
        hiddenFields={0}
      />
      {current?.status === "unavailable" ? (
        <p className="text-muted-foreground" data-testid="row-change-unavailable">
          {t("operations.rowsUnavailable")}
        </p>
      ) : null}
      {gone.map((n) => (
        <p key={n} className="text-muted-foreground" data-testid="row-change-gone">
          {t("operations.rowGone", { n })}
        </p>
      ))}
    </div>
  );
}

/** What few readers need to decide and some need to check, folded away under one line. */
function TechnicalDetails({
  defaultOpen,
  children
}: {
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Disclosure defaultOpen={defaultOpen} data-testid="operation-call-details">
      <DisclosureTrigger data-testid="operation-call-details-open">
        {t("operations.callDetails")}
      </DisclosureTrigger>
      <DisclosureContent>
        <div className="pt-1">{children}</div>
      </DisclosureContent>
    </Disclosure>
  );
}

/** The operation, where the call came from, when it expires and its whole input. */
function TechnicalDetailsContent({
  call,
  pending,
  showsOperation,
  fullInput
}: {
  call: OperationCallPreview;
  pending: boolean;
  showsOperation: boolean;
  fullInput: string | undefined;
}) {
  const { locale, t } = useTranslation();
  const host = useApprovalRevisionHost();
  const { agentName, toolName } = call.origin;
  const origin = [
    t(operationOriginLabelKeys[call.origin.kind]),
    agentName
      ? t("operations.throughAgent", { agent: host?.agentDisplayName(agentName) ?? agentName })
      : undefined
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <div className="grid min-w-0 gap-3" data-testid="operation-call-technical">
      <KeyValueList>
        {showsOperation ? (
          <KeyValue label={t("operations.operation")} data-field="operation">
            <span className="font-mono text-code wrap-anywhere">{call.operation}</span>
          </KeyValue>
        ) : null}
        <KeyValue label={t("operations.origin")} data-field="origin">
          {origin}
        </KeyValue>
        {toolName ? (
          <KeyValue label={t("operations.fieldToolName")} data-field="tool">
            <span className="font-mono text-code wrap-anywhere">{toolName}</span>
          </KeyValue>
        ) : null}
        {call.expiresAt && pending ? (
          <KeyValue label={t("operations.callExpires")} data-field="expiresAt">
            {formatApprovalDate(call.expiresAt, locale)}
            <span className="block text-caption text-muted-foreground">
              {t("operations.callExpiresHint")}
            </span>
          </KeyValue>
        ) : null}
      </KeyValueList>
      {fullInput === undefined ? null : (
        <div className="grid min-w-0 gap-1">
          <span className="text-caption text-muted-foreground">
            {t("operations.callFullInput")}
          </span>
          <CodeBlock
            code={fullInput}
            label={t("operations.callFullInput")}
            className="max-h-96"
            data-testid="operation-call-full-input"
          />
        </div>
      )}
    </div>
  );
}
