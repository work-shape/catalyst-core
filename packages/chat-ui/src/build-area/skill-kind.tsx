import { BookOpen } from "lucide-react";
import { Badge, SkillIcon } from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";
import { useSettingsPage } from "../settings/settings-page-context";
import { skillConfigToForm, startedSkillForm } from "./asset-form-model";
import type { BuildAsset, BuildAssetEditorProps, BuildAssetKind } from "./build-asset-kind";
import { SkillEditor } from "./skill-editor";
import { skillFacts } from "./skill-facts";

/** The title of a skill that ships with the platform, read from its definition. */
function shippedSkillTitle(asset: Pick<BuildAsset, "config" | "name">): string | undefined {
  const { origin, title } = asset.config;
  if (origin !== "release") return undefined;
  return typeof title === "string" && title !== "" ? title : asset.name;
}

export const skillKind: BuildAssetKind = {
  kind: "skill",
  path: "skills",
  label: "build.kindSkills",
  searchLabel: "build.skillsSearch",
  newLabel: "configNewSkill",
  titleLabel: "configTitle",
  deleteTitle: "configDeleteSkillTitle",
  deleteDescription: "configDeleteSkillDescription",
  emptyText: "build.skillsEmpty",
  emptyReadOnlyText: "build.skillsEmptyReadOnly",
  missingText: "build.skillMissing",
  icon: BookOpen,
  // A row says what an agent with the skill knows how to do, and never shows the skill's id.
  row: (asset) => {
    const { icon, summary } = skillFacts(asset);
    return { leading: <SkillIcon icon={icon} size="lg" />, description: summary };
  },
  badges: (asset, t) =>
    asset.attributes?.origin === "release" ? (
      <Badge data-skill-origin="release">{t("build.platform")}</Badge>
    ) : null,
  shippedTitle: shippedSkillTitle,
  Editor: SkillAssetEditor
};

/** The skill form on the asset page. A copy starts from the shipped skill it copies. */
function SkillAssetEditor(frame: BuildAssetEditorProps) {
  const { config } = useSettingsPage();
  const { t } = useTranslation();
  const { asset, start } = frame;
  const initialForm = asset
    ? skillConfigToForm(asset.config)
    : start?.copyOf
      ? { ...skillConfigToForm(start.copyOf), name: start.name, title: start.title }
      : startedSkillForm(start ?? { name: "", title: "" });
  return (
    <SkillEditor
      frame={frame}
      initialForm={initialForm}
      editable={config.features.configAssets.allowSkillEditing}
      badges={
        asset && shippedSkillTitle(asset) !== undefined ? (
          <Badge data-skill-origin="release">{t("build.platform")}</Badge>
        ) : null
      }
    />
  );
}
