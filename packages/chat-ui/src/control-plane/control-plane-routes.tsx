import type { ReactNode } from "react";
import type { ChatShellAdminPanel } from "../chat-shell";
import { UserSettingsPanel } from "../user-settings-panel";
import type { ControlPlaneModel } from "./control-plane-model";

export function ControlPlaneRoutes({
  adminPanel,
  controlPlane,
  children
}: {
  adminPanel: ChatShellAdminPanel | undefined;
  controlPlane: ControlPlaneModel;
  children: ReactNode;
}) {
  const { settings, superadmin } = controlPlane;

  if (superadmin.shouldRender) {
    return <>{adminPanel?.renderPanel(superadmin.panelInput)}</>;
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
