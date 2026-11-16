import type { LocaleCode } from "@work-shape/catalyst-api-client";
import type { TranslationContextValue } from "../../shared/i18n";
import type { AssetPlace } from "./asset-place";
import type { BuildAsset } from "./build-kind/asset";

/**
 * Why the reader cannot delete the asset now, or nothing where they can. Without the right the
 * reason says who may; a skill that agents still list names those the reader sees and counts
 * the others, as the instance refuses its delete until none does (SKILL-DEL-1).
 */
export function deleteBlockedReason(
  asset: BuildAsset,
  mayDelete: boolean,
  place: AssetPlace,
  t: TranslationContextValue["t"],
  locale: LocaleCode
): string | undefined {
  if (!mayDelete) {
    return asset.kind === "skill" && place.rung === "workspace"
      ? t("build.deleteNoRightWorkspaceSkill", { workspace: place.name })
      : t("build.deleteNoRight");
  }
  const unread = asset.listedByUnread ?? 0;
  const agents = [
    ...(asset.listedBy ?? []).map((agent) => agent.title),
    ...(unread === 0
      ? []
      : [
          unread === 1
            ? t("build.deleteListedByUnreadOne")
            : t("build.deleteListedByUnreadOther", { count: unread })
        ])
  ];
  if (agents.length === 0) return undefined;
  return t("build.deleteListedBy", {
    agents: new Intl.ListFormat(locale, { type: "conjunction" }).format(agents)
  });
}
