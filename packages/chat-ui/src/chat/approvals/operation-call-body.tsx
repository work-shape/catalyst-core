import type { ReactNode } from "react";
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
import {
  dataStoreRowChange,
  rowChangeInputs,
  rowChangeSummary,
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
import { SkillChangeBody } from "./skill-change-body";
import { parseSkillChangePreview } from "./skill-change-preview";

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
  tone: OutcomeTone;
  reason?: string;
}

/**
 * What the item says became of a call once its request ended. A confirmation also says that it
 * was denied, and that Stop withdrew it before anyone decided; the reason a person gave for a
 * denial stands under the decision.
 */
function shownOutcome(
  request: Pick<ApprovalRequestView, "status" | "applyResult">,
  confirmation: boolean
): ShownOutcome | undefined {
  if (confirmation && request.status === "rejected") {
    return { outcome: "denied", label: "operations.confirmOutcomeDenied", tone: "info" };
  }
  if (confirmation && request.status === "withdrawn") {
    return { outcome: "withdrawn", label: "operations.confirmOutcomeWithdrawn", tone: "info" };
  }
  const ended = operationCallOutcome(request);
  if (!ended) return undefined;
  const words = (confirmation ? CONFIRMATION_OUTCOME : OUTCOME)[ended.outcome];
  return { outcome: ended.outcome, ...words, ...(ended.reason ? { reason: ended.reason } : {}) };
}

/** How a sentence names the kind of an asset. A kind without words of its own is "the asset". */
const ASSET_KIND_PHRASE: Record<string, TranslationKey> = {
  skill: "operations.callAssetKindSkill",
  agent: "operations.callAssetKindAgent",
  connection: "operations.callAssetKindConnection"
};

/** The sentence that says who wants what, by whether the asset is new and has a Namespace. */
function assetSentenceKey(asset: OperationCallAsset): TranslationKey {
  if (asset.isNew) {
    return asset.namespace ? "operations.callAssetCreateIn" : "operations.callAssetCreate";
  }
  return asset.namespace ? "operations.callAssetChangeIn" : "operations.callAssetChange";
}

/** What approving and declining do: said of the skill, of another asset, or of the call. */
function effectKey(asset: OperationCallAsset | undefined): TranslationKey {
  if (!asset) return "operations.callEffect";
  if (asset.kind !== SKILL_ASSET_KIND) return "operations.callAssetEffect";
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
  const { locale, t } = useTranslation();
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
  const outcome = pending ? undefined : shownOutcome(request, confirmation);
  const { asset } = call;
  const actor = call.actor.label;
  // The skill's own view needs a text the server could read; without one the input shows.
  const skill = asset?.kind === SKILL_ASSET_KIND && asset.content !== undefined ? asset : undefined;
  const hiddenFields = call.inputFieldCount - call.inputs.length;
  // A row write is read from the input the request froze, which it keeps only while it waits.
  const rowChange = pending
    ? dataStoreRowChange(
        call.operation,
        operationCallFrozenInput(request.payload),
        call.targetTitle
      )
    : undefined;
  const summary = rowChange ? rowChangeSummary(rowChange, t, locale) : undefined;

  // A publish that waits shows what it makes live, and the call itself only in the fold.
  const review = pending ? call.review : undefined;
  const technical = (
    <TechnicalDetailsContent
      call={call}
      pending={pending}
      showsOperation={skill !== undefined || review !== undefined || rowChange !== undefined}
      fullInput={operationCallFullInput(request.payload)}
    />
  );
  // A publish that leads with its sentence has one fold, "Details", and the call goes in it.
  const merged = review?.narrative !== undefined;

  return (
    <div className="grid min-w-0 gap-4" data-testid="operation-call" data-run-id={call.runId}>
      {confirmation && pending ? <ConfirmationLead call={call} summary={summary} /> : null}
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
                  title: asset.title,
                  namespace: asset.namespace ?? ""
                })
              : t(
                  call.effect === "changing"
                    ? "operations.callHeadlineChanging"
                    : "operations.callHeadlineReading",
                  { actor }
                )}
          </p>
          {summary ? (
            <p className="text-foreground wrap-anywhere" data-testid="operation-call-summary">
              {summary}
            </p>
          ) : null}
          <p className="text-caption text-muted-foreground">{t(effectKey(asset), { actor })}</p>
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
      {outcome ? (
        <Banner
          tone={outcome.tone}
          data-testid="operation-call-outcome"
          data-outcome={outcome.outcome}
        >
          {t(outcome.label)}
          {outcome.reason ? (
            <span className="block text-caption">
              {t("operations.callOutcomeReason", { reason: outcome.reason })}
            </span>
          ) : null}
        </Banner>
      ) : null}
      {review ? null : skill ? (
        <SkillAsset asset={skill} />
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

/** A saved skill as people read one: what else changes about it, then its text. */
function SkillAsset({ asset }: { asset: OperationCallAsset }) {
  const { t } = useTranslation();
  const { previous, removedResources } = asset;
  const hasText = parseSkillChangePreview(asset.content) !== undefined;
  return (
    <section className="grid min-w-0 gap-3" data-testid="operation-call-skill">
      {asset.beforeWithheld ? (
        <Banner layout="line" tone="warning" role="note" data-testid="operation-call-no-before">
          {t("operations.callSkillBeforeWithheld")}
        </Banner>
      ) : null}
      {previous.title || previous.description || removedResources.length > 0 ? (
        <KeyValueList layout="stacked" data-testid="operation-call-skill-fields">
          {previous.title ? (
            <KeyValue label={t("operations.callSkillTitle")} data-field="title">
              <BeforeAndNow before={previous.title} now={asset.title} />
            </KeyValue>
          ) : null}
          {previous.description ? (
            <KeyValue label={t("operations.callSkillDescription")} data-field="description">
              <BeforeAndNow before={previous.description} now={asset.description} />
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
        <SkillChangeBody preview={asset.content} heading={false} expanded />
      ) : (
        <p className="text-muted-foreground" data-testid="operation-call-skill-same-text">
          {t("operations.callSkillSameText")}
        </p>
      )}
    </section>
  );
}

function BeforeAndNow({ before, now }: { before: string; now: string | undefined }) {
  const { t } = useTranslation();
  return (
    <>
      <span className="block text-muted-foreground">
        {t("skillChangeBefore")}: {before}
      </span>
      {now === undefined ? null : (
        <span className="block">
          {t("skillChangeAfter")}: {now}
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

/** The table of a Data Store write, then every row of it, a block per key and per values. */
export function RowChangeInputs({ change }: { change: DataStoreRowChange }) {
  const { t } = useTranslation();
  const inputs = rowChangeInputs(change, t);
  return (
    <div className="grid min-w-0 gap-3" data-testid="row-change-inputs" data-verb={change.verb}>
      <KeyValueList>
        <KeyValue label={t("operations.rowTable")} data-field="table">
          <span className="font-mono text-code wrap-anywhere">{change.table}</span>
        </KeyValue>
      </KeyValueList>
      <CallInputs
        call={{ inputs, inputFieldCount: inputs.length, inputRemoved: false }}
        hiddenFields={0}
      />
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
