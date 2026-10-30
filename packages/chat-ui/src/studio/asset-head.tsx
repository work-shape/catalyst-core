import type { ReactNode } from "react";
import { Button, StatusPill } from "@work-shape/catalyst-ui";
import { useTranslation, type TranslationContextValue } from "../shared/i18n";

// The head of an asset's page, the same for Agents, Apps, Workflows and Skills: the name, one
// state after it, and one muted line of facts under it. The state is said once: a draft that
// differs from live is "Draft · not live", whose popover names the draft and the live version;
// without a draft the head says "Live" quietly, or nothing.

type Translate = TranslationContextValue["t"];

/** The draft a head names, as far as the page knows it. */
export interface HeadDraft {
  /** The draft's revision; absent where people read versions only of what was published. */
  revision?: number | undefined;
  /** Who saved it last, as people read the name. */
  author?: string | undefined;
  /** When it was saved last, in the reader's words. */
  time?: string | undefined;
  /**
   * The live version, or `null` where nothing is published yet. `undefined`: something is live
   * whose version the page does not know.
   */
  live: number | null | undefined;
}

/** The sentence of the state's popover: which draft, by whom and when, and what is live. */
function headDraftSentence(draft: HeadDraft, t: Translate): string {
  const named = draft.author !== undefined && draft.time !== undefined;
  if (draft.revision === undefined) {
    return draft.live === null
      ? t("build.headDraftNever")
      : draft.live === undefined
        ? t("build.headDraftAheadPlain")
        : t("build.headDraftAhead", { live: draft.live });
  }
  if (draft.live === null || draft.live === undefined) {
    return named
      ? t("build.headDraftByNever", {
          revision: draft.revision,
          author: draft.author ?? "",
          time: draft.time ?? ""
        })
      : t("build.headDraftOfNever", { revision: draft.revision });
  }
  return named
    ? t("build.headDraftBy", {
        revision: draft.revision,
        author: draft.author ?? "",
        time: draft.time ?? "",
        live: draft.live
      })
    : t("build.headDraftOf", { revision: draft.revision, live: draft.live });
}

/**
 * The one state after an asset's name. A draft that differs from live: "Draft · not live",
 * whose popover names it and offers its changes. No draft: a quiet "Live" where something is
 * published, nothing otherwise.
 */
export function AssetStatus({
  draft,
  published,
  more,
  onShowChanges
}: {
  /** The draft that differs from live, or none. */
  draft: HeadDraft | undefined;
  /** Something of the asset is live. */
  published: boolean;
  /** What the popover says after its sentence, such as the right a publish needs. */
  more?: ReactNode;
  /** Shows what the draft changes; without it the popover offers no way there. */
  onShowChanges?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  if (draft === undefined) {
    return published ? (
      <StatusPill tone="live" label={t("build.headLive")} data-asset-status="live" />
    ) : null;
  }
  return (
    <StatusPill
      tone="draft"
      label={t("build.headDraft")}
      data-asset-status="draft"
      data-draft-revision={draft.revision}
      details={(close) => (
        <>
          <p data-asset-status-sentence="">{headDraftSentence(draft, t)}</p>
          {more}
          {onShowChanges === undefined ? null : (
            <div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  close();
                  onShowChanges();
                }}
              >
                {t("build.headShowChanges")}
              </Button>
            </div>
          )}
        </>
      )}
    />
  );
}

/** The muted line under an asset's name: its facts, each said once, joined by " · ". */
export function headFacts(parts: readonly (string | undefined | false | null)[]): string {
  return parts
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(" · ");
}
