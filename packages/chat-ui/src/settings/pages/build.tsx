import { BuildFrame } from "../../build-area/build-frame";
import { useBuildSource } from "../../build-area/build-data";
import { useSettingsPage } from "../settings-page-context";

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
