import type { ReactNode } from "react";
import { BuildArea, SettingsArea } from "../settings/settings-area";
import type { ControlPlaneModel } from "./control-plane-model";

/** Shows the full-page area of the open route in place of the conversation. */
export function ControlPlaneRoutes({
  controlPlane,
  approvalsView,
  children
}: {
  controlPlane: ControlPlaneModel;
  /**
   * The review queue, present while its route is active for a user who may
   * review. It is switched here like the other workspace views, but it is not
   * part of the administration and needs no administration access.
   */
  approvalsView?: ReactNode;
  children: ReactNode;
}) {
  const { settings, build } = controlPlane;

  if (approvalsView) {
    return <>{approvalsView}</>;
  }

  if (build) {
    return <BuildArea build={build} />;
  }

  if (settings) {
    return <SettingsArea settings={settings} />;
  }

  return <>{children}</>;
}
