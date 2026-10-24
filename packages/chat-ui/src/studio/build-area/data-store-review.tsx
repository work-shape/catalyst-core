import { useRef, useState, type FormEvent } from "react";
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  InlineError,
  Input,
  List,
  ListRow,
  LoadMore,
  type BadgeTone
} from "@work-shape/catalyst-ui";
import { KnowledgeCitationChip } from "../../chat/assistant/knowledge-citation-chip";
import { formatDate } from "../../shared/locale-format";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import { ReadState } from "./data-store-read-state";
import {
  groupFlagged,
  reviewValueOf,
  reviewValueText,
  type FieldReason,
  type ReviewDocument,
  type ReviewField,
  type ReviewObject
} from "./data-store-review-model";
import type {
  DataStoreDecision,
  DataStoreFlagged,
  DataStoreFlaggedItem,
  DataStoreRead,
  DataStoreReviewSource
} from "./data-store-source";

// "Prüfen" on a store's page: the fields of its records that the documents do not settle on
// their own, each object with its fields and each field with its candidates side by side, every
// one with the page it cites. A person confirms one, corrects it, or assigns a document whose
// object is not known. The decision stays through later syncs.

/** How many candidates the section reads at first, and how many more each "Show more" reads. */
export const REVIEW_PAGE = 200;

/** With this many flagged fields or fewer, every field shows its candidates without a click. */
const FIELDS_OPEN_AT_MOST = 6;

const REASON_VIEWS: Record<FieldReason, { label: TranslationKey; tone: BadgeTone }> = {
  conflict: { label: "dataStores.reviewReasonConflict", tone: "warning" },
  not_evidenced: { label: "dataStores.reviewReasonNotEvidenced", tone: "warning" },
  confirmation_required: { label: "dataStores.reviewReasonConfirmationRequired", tone: "info" }
};

/** The records rules of a definition: each table with the column its objects are keyed by. */
export function recordsKeyColumns(config: Record<string, unknown>): Map<string, string> {
  const rules = Array.isArray(config.records) ? config.records : [];
  const columns = new Map<string, string>();
  for (const rule of rules) {
    if (!isRecord(rule) || typeof rule.table !== "string" || !isRecord(rule.key)) continue;
    if (typeof rule.key.column === "string") columns.set(rule.table, rule.key.column);
  }
  return columns;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What one decision asks of the page: the dialog it opens, where it opens one. */
type Opened =
  | { kind: "correct"; field: string; candidate: DataStoreFlaggedItem }
  | { kind: "assign"; document: ReviewDocument };

/**
 * The section's body. The page reads what waits, as it counts the fields in its outline, and
 * hands the read here.
 */
export function DataStoreReview({
  store,
  read,
  review,
  keyColumns,
  showMore
}: {
  store: string;
  read: DataStoreRead<DataStoreFlagged>;
  review: DataStoreReviewSource;
  keyColumns: ReadonlyMap<string, string>;
  showMore(): void;
}) {
  const { t } = useTranslation();
  const [opened, setOpened] = useState<Opened | undefined>(undefined);
  // The candidate whose confirmation is on its way, and the sentence of one that was refused.
  const [pending, setPending] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const decide = async (decision: DataStoreDecision, id: string) => {
    setPending(id);
    setFailure(undefined);
    const refused = await review.decide(store, decision);
    setPending(undefined);
    if (refused !== undefined) setFailure(refused || t("dataStores.reviewDecideFailed"));
  };
  return (
    <ReadState
      read={read}
      failedText={t("dataStores.reviewFailed")}
      refusedText={t("dataStores.reviewRefused")}
      rows={3}
    >
      {(flagged, renewing) => {
        const groups = groupFlagged(flagged.items);
        if (groups.objects.length === 0 && groups.documents.length === 0) {
          return (
            <EmptyState layout="inline" data-data-store-review-empty="">
              {t("dataStores.reviewEmpty")}
            </EmptyState>
          );
        }
        const open = groups.fieldCount <= FIELDS_OPEN_AT_MOST;
        return (
          <div className="grid min-w-0 gap-5" data-data-store-review="">
            {failure ? <InlineError>{failure}</InlineError> : null}
            {groups.objects.map((object) => (
              <ReviewObjectGroup
                key={JSON.stringify([object.table, object.key])}
                object={object}
                open={open}
                pending={pending}
                confirm={(field, candidate) => {
                  decide(
                    {
                      table: object.table,
                      key: object.key,
                      field,
                      action: "confirm",
                      knowledgeBaseId: candidate.knowledgeBaseId,
                      documentId: candidate.documentId
                    },
                    candidateId(candidate)
                  ).catch(() => undefined);
                }}
                correct={(field, candidate) => setOpened({ kind: "correct", field, candidate })}
              />
            ))}
            {groups.documents.length > 0 ? (
              <ReviewDocuments
                documents={groups.documents}
                open={open}
                assign={(document) => setOpened({ kind: "assign", document })}
              />
            ) : null}
            {flagged.nextCursor ? (
              <LoadMore loading={renewing} label={t("dataStores.reviewMore")} onLoad={showMore} />
            ) : null}
            {opened?.kind === "correct" ? (
              <CorrectDialog
                field={opened.field}
                candidate={opened.candidate}
                onClose={() => setOpened(undefined)}
                decide={(decision) => review.decide(store, decision)}
              />
            ) : null}
            {opened?.kind === "assign" ? (
              <AssignDialog
                document={opened.document}
                keyColumn={keyColumns.get(opened.document.table)}
                onClose={() => setOpened(undefined)}
                decide={(decision) => review.decide(store, decision)}
              />
            ) : null}
          </div>
        );
      }}
    </ReadState>
  );
}

function candidateId(candidate: DataStoreFlaggedItem): string {
  return JSON.stringify([
    candidate.table,
    candidate.key,
    candidate.name,
    candidate.knowledgeBaseId,
    candidate.documentId
  ]);
}

/** One object: its table and key, then each flagged field with its candidates. */
function ReviewObjectGroup({
  object,
  open,
  pending,
  confirm,
  correct
}: {
  object: ReviewObject;
  open: boolean;
  pending: string | undefined;
  confirm(field: string, candidate: DataStoreFlaggedItem): void;
  correct(field: string, candidate: DataStoreFlaggedItem): void;
}) {
  const { locale, t } = useTranslation();
  const label = t("dataStores.reviewObject", {
    table: object.table,
    key: reviewValueText(object.key)
  });
  return (
    <div className="grid min-w-0 gap-2" data-review-object={reviewValueText(object.key)}>
      <h3 className="text-label font-medium text-foreground">{label}</h3>
      <List aria-label={label}>
        {object.fields.map((field) => (
          <ListRow
            key={field.name}
            data-review-field={field.name}
            expandable
            defaultExpanded={open}
            title={<code className="font-mono text-code">{field.name}</code>}
            description={field.candidates
              .map((candidate) => reviewValueText(candidate.value, locale))
              .join(" · ")}
            chips={
              <Badge tone={REASON_VIEWS[field.reason].tone} size="sm">
                {t(REASON_VIEWS[field.reason].label)}
              </Badge>
            }
          >
            <ReviewCandidates
              field={field}
              pending={pending}
              confirm={(candidate) => confirm(field.name, candidate)}
              correct={(candidate) => correct(field.name, candidate)}
            />
          </ListRow>
        ))}
      </List>
    </div>
  );
}

/** The candidates of one field side by side, each with what it says and the page it cites. */
function ReviewCandidates({
  field,
  pending,
  confirm,
  correct
}: {
  field: ReviewField;
  pending: string | undefined;
  confirm(candidate: DataStoreFlaggedItem): void;
  correct(candidate: DataStoreFlaggedItem): void;
}) {
  const { t } = useTranslation();
  return (
    <ul className="grid min-w-0 gap-3 sm:grid-cols-2" aria-label={t("dataStores.reviewCandidates")}>
      {field.candidates.map((candidate) => {
        const id = candidateId(candidate);
        return (
          <li
            key={id}
            className="grid min-w-0 content-start gap-2 rounded-md border p-3"
            data-review-candidate={candidate.documentId}
          >
            <CandidateEvidence candidate={candidate} />
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                loading={pending === id}
                disabled={pending !== undefined}
                data-review-confirm=""
                onClick={() => confirm(candidate)}
              >
                {t("dataStores.reviewConfirm")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending !== undefined}
                data-review-correct=""
                onClick={() => correct(candidate)}
              >
                {t("dataStores.reviewCorrect")}
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** What a candidate says, from which document and page, and whether its quote stands there. */
function CandidateEvidence({ candidate }: { candidate: DataStoreFlaggedItem }) {
  const { locale, t } = useTranslation();
  return (
    <>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="min-w-0 text-body font-medium break-words text-foreground">
          {reviewValueText(candidate.value, locale)}
        </span>
        {candidate.state === "confirmed" || candidate.state === "corrected" ? (
          <Badge tone="success" size="sm">
            {t(
              candidate.state === "confirmed"
                ? "dataStores.reviewConfirmed"
                : "dataStores.reviewCorrected"
            )}
          </Badge>
        ) : null}
        {candidate.evidence.status === "failed" ? (
          <Badge tone="warning" size="sm">
            {t("dataStores.reviewQuoteNotFound")}
          </Badge>
        ) : null}
      </div>
      <span className="text-caption text-muted-foreground">
        {candidate.documentDate
          ? t("dataStores.reviewKindOf", {
              kind: candidate.kind,
              date: formatDate(candidate.documentDate, locale)
            })
          : candidate.kind}
      </span>
      {candidate.quote ? (
        <blockquote className="min-w-0 border-l-2 pl-2 text-caption break-words text-muted-foreground">
          {t("dataStores.reviewQuote", { quote: candidate.quote })}
        </blockquote>
      ) : null}
      <div className="flex min-w-0">
        {candidate.document ? (
          <KnowledgeCitationChip
            citation={{
              knowledgeBase: candidate.document.knowledgeBase,
              documentId: candidate.documentId,
              fileName: candidate.document.fileName,
              page: candidate.page
            }}
          />
        ) : (
          <span className="text-caption text-muted-foreground">
            {t("dataStores.reviewDocumentGone")}
          </span>
        )}
      </div>
    </>
  );
}

/** The documents whose object is not known, each with its fields and "Assign object". */
function ReviewDocuments({
  documents,
  open,
  assign
}: {
  documents: readonly ReviewDocument[];
  open: boolean;
  assign(document: ReviewDocument): void;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid min-w-0 gap-2" data-review-unassigned="">
      <h3 className="text-label font-medium text-foreground">{t("dataStores.reviewUnassigned")}</h3>
      <p className="text-caption text-muted-foreground">
        {t("dataStores.reviewUnassignedDescription")}
      </p>
      <List aria-label={t("dataStores.reviewUnassigned")}>
        {documents.map((document) => (
          <ListRow
            key={JSON.stringify([document.table, document.knowledgeBaseId, document.documentId])}
            data-review-document={document.documentId}
            expandable
            defaultExpanded={open}
            title={document.fileName ?? t("dataStores.reviewDocumentGone")}
            description={document.fields.map((field) => field.name).join(", ")}
            chips={
              <Badge tone="warning" size="sm">
                {t("dataStores.reviewReasonKeyUnresolved")}
              </Badge>
            }
          >
            <div className="grid min-w-0 gap-3">
              <ul className="grid min-w-0 gap-3 sm:grid-cols-2">
                {document.fields.map((field) => (
                  <li
                    key={field.name}
                    className="grid min-w-0 content-start gap-2 rounded-md border p-3"
                  >
                    <code className="font-mono text-code">{field.name}</code>
                    <CandidateEvidence candidate={field} />
                  </li>
                ))}
              </ul>
              <div>
                <Button
                  size="sm"
                  variant="outline"
                  data-review-assign=""
                  onClick={() => assign(document)}
                >
                  {t("dataStores.reviewAssign")}
                </Button>
              </div>
            </div>
          </ListRow>
        ))}
      </List>
    </div>
  );
}

/**
 * Correcting one candidate: the value as the page says it, with the cited page and its quote
 * beside the field.
 */
function CorrectDialog({
  field,
  candidate,
  onClose,
  decide
}: {
  field: string;
  candidate: DataStoreFlaggedItem;
  onClose(): void;
  decide(decision: DataStoreDecision): Promise<string | undefined>;
}) {
  const { locale, t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(reviewValueText(candidate.value, locale, { grouping: false }));
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const read = reviewValueOf(text, candidate.value, locale);
    if ("invalid" in read) {
      setError(
        t(
          read.invalid === "number"
            ? "dataStores.reviewValueNumber"
            : read.invalid === "boolean"
              ? "dataStores.reviewValueBoolean"
              : "dataStores.reviewValueEmpty"
        )
      );
      return;
    }
    setSaving(true);
    const refused = await decide({
      table: candidate.table,
      key: candidate.key ?? "",
      field,
      action: "correct",
      value: read.value,
      knowledgeBaseId: candidate.knowledgeBaseId,
      documentId: candidate.documentId
    });
    setSaving(false);
    if (refused === undefined) onClose();
    else setError(refused || t("dataStores.reviewDecideFailed"));
  };
  return (
    <Dialog
      open
      size="md"
      title={t("dataStores.reviewCorrectTitle", { field })}
      description={t("dataStores.reviewCorrectDescription")}
      initialFocus={input}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" form="data-store-review-correct" loading={saving}>
            {t("dataStores.reviewCorrect")}
          </Button>
        </>
      }
    >
      <form
        id="data-store-review-correct"
        className="grid min-w-0 gap-4 sm:grid-cols-2"
        onSubmit={(event) => {
          submit(event).catch(() => undefined);
        }}
      >
        <div
          className="grid min-w-0 content-start gap-2 rounded-md border p-3"
          data-review-cited=""
        >
          <span className="text-caption font-medium text-muted-foreground">
            {t("dataStores.reviewCitedPage")}
          </span>
          <CandidateEvidence candidate={candidate} />
        </div>
        <Field
          label={t("dataStores.reviewValueLabel")}
          hint={t("dataStores.reviewValueHint")}
          error={error}
          required
        >
          <Input
            ref={input}
            value={text}
            data-review-value=""
            onChange={(event) => {
              setText(event.target.value);
              setError(undefined);
            }}
          />
        </Field>
      </form>
    </Dialog>
  );
}

/** Assigning a document whose object is not known: the key of the object it belongs to. */
function AssignDialog({
  document,
  keyColumn,
  onClose,
  decide
}: {
  document: ReviewDocument;
  keyColumn: string | undefined;
  onClose(): void;
  decide(decision: DataStoreDecision): Promise<string | undefined>;
}) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [first] = document.fields;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (key.trim() === "" || !first) {
      setError(t("dataStores.reviewKeyEmpty"));
      return;
    }
    setSaving(true);
    const refused = await decide({
      table: document.table,
      key: key.trim(),
      field: first.name,
      action: "assign",
      knowledgeBaseId: document.knowledgeBaseId,
      documentId: document.documentId
    });
    setSaving(false);
    if (refused === undefined) onClose();
    else setError(refused || t("dataStores.reviewDecideFailed"));
  };
  return (
    <Dialog
      open
      size="sm"
      title={t("dataStores.reviewAssignTitle", {
        file: document.fileName ?? document.documentId
      })}
      description={t("dataStores.reviewAssignDescription")}
      initialFocus={input}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" form="data-store-review-assign" loading={saving}>
            {t("dataStores.reviewAssignSubmit")}
          </Button>
        </>
      }
    >
      <form
        id="data-store-review-assign"
        className="grid gap-3"
        onSubmit={(event) => {
          submit(event).catch(() => undefined);
        }}
      >
        <Field
          label={t("dataStores.reviewKeyLabel")}
          hint={
            keyColumn
              ? t("dataStores.reviewKeyHint", { column: keyColumn, table: document.table })
              : undefined
          }
          error={error}
          required
        >
          <Input
            ref={input}
            value={key}
            data-review-key=""
            onChange={(event) => {
              setKey(event.target.value);
              setError(undefined);
            }}
          />
        </Field>
      </form>
    </Dialog>
  );
}
