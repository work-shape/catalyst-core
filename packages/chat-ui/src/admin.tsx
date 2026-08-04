import type { ChatShellAdminPanel } from "./chat-shell";
import { canViewAdministrationPanel } from "./control-plane/governance";
import { SuperadminPanel } from "./control-plane/superadmin-panel";

export {
  canEditConfigAssets,
  canManageApiAccess,
  canManageUsers,
  canViewAudit,
  canViewAdministrationPanel,
  canViewSuperadminPanel,
  canViewUsageGovernance
} from "./control-plane/governance";
export { SuperadminPanel } from "./control-plane/superadmin-panel";

export const superadminPanel: ChatShellAdminPanel = {
  canView: canViewAdministrationPanel,
  renderPanel: (props) => <SuperadminPanel {...props} />
};
