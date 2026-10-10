import type { ReactNode } from "react";
import { BuildArea, SettingsArea } from "../settings/settings-area";
import type { ControlPlaneModel } from "./control-plane-model";

/** Shows the full-page area of the open route in place of the conversation. */
export function ControlPlaneRoutes({
  controlPlane,
  inboxArea,
  children
}: {
  controlPlane: ControlPlaneModel;
  /**
   * The Inbox, present while its route is open. It is switched here like the other full-page
   * areas, but it is not part of the administration and needs no administration access.
   */
  inboxArea?: ReactNode;
  children: ReactNode;
}) {
  const { settings, build } = controlPlane;

  if (inboxArea) {
    return <>{inboxArea}</>;
  }

  if (build) {
    return <BuildArea build={build} />;
  }

  if (settings) {
    return <SettingsArea settings={settings} />;
  }

  return <>{children}</>;
}
