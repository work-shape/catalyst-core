import type { ReactNode } from "react";
import { BuildArea, SettingsArea } from "../settings/settings-area";
import type { ControlPlaneModel } from "./control-plane-model";

/** Shows the full-page area of the open route in place of the conversation. */
export function ControlPlaneRoutes({
  controlPlane,
  inboxArea,
  agentsArea,
  appsArea,
  workflowsArea,
  scheduledArea,
  children
}: {
  controlPlane: ControlPlaneModel;
  /**
   * The Inbox, present while its route is open. It is switched here like the other full-page
   * areas, but it is not part of the administration and needs no administration access.
   */
  inboxArea?: ReactNode;
  /** The Agents page, present while its route is open. */
  agentsArea?: ReactNode;
  /** The Apps area, present while one of its routes is open and the module is on. */
  appsArea?: ReactNode;
  /** The Workflows area, present while one of its routes is open. */
  workflowsArea?: ReactNode;
  /** The Scheduled page, present while its route is open. */
  scheduledArea?: ReactNode;
  /** What shows where no area is open. */
  children?: ReactNode;
}) {
  const { settings, build } = controlPlane;

  if (inboxArea) {
    return <>{inboxArea}</>;
  }

  if (agentsArea) {
    return <>{agentsArea}</>;
  }

  if (appsArea) {
    return <>{appsArea}</>;
  }

  if (workflowsArea) {
    return <>{workflowsArea}</>;
  }

  if (scheduledArea) {
    return <>{scheduledArea}</>;
  }

  if (build) {
    return <BuildArea build={build} />;
  }

  if (settings) {
    return <SettingsArea settings={settings} />;
  }

  return <>{children}</>;
}
