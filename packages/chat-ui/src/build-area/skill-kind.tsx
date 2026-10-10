import { BookOpen } from "lucide-react";
import { listAll } from "@vivd-catalyst/api-client";
import { useConfigAssetMutations } from "../api/workspace-mutations";
import { RevisionHistory, SkillEditor } from "../control-plane/config-asset-editors";
import {
  emptySkillForm,
  skillConfigToForm,
  skillFormToConfig
} from "../control-plane/config-assets-model";
import { useSettingsPage } from "../settings/settings-page-context";
import type { BuildAssetEditorProps, BuildAssetKind } from "./build-asset-kind";
import { useConfigAssetsData } from "./build-data";

export const skillKind: BuildAssetKind = {
  kind: "skill",
  path: "skills",
  label: "build.kindSkills",
  searchLabel: "build.skillsSearch",
  newLabel: "configNewSkill",
  emptyText: "build.skillsEmpty",
  emptyReadOnlyText: "build.skillsEmptyReadOnly",
  missingText: "build.skillMissing",
  icon: BookOpen,
  title: (asset) => (typeof asset.config.title === "string" ? asset.config.title : undefined),
  Editor: SkillAssetEditor
};

/** Today's skill form on the asset page, with the changes it can make. */
function SkillAssetEditor({
  asset,
  back,
  onUnsavedChange,
  run,
  onCreated,
  onDeleted,
  onReloaded
}: BuildAssetEditorProps) {
  const { apiBaseUrl, authScope, client, config } = useSettingsPage();
  const editable = config.features.configAssets.allowSkillEditing;
  const data = useConfigAssetsData();
  const mutations = useConfigAssetMutations({ apiBaseUrl, authScope, client });
  const version = data.overview?.version;

  return (
    <SkillEditor
      back={back}
      onUnsavedChange={onUnsavedChange}
      initialForm={asset ? skillConfigToForm(asset.config) : emptySkillForm()}
      isNew={asset === undefined}
      editable={editable}
      mutating={mutations.isPending}
      onSave={(form) =>
        run(() =>
          mutations.putAsset
            .mutateAsync({
              kind: "skill",
              name: form.name.trim(),
              config: skillFormToConfig(form),
              baseVersion: version
            })
            .then(() => {
              if (!asset) {
                onCreated(form.name.trim());
              }
            })
        )
      }
      onDelete={
        asset && editable
          ? () =>
              run(() =>
                mutations.deleteAsset
                  .mutateAsync({ kind: "skill", name: asset.name, baseVersion: version })
                  .then(onDeleted)
              )
          : undefined
      }
      revisions={
        asset ? (
          <RevisionHistory
            kind="skill"
            name={asset.name}
            mutating={mutations.isPending}
            onLoadRevisions={(kind, name) =>
              listAll((paging) =>
                client.config_assets.revisions.list({ params: { kind, name }, query: paging })
              )
            }
            onRevert={
              editable
                ? (revision) =>
                    run(() =>
                      mutations.revertAsset
                        .mutateAsync({
                          kind: "skill",
                          name: asset.name,
                          revision,
                          baseVersion: version
                        })
                        .then(onReloaded)
                    )
                : undefined
            }
          />
        ) : null
      }
    />
  );
}
