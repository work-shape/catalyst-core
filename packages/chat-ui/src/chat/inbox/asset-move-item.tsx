import { checkAssetMoveResponseSchema } from "@work-shape/catalyst-api-client";
import type { ApprovalRequestView } from "@work-shape/catalyst-api-client";
import { Banner } from "@work-shape/catalyst-ui";
import { useTranslation, type TranslationContextValue } from "../../shared/i18n";
import { personName } from "../../shared/person-name";
import { AssetShareSummary } from "../../studio/build-area/asset-share-dialog";
import type { AssetShareCheck } from "../../studio/build-area/asset-share-model";

type Translate = TranslationContextValue["t"];

// "Teilen mit…" (SHARE-1): a person asks to share an asset up the ladder where they lack the
// right at the target. Whoever holds it reads the same summary the dialog showed and accepts
// or declines. The request is `<kind>_move`, one per kind a workspace can own.

/** The kinds a workspace can own, whose requests to move up the Inbox shows. */
export const MOVABLE_KINDS = [
  "agent",
  "skill",
  "guardrail",
  "workflow",
  "data_store",
  "knowledge_base",
  "app"
] as const;

/** What a request's preview says: the planned move, or why it no longer moves anything. */
interface AssetMovePreview {
  check?: AssetShareCheck;
  /** The instance's sentence on why the move is no longer what was asked. */
  stale?: string;
  name: string;
}

function parseAssetMovePreview(preview: unknown): AssetMovePreview | undefined {
  const parsed = checkAssetMoveResponseSchema.safeParse(preview);
  if (parsed.success) return { check: parsed.data, name: parsed.data.asset.name };
  if (typeof preview !== "object" || preview === null) return undefined;
  const asset: unknown = Reflect.get(preview, "asset");
  const name = typeof asset === "object" && asset !== null ? Reflect.get(asset, "name") : undefined;
  if (typeof name !== "string") return undefined;
  const stale: unknown = Reflect.get(preview, "stale");
  return { name, ...(typeof stale === "string" ? { stale } : {}) };
}

/** The sentence a request that ended without a move was closed with, where it has one. */
function endedReason(item: ApprovalRequestView): string | undefined {
  const message = item.applyResult?.message;
  return typeof message === "string" && message.trim() ? message : undefined;
}

function movedTitle(preview: AssetMovePreview): string {
  return preview.check?.moves[0]?.title || preview.name;
}

/** Where the request asks the asset to go: a team by its name, or everyone. */
function moveTarget(
  item: ApprovalRequestView,
  preview: AssetMovePreview | undefined
): { team?: string } | undefined {
  const owner = preview?.check?.afterwards.owner;
  if (owner) return owner.kind === "instance" ? {} : { team: owner.workspaceName ?? "" };
  const to: unknown = item.payload.to;
  const kind = typeof to === "object" && to !== null ? Reflect.get(to, "kind") : undefined;
  return kind === "instance" ? {} : undefined;
}

/** Who asks to share what with whom, as the item's heading and title say it. */
export function assetMoveHeading(item: ApprovalRequestView, t: Translate): string | undefined {
  const preview = parseAssetMovePreview(item.preview);
  if (!preview) return undefined;
  const actor = personName(item.requestedBy.displayLabel, t);
  const title = movedTitle(preview);
  const target = moveTarget(item, preview);
  if (target === undefined) return t("inbox.kindAssetMove");
  return target.team
    ? t("inbox.moveHeadingTeam", { actor, title, team: target.team })
    : t("inbox.moveHeadingAll", { actor, title });
}

/** The asset the request moves, by its title. */
export function assetMoveSubject(item: ApprovalRequestView): string | undefined {
  const preview = parseAssetMovePreview(item.preview);
  return preview ? movedTitle(preview) : undefined;
}

/** Whether the request still moves what was asked: only then may it be accepted. */
export function assetMoveAcceptable(item: ApprovalRequestView): boolean {
  const preview = parseAssetMovePreview(item.preview);
  return preview?.check !== undefined && preview.stale === undefined;
}

/** The middle of the item: the plain reason a request ended, then what the move does. */
export function AssetMoveBody({ item }: { item: ApprovalRequestView }) {
  const { t } = useTranslation();
  const preview = parseAssetMovePreview(item.preview);
  const ended =
    item.status === "superseded" ? (endedReason(item) ?? t("inbox.moveEnded")) : undefined;
  const stale = item.status === "pending" ? preview?.stale : undefined;
  return (
    <div className="grid min-w-0 gap-4" data-asset-move="">
      {ended === undefined ? null : (
        <Banner tone="warning" role="note" data-asset-move-ended="">
          {ended}
        </Banner>
      )}
      {stale === undefined ? null : (
        <Banner tone="warning" role="note" data-asset-move-stale="">
          {stale}
        </Banner>
      )}
      {preview?.check && ended === undefined ? (
        <AssetShareSummary check={preview.check} forCaller={false} />
      ) : null}
    </div>
  );
}
