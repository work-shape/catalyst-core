import type { ReactNode } from "react";
import type { ChatShellAdminPanel } from "../chat-shell";
import { UserSettingsPanel } from "./user-settings-panel";
import type { ControlPlaneModel } from "./control-plane-model";

export function ControlPlaneRoutes({
  adminPanel,
  controlPlane,
  approvalsView,
  children
}: {
  adminPanel: ChatShellAdminPanel | undefined;
  controlPlane: ControlPlaneModel;
  /**
   * The review queue, present while its route is active for a user who may
   * review. It is switched here like the other workspace views, but it is not
   * part of the administration panel and needs no administration access.
   */
  approvalsView?: ReactNode;
  children: ReactNode;
}) {
  const { settings, superadmin } = controlPlane;

  if (approvalsView) {
    return <>{approvalsView}</>;
  }

  if (superadmin.shouldRender) {
    const AdminPanel = adminPanel?.Panel;
    return AdminPanel ? <AdminPanel {...superadmin.panelInput} /> : null;
  }

  if (settings.shouldRender) {
    return (
      <UserSettingsPanel
        user={settings.user}
        canChangePassword={settings.canChangePassword}
        updatingProfile={settings.updatingProfile}
        changingPassword={settings.changingPassword}
        deletingAccount={settings.deletingAccount}
        locales={settings.locales}
        locale={settings.locale}
        showContextIndicator={settings.showContextIndicator}
        onUpdateProfile={settings.updateProfile}
        onChangePassword={settings.changePassword}
        onDeleteAccount={settings.deleteAccount}
        onSelectLocale={settings.selectLocale}
        onShowContextIndicatorChange={settings.setShowContextIndicator}
      />
    );
  }

  return <>{children}</>;
}
