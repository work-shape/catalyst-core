import { BookOpen } from "lucide-react";
import { SkillIcon } from "@vivd-catalyst/ui";
import { useSettingsPage } from "../settings/settings-page-context";
import { skillConfigToForm, startedSkillForm } from "./asset-form-model";
import type { BuildAssetEditorProps, BuildAssetKind } from "./build-asset-kind";
import { SkillEditor } from "./skill-editor";
import { skillFacts } from "./skill-facts";

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
  Editor: SkillAssetEditor
};

/** The skill form on the asset page. */
function SkillAssetEditor(frame: BuildAssetEditorProps) {
  const { config } = useSettingsPage();
  const { asset, start } = frame;
  return (
    <SkillEditor
      frame={frame}
      initialForm={
        asset ? skillConfigToForm(asset.config) : startedSkillForm(start ?? { name: "", title: "" })
      }
      editable={config.features.configAssets.allowSkillEditing}
    />
  );
}
