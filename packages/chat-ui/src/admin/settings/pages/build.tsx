import { BuildFrame } from "../../../studio/build-area/build-frame";
import { useBuildSource } from "../../../studio/build-area/build-data";
import { useSettingsPage } from "../../../shared/settings-page-context";

/** Build: the agents and skills the reader holds a right on, in the Build frame. */
export function BuildPage() {
  const { activeWorkspace } = useSettingsPage();
  return (
    <BuildFrame
      source={useBuildSource()}
      workspace={
        activeWorkspace?.kind === "shared"
          ? { id: activeWorkspace.id, name: activeWorkspace.name }
          : undefined
      }
    />
  );
}
