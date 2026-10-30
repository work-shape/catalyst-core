import type { ApprovalRequestView, WorkspaceBundle } from "@work-shape/catalyst-api-client";
import {
  GRANT_REQUEST_STALE_REASONS,
  type GrantRequestStaleReason as StaleReason
} from "@work-shape/catalyst-core";
import { Banner, KeyValue, KeyValueList } from "@work-shape/catalyst-ui";
import {
  useTranslation,
  type TranslationContextValue,
  type TranslationKey
} from "../../shared/i18n";
import { personName } from "../../shared/person-name";

type Translate = TranslationContextValue["t"];

// `grant_request` (AP-3): an Owner or Admin of a workspace, or a member for themselves, asks
// for Builder or Publisher there. An instance admin who holds the bundle grants or declines it;
// nothing changes before. The server files it with this preview; the item shows nothing else.

interface GrantRequestPreview {
  workspace: { id: string; name: string };
  member: { id: string; label: string };
  bundle: WorkspaceBundle;
  reason?: string;
  stale?: StaleReason;
}

const bundleLabels: Record<WorkspaceBundle, TranslationKey> = {
  builder: "rights.actionBuilder",
  publisher: "rights.actionPublisher"
};

const bundleAllows: Record<WorkspaceBundle, TranslationKey> = {
  builder: "access.actionBuilderDescription",
  publisher: "access.actionPublisherDescription"
};

const staleSentences: Record<StaleReason, TranslationKey> = {
  member_left: "inbox.grantRequestMemberLeft",
  member_inactive: "inbox.grantRequestMemberInactive",
  already_held: "inbox.grantRequestAlreadyHeld"
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function staleReason(value: unknown): StaleReason | undefined {
  return GRANT_REQUEST_STALE_REASONS.find((reason) => reason === value);
}

/** The request of an item's preview, or nothing where the preview is not one. */
function parseGrantRequestPreview(preview: unknown): GrantRequestPreview | undefined {
  if (!isRecord(preview) || !isRecord(preview.workspace) || !isRecord(preview.member))
    return undefined;
  const { workspace, member } = preview;
  const bundle =
    preview.bundle === "builder" || preview.bundle === "publisher" ? preview.bundle : undefined;
  if (
    bundle === undefined ||
    typeof workspace.id !== "string" ||
    typeof workspace.name !== "string" ||
    typeof member.id !== "string" ||
    typeof member.label !== "string"
  )
    return undefined;
  const stale = staleReason(preview.stale);
  return {
    workspace: { id: workspace.id, name: workspace.name },
    member: { id: member.id, label: member.label },
    bundle,
    ...(typeof preview.reason === "string" && preview.reason.trim()
      ? { reason: preview.reason }
      : {}),
    ...(stale ? { stale } : {})
  };
}

/** Why the request no longer gives anything: while it waits, or the reason it ended with. */
function whyNoChange(item: ApprovalRequestView, preview: GrantRequestPreview) {
  if (item.status === "pending") return preview.stale;
  return item.status === "superseded" ? staleReason(item.applyResult?.reason) : undefined;
}

function sentenceValues(preview: GrantRequestPreview, t: Translate) {
  return {
    member: personName(preview.member.label, t),
    workspace: preview.workspace.name,
    bundle: t(bundleLabels[preview.bundle])
  };
}

/** "Kai asks for Builder for Lena in Sales", or "Lena asks for Builder in Sales" for herself. */
export function grantRequestHeading(item: ApprovalRequestView, t: Translate): string | undefined {
  const preview = parseGrantRequestPreview(item.preview);
  if (!preview) return undefined;
  const values = sentenceValues(preview, t);
  return item.requestedBy.id === preview.member.id
    ? t("inbox.grantRequestHeadingSelf", values)
    : t("inbox.grantRequestHeading", {
        ...values,
        actor: personName(item.requestedBy.displayLabel, t)
      });
}

/** The workspace the request is about, for the surface subtitle. */
export function grantRequestSubject(item: ApprovalRequestView): string | undefined {
  return parseGrantRequestPreview(item.preview)?.workspace.name;
}

/** Whether granting would still give something: only then is Grant offered. */
export function grantRequestAcceptable(item: ApprovalRequestView): boolean {
  const preview = parseGrantRequestPreview(item.preview);
  return preview !== undefined && preview.stale === undefined;
}

/** The middle of the item: who, where, which right and what it allows, and why it was asked. */
export function GrantRequestBody({ item }: { item: ApprovalRequestView }) {
  const { t } = useTranslation();
  const preview = parseGrantRequestPreview(item.preview);
  if (!preview) return null;
  const values = sentenceValues(preview, t);
  const noChange = whyNoChange(item, preview);
  return (
    <div className="grid min-w-0 gap-4" data-testid="inbox-grant-request">
      {noChange ? (
        <Banner tone="warning" role="note" data-grant-request-stale="">
          {t(staleSentences[noChange], values)}
        </Banner>
      ) : null}
      <KeyValueList>
        <KeyValue label={t("inbox.grantRequestWorkspace")}>{preview.workspace.name}</KeyValue>
        <KeyValue label={t("inbox.grantRequestMember")}>{values.member}</KeyValue>
        <KeyValue label={t("inbox.grantRequestRight")}>{values.bundle}</KeyValue>
        <KeyValue label={t("inbox.grantRequestAllows")}>{t(bundleAllows[preview.bundle])}</KeyValue>
        {preview.reason ? (
          <KeyValue label={t("inbox.grantRequestReason")} foldable>
            <span className="whitespace-pre-wrap break-words">{preview.reason}</span>
          </KeyValue>
        ) : null}
      </KeyValueList>
      {item.status === "pending" && !noChange ? (
        <p className="text-sm text-muted-foreground">{t("inbox.grantRequestWaits")}</p>
      ) : null}
    </div>
  );
}
